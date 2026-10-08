import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import { InstanceLock } from "../../install/core/instance-lock.js";
import { inspectPathState } from "../../install/core/tree-state.js";
import type {
  SaveBackupRecord,
  SaveContext,
  SaveOperationRecord,
  SaveRestorePlan,
} from "../contracts.js";
import { saveOperationRecordSchema } from "../contracts.js";
import {
  assertNoSaveReparsePointTraversal,
  resolveSaveTarget,
} from "../path-policy.js";
import type { SaveContextStore } from "../storage/context-store.js";
import { ensureRealStoreDirectory } from "../storage/json-store.js";
import type { SaveBackupService } from "../backup/save-backup-service.js";
import { SaveOperationRecordStore } from "./save-operation-record-store.js";
import { SaveRestorePlanStore } from "./save-restore-plan-store.js";
import {
  SaveTransactionStore,
  type SaveTransactionWriter,
} from "./save-transaction-store.js";
import {
  createPlanReview,
  type PlanReviewMode,
} from "../../plan-review.js";

export type SaveRestoreCheckpoint =
  | "after_journal_created"
  | "after_lock_acquired"
  | "before_rescue_backup"
  | "after_rescue_backup"
  | "before_staging"
  | "after_staging"
  | "before_target_write"
  | "after_target_write"
  | "before_static_verify"
  | "after_static_verify"
  | "before_record_commit"
  | "after_record_commit";

export interface SaveRestoreFaultInjector {
  checkpoint(
    checkpoint: SaveRestoreCheckpoint,
    context: {
      restorePlanId: string;
      transactionId: string;
      operationId?: string;
    },
  ): Promise<void>;
}

export interface SaveRestoreServiceOptions {
  managerRoot: string;
  contexts: SaveContextStore;
  backups: SaveBackupService;
  planTtlMs?: number;
  faultInjector?: SaveRestoreFaultInjector;
}

export interface AppliedSaveRestore {
  plan: Readonly<SaveRestorePlan>;
  record: Readonly<SaveOperationRecord>;
  targetAbsolutePath: string;
  idempotentReplay: boolean;
}

type SavePathState = SaveRestorePlan["operations"][number]["expectedPreState"];

interface AppliedMutation {
  targetAbsolutePath: string;
  rollbackAbsolutePath: string | null;
  createdParentDirectories: string[];
}

function comparableState(state: Awaited<ReturnType<typeof inspectPathState>>): SavePathState {
  if (state.kind === "directory") {
    if (state.treeHash === null) {
      throw new NexusError(
        "SAVE_STATIC_VERIFICATION_FAILED",
        "A managed save directory could not be hashed.",
      );
    }
    return { kind: "directory", treeHash: state.treeHash };
  }
  return state;
}

function statesEqual(left: SavePathState, right: SavePathState): boolean {
  return sha256CanonicalJson(left) === sha256CanonicalJson(right);
}

function stateHash(
  target: SaveRestorePlan["target"],
  operations: SaveRestorePlan["operations"],
  preservedPaths?: SaveRestorePlan["preservedPaths"],
): string {
  return sha256CanonicalJson({
    target,
    states: operations.map((operation) => ({
      operationId: operation.operationId,
      rootId: operation.rootId,
      targetRelativePath: operation.targetRelativePath,
      expectedPreState: operation.expectedPreState,
    })),
    ...(preservedPaths === undefined ? {} : { preservedPaths }),
  });
}

function sameAbsolutePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function createMissingParentDirectories(
  root: string,
  target: string,
): Promise<string[]> {
  const result: string[] = [];
  let current = path.dirname(target);
  while (!sameAbsolutePath(current, root)) {
    const state = comparableState(await inspectPathState(current));
    if (state.kind !== "absent") break;
    result.push(current);
    const parent = path.dirname(current);
    if (sameAbsolutePath(parent, current)) break;
    current = parent;
  }
  await mkdir(path.dirname(target), { recursive: true });
  return result;
}

async function removeEmptyParents(directories: ReadonlyArray<string>): Promise<void> {
  for (const directory of directories) {
    await rmdir(directory).catch((error: unknown) => {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String(error.code))
      ) {
        throw error;
      }
    });
  }
}

export class SaveRestoreService {
  readonly #managerRoot: string;
  readonly #contexts: SaveContextStore;
  readonly #backups: SaveBackupService;
  readonly #plans: SaveRestorePlanStore;
  readonly #transactions: SaveTransactionStore;
  readonly #records: SaveOperationRecordStore;
  readonly #locksRoot: string;
  readonly #stagingRoot: string;
  readonly #sandboxesRoot: string;
  readonly #faultInjector: SaveRestoreFaultInjector | undefined;

  private constructor(input: {
    managerRoot: string;
    contexts: SaveContextStore;
    backups: SaveBackupService;
    plans: SaveRestorePlanStore;
    transactions: SaveTransactionStore;
    records: SaveOperationRecordStore;
    locksRoot: string;
    stagingRoot: string;
    sandboxesRoot: string;
    faultInjector?: SaveRestoreFaultInjector;
  }) {
    this.#managerRoot = input.managerRoot;
    this.#contexts = input.contexts;
    this.#backups = input.backups;
    this.#plans = input.plans;
    this.#transactions = input.transactions;
    this.#records = input.records;
    this.#locksRoot = input.locksRoot;
    this.#stagingRoot = input.stagingRoot;
    this.#sandboxesRoot = input.sandboxesRoot;
    this.#faultInjector = input.faultInjector;
  }

  static async create(options: SaveRestoreServiceOptions): Promise<SaveRestoreService> {
    const [plans, transactions, records, locksRoot, stagingRoot, sandboxesRoot] =
      await Promise.all([
        SaveRestorePlanStore.create({
          managerRoot: options.managerRoot,
          ...(options.planTtlMs === undefined
            ? {}
            : { defaultTtlMs: options.planTtlMs }),
        }),
        SaveTransactionStore.create(options.managerRoot),
        SaveOperationRecordStore.create(options.managerRoot),
        ensureRealStoreDirectory(options.managerRoot, "locks"),
        ensureRealStoreDirectory(options.managerRoot, "staging"),
        ensureRealStoreDirectory(options.managerRoot, "sandboxes"),
      ]);
    return new SaveRestoreService({
      managerRoot: path.resolve(options.managerRoot),
      contexts: options.contexts,
      backups: options.backups,
      plans,
      transactions,
      records,
      locksRoot,
      stagingRoot,
      sandboxesRoot,
      ...(options.faultInjector === undefined
        ? {}
        : { faultInjector: options.faultInjector }),
    });
  }

  async planRestore(input: {
    backupId: string;
    saveContextId: string;
    mode: SaveRestorePlan["mode"];
    targetKind?: SaveRestorePlan["target"]["kind"];
    reviewMode?: PlanReviewMode;
    additionalManagedPaths?: ReadonlyArray<string>;
  }): Promise<Readonly<SaveRestorePlan>> {
    const [backup, context] = await Promise.all([
      this.#backups.verifyBackup(input.backupId),
      this.#contexts.getSaveContext(input.saveContextId),
    ]);
    this.#assertBackupMatchesContext(backup, context);
    const unit = this.#unit(context, backup.unitId);
    const managedPaths = [...new Set([
      ...unit.managedPaths,
      ...(input.additionalManagedPaths ?? []),
    ])];
    const primary = this.#primaryRoot(context);
    const target =
      (input.targetKind ?? "save-context") === "sandbox"
        ? {
            kind: "sandbox" as const,
            rootId: primary.rootId,
            absolutePath: path.join(this.#sandboxesRoot, randomUUID()),
          }
        : {
            kind: "save-context" as const,
            rootId: primary.rootId,
            absolutePath: primary.absolutePath,
          };
    const backupByPath = new Map(
      backup.files.map((file) => [file.relativePath.toLowerCase(), file]),
    );
    const operations: SaveRestorePlan["operations"] = [];
    const preservedPaths: NonNullable<SaveRestorePlan["preservedPaths"]> = [];
    for (const file of backup.files) {
      const resolved = resolveSaveTarget({
        saveRoot: target.absolutePath,
        targetRelativePath: file.relativePath,
        managedPaths,
      });
      await assertNoSaveReparsePointTraversal(
        resolved.saveRoot,
        resolved.targetAbsolutePath,
      );
      const pre = comparableState(await inspectPathState(resolved.targetAbsolutePath));
      if (pre.kind === "directory") {
        throw new NexusError(
          "SAVE_TARGET_DRIFTED",
          "A restore file target is currently a directory.",
          { details: { targetRelativePath: file.relativePath } },
        );
      }
      const post: SavePathState = {
        kind: "file",
        bytes: file.bytes,
        sha256: file.sha256,
      };
      if (statesEqual(pre, post)) {
        preservedPaths.push({
          relativePath: file.relativePath,
          expectedState: post,
        });
        continue;
      }
      operations.push({
        operationId: randomUUID(),
        kind: pre.kind === "absent" ? "create-file" : "replace-file",
        rootId: target.rootId,
        targetRelativePath: file.relativePath,
        sourceObjectId: file.backupObjectId,
        expectedPreState: pre,
        expectedPostState: post,
      });
    }
    if (input.mode === "exact_managed_snapshot") {
      for (const relativePath of managedPaths) {
        if (backupByPath.has(relativePath.toLowerCase())) continue;
        const resolved = resolveSaveTarget({
          saveRoot: target.absolutePath,
          targetRelativePath: relativePath,
          managedPaths,
        });
        await assertNoSaveReparsePointTraversal(
          resolved.saveRoot,
          resolved.targetAbsolutePath,
        );
        const pre = comparableState(await inspectPathState(resolved.targetAbsolutePath));
        if (pre.kind === "absent") continue;
        if (pre.kind === "directory") {
          throw new NexusError(
            "SAVE_TARGET_DRIFTED",
            "M2 exact restore does not delete managed directories.",
            { details: { targetRelativePath: relativePath } },
          );
        }
        operations.push({
          operationId: randomUUID(),
          kind: "delete-file",
          rootId: target.rootId,
          targetRelativePath: relativePath,
          sourceObjectId: null,
          expectedPreState: pre,
          expectedPostState: { kind: "absent" },
        });
      }
    }
    operations.sort((left, right) =>
      left.targetRelativePath.localeCompare(right.targetRelativePath),
    );
    preservedPaths.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    if (operations.length === 0) {
      throw new NexusError(
        "SAVE_TARGET_DRIFTED",
        "The target already matches the selected Save Backup; no restore writes are required.",
      );
    }
    const preconditionStateHash = stateHash(target, operations, preservedPaths);
    return await this.#plans.save({
      backupId: backup.backupId,
      saveContextId: context.saveContextId,
      target,
      preservedPaths,
      mode: input.mode,
      preconditionStateHash,
      operations,
      rescueUnitId: backup.unitId,
      review: createPlanReview({
        classification:
          input.reviewMode === "always_review"
            ? "review_required"
            : "auto_safe",
        reasonCodes:
          input.reviewMode === "always_review"
            ? ["USER_REQUESTED_REVIEW"]
            : target.kind === "sandbox"
              ? ["SANDBOX_SAVE_TRANSACTION"]
              : ["LIVE_SAVE_TRANSACTION"],
        ...(input.reviewMode === undefined
          ? {}
          : { mode: input.reviewMode }),
        action: "restore",
        targetIds: [backup.backupId, context.saveContextId, target.rootId],
        decisionInputs: {
          target,
          mode: input.mode,
          preconditionStateHash,
          operations,
          preservedPaths,
        },
      }),
    });
  }

  async getPlan(restorePlanId: string): Promise<Readonly<SaveRestorePlan>> {
    return await this.#plans.get(restorePlanId);
  }

  async applyRestore(restorePlanId: string): Promise<AppliedSaveRestore> {
    const existing = await this.#records.findByPlan(restorePlanId);
    if (existing) {
      const plan = await this.#plans.get(restorePlanId, { allowExpired: true });
      return {
        plan,
        record: existing,
        targetAbsolutePath: plan.target.absolutePath,
        idempotentReplay: true,
      };
    }
    const plan = await this.#plans.get(restorePlanId);
    if (plan.review?.classification === "blocked") {
      throw new NexusError(
        "PLAN_REVIEW_BLOCKED",
        "Save Restore Plan review classification blocks execution.",
        { details: { restorePlanId, reasonCodes: plan.review.reasonCodes } },
      );
    }
    const [backup, context] = await Promise.all([
      this.#backups.verifyBackup(plan.backupId),
      this.#contexts.getSaveContext(plan.saveContextId),
    ]);
    this.#assertBackupMatchesContext(backup, context);
    this.#validateFrozenTarget(plan, context);
    await this.#assertPreconditions(plan, context);

    const transaction = await this.#transactions.create({
      planKind: "restore",
      planId: plan.restorePlanId,
      planHash: plan.planHash,
    });
    let lock: InstanceLock | null = null;
    let rescueBackupId: string | null = null;
    let operationPublished = false;
    const applied: AppliedMutation[] = [];
    const stagingDirectory = path.join(this.#stagingRoot, transaction.transactionId);
    try {
      await transaction.append("planned", "Frozen Save Restore Plan loaded and verified.");
      await this.#checkpoint("after_journal_created", plan, transaction);
      lock = new InstanceLock({
        locksRoot: this.#locksRoot,
        instanceId: context.saveContextId,
        transactionId: transaction.transactionId,
      });
      await lock.acquire();
      await transaction.append("locked", "Save Context transaction lock acquired.");
      await this.#checkpoint("after_lock_acquired", plan, transaction);
      await this.#assertPreconditions(plan, context);

      if (plan.target.kind === "save-context") {
        await this.#checkpoint("before_rescue_backup", plan, transaction);
        try {
          const rescue = await this.#backups.createBackup({
            saveContextId: context.saveContextId,
            unitId: plan.rescueUnitId,
            reason: "pre_restore_rescue",
            managedPathsOverride: [
              ...plan.operations
                .filter((operation) => operation.expectedPreState.kind === "file")
                .map((operation) => operation.targetRelativePath),
              ...(plan.preservedPaths ?? [])
                .filter((preserved) => preserved.expectedState.kind === "file")
                .map((preserved) => preserved.relativePath),
            ],
          });
          await this.#backups.verifyBackup(rescue.backupId);
          rescueBackupId = rescue.backupId;
        } catch (error) {
          throw new NexusError(
            "SAVE_RESCUE_BACKUP_FAILED",
            "The pre-restore rescue backup could not be created and verified.",
            { cause: error },
          );
        }
        await transaction.append("rescue-backed-up", "Pre-restore rescue backup verified.");
        await this.#checkpoint("after_rescue_backup", plan, transaction);
        await this.#assertPreconditions(plan, context);
      }

      await this.#checkpoint("before_staging", plan, transaction);
      await mkdir(stagingDirectory, { recursive: false });
      for (const operation of plan.operations) {
        if (operation.sourceObjectId === null) continue;
        const staged = path.join(stagingDirectory, operation.operationId);
        await this.#backups.objectStore.restoreFile(operation.sourceObjectId, staged);
        const actual = comparableState(await inspectPathState(staged));
        if (!statesEqual(actual, operation.expectedPostState)) {
          throw new NexusError(
            "SAVE_STATIC_VERIFICATION_FAILED",
            "A staged save file does not match the Restore Plan.",
            { details: { operationId: operation.operationId } },
          );
        }
      }
      await transaction.append("staged", "All restore sources staged and verified.");
      await this.#checkpoint("after_staging", plan, transaction);
      await transaction.append("applying", "Applying restore operations.");

      const unit = this.#unit(context, plan.rescueUnitId);
      const managedPaths = this.#planManagedPaths(plan, unit);
      for (const operation of plan.operations) {
        await this.#checkpoint("before_target_write", plan, transaction, operation.operationId);
        const resolved = resolveSaveTarget({
          saveRoot: plan.target.absolutePath,
          targetRelativePath: operation.targetRelativePath,
          managedPaths,
        });
        await assertNoSaveReparsePointTraversal(
          resolved.saveRoot,
          resolved.targetAbsolutePath,
        );
        const actualPre = comparableState(await inspectPathState(resolved.targetAbsolutePath));
        if (!statesEqual(actualPre, operation.expectedPreState)) {
          throw new NexusError(
            "SAVE_TARGET_DRIFTED",
            "A save target changed after Restore Plan approval.",
            { details: { operationId: operation.operationId } },
          );
        }
        const createdParentDirectories = await createMissingParentDirectories(
          plan.target.absolutePath,
          resolved.targetAbsolutePath,
        );
        const rollbackAbsolutePath =
          actualPre.kind === "absent"
            ? null
            : `${resolved.targetAbsolutePath}.gamefinder-rollback-${transaction.transactionId}`;
        if (rollbackAbsolutePath) {
          await rename(resolved.targetAbsolutePath, rollbackAbsolutePath);
        }
        applied.push({
          targetAbsolutePath: resolved.targetAbsolutePath,
          rollbackAbsolutePath,
          createdParentDirectories,
        });
        if (operation.kind !== "delete-file") {
          const staged = path.join(stagingDirectory, operation.operationId);
          const temporary = `${resolved.targetAbsolutePath}.gamefinder-new-${transaction.transactionId}`;
          await copyFile(staged, temporary, constants.COPYFILE_EXCL);
          try {
            await rename(temporary, resolved.targetAbsolutePath);
          } finally {
            await rm(temporary, { force: true }).catch(() => undefined);
          }
        }
        await this.#checkpoint("after_target_write", plan, transaction, operation.operationId);
      }

      await transaction.append("verifying", "Verifying restored target states.");
      await this.#checkpoint("before_static_verify", plan, transaction);
      await this.#verifyPlanStates(plan, context, "post");
      await this.#checkpoint("after_static_verify", plan, transaction);
      await this.#checkpoint("before_record_commit", plan, transaction);
      const withoutHash = {
        schemaVersion: 1 as const,
        recordId: randomUUID(),
        kind: "restore" as const,
        planId: plan.restorePlanId,
        transactionId: transaction.transactionId,
        saveContextId: plan.saveContextId,
        sourceId: plan.backupId,
        staticVerification: "passed" as const,
        runtimeVerification: "not-run" as const,
        completedAt: new Date().toISOString(),
      };
      const record = await this.#records.save(
        saveOperationRecordSchema.parse({
          ...withoutHash,
          recordHash: sha256CanonicalJson(withoutHash),
        }),
      );
      operationPublished = true;
      await transaction.append("committed", "Save Restore Operation Record committed.");
      await transaction.finalize({ state: "committed", rescueBackupId });
      await this.#checkpoint("after_record_commit", plan, transaction);
      await this.#removeRollbackArtifacts(applied);
      return {
        plan,
        record,
        targetAbsolutePath: plan.target.absolutePath,
        idempotentReplay: false,
      };
    } catch (error) {
      if (operationPublished) throw error;
      try {
        await this.#rollback(transaction, plan, context, applied, rescueBackupId);
      } catch (rollbackError) {
        await transaction.append("failed", "Automatic rollback failed; recovery is required.")
          .catch(() => undefined);
        await transaction.finalize({
          state: "recovery-required",
          rescueBackupId,
        }).catch(() => undefined);
        throw new NexusError(
          "SAVE_ROLLBACK_FAILED",
          "Save restore failed and the original state could not be restored automatically.",
          {
            cause: rollbackError,
            details: {
              transactionId: transaction.transactionId,
              rescueBackupId,
              originalError: error instanceof Error ? error.message : String(error),
            },
          },
        );
      }
      throw error;
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      await lock?.release().catch(() => undefined);
    }
  }

  async verifyRestore(recordId: string): Promise<Readonly<SaveOperationRecord>> {
    const record = await this.#records.get(recordId);
    if (record.kind !== "restore") {
      throw new NexusError("SAVE_STATIC_VERIFICATION_FAILED", "Operation is not a restore.");
    }
    const plan = await this.#plans.get(record.planId, { allowExpired: true });
    const context = await this.#contexts.getSaveContext(record.saveContextId);
    await this.#verifyPlanStates(plan, context, "post");
    return record;
  }

  async #rollback(
    transaction: SaveTransactionWriter,
    plan: SaveRestorePlan,
    context: SaveContext,
    applied: ReadonlyArray<AppliedMutation>,
    rescueBackupId: string | null,
  ): Promise<void> {
    await transaction.append("rolling-back", "Rolling back applied save mutations.");
    for (const mutation of [...applied].reverse()) {
      await rm(mutation.targetAbsolutePath, { recursive: true, force: true });
      if (mutation.rollbackAbsolutePath) {
        await rename(mutation.rollbackAbsolutePath, mutation.targetAbsolutePath);
      }
      await removeEmptyParents(mutation.createdParentDirectories);
    }
    await this.#verifyPlanStates(plan, context, "pre");
    await transaction.append("rolled-back", "Original save target states verified after rollback.");
    await transaction.finalize({ state: "rolled-back", rescueBackupId });
  }

  async #removeRollbackArtifacts(applied: ReadonlyArray<AppliedMutation>): Promise<void> {
    for (const mutation of applied) {
      if (mutation.rollbackAbsolutePath) {
        await rm(mutation.rollbackAbsolutePath, { recursive: true, force: true });
      }
    }
  }

  async #assertPreconditions(plan: SaveRestorePlan, context: SaveContext): Promise<void> {
    await this.#verifyPlanStates(plan, context, "pre");
    const actual = stateHash(plan.target, plan.operations, plan.preservedPaths);
    if (actual !== plan.preconditionStateHash) {
      throw new NexusError(
        "SAVE_TARGET_DRIFTED",
        "Restore Plan precondition hash is invalid.",
        { details: { expected: plan.preconditionStateHash, actual } },
      );
    }
  }

  async #verifyPlanStates(
    plan: SaveRestorePlan,
    context: SaveContext,
    phase: "pre" | "post",
  ): Promise<void> {
    const unit = this.#unit(context, plan.rescueUnitId);
    const managedPaths = this.#planManagedPaths(plan, unit);
    for (const operation of plan.operations) {
      const resolved = resolveSaveTarget({
        saveRoot: plan.target.absolutePath,
        targetRelativePath: operation.targetRelativePath,
        managedPaths,
      });
      await assertNoSaveReparsePointTraversal(
        resolved.saveRoot,
        resolved.targetAbsolutePath,
      );
      const actual = comparableState(await inspectPathState(resolved.targetAbsolutePath));
      const expected =
        phase === "pre" ? operation.expectedPreState : operation.expectedPostState;
      if (!statesEqual(actual, expected)) {
        throw new NexusError(
          phase === "pre" ? "SAVE_TARGET_DRIFTED" : "SAVE_STATIC_VERIFICATION_FAILED",
          phase === "pre"
            ? "A save target changed after Restore Plan approval."
            : "A restored save target failed static verification.",
          {
            details: {
              operationId: operation.operationId,
              targetRelativePath: operation.targetRelativePath,
              expected,
              actual,
            },
          },
        );
      }
    }
    for (const preserved of plan.preservedPaths ?? []) {
      const resolved = resolveSaveTarget({
        saveRoot: plan.target.absolutePath,
        targetRelativePath: preserved.relativePath,
        managedPaths,
      });
      await assertNoSaveReparsePointTraversal(
        resolved.saveRoot,
        resolved.targetAbsolutePath,
      );
      const actual = comparableState(await inspectPathState(resolved.targetAbsolutePath));
      if (!statesEqual(actual, preserved.expectedState)) {
        throw new NexusError(
          phase === "pre" ? "SAVE_TARGET_DRIFTED" : "SAVE_STATIC_VERIFICATION_FAILED",
          "A preserve-identical restore target changed.",
          {
            details: {
              relativePath: preserved.relativePath,
              expected: preserved.expectedState,
              actual,
            },
          },
        );
      }
    }
  }

  #planManagedPaths(
    plan: SaveRestorePlan,
    unit: SaveContext["saveUnits"][number],
  ): string[] {
    return [...new Set([
      ...unit.managedPaths,
      ...plan.operations.map((operation) => operation.targetRelativePath),
      ...(plan.preservedPaths ?? []).map((preserved) => preserved.relativePath),
    ])];
  }

  #validateFrozenTarget(plan: SaveRestorePlan, context: SaveContext): void {
    const primary = this.#primaryRoot(context);
    if (plan.target.rootId !== primary.rootId) {
      throw new NexusError("SAVE_TARGET_DRIFTED", "Restore target root identity changed.");
    }
    if (plan.target.kind === "save-context") {
      if (!sameAbsolutePath(plan.target.absolutePath, primary.absolutePath)) {
        throw new NexusError("SAVE_TARGET_DRIFTED", "Live restore target is not the frozen Save Context root.");
      }
      return;
    }
    const relative = path.relative(this.#sandboxesRoot, plan.target.absolutePath);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      relative.includes(path.sep) ||
      !/^[0-9a-f-]{36}$/i.test(relative)
    ) {
      throw new NexusError("SAVE_PATH_PROTECTED", "Sandbox restore target is outside controlled storage.");
    }
  }

  #assertBackupMatchesContext(backup: SaveBackupRecord, context: SaveContext): void {
    if (backup.saveContextId !== context.saveContextId) {
      throw new NexusError(
        "SAVE_BACKUP_INVALID",
        "Save Backup belongs to a different Save Context.",
      );
    }
    if (
      backup.profileId !== context.profile.profileId ||
      backup.profileVersion !== context.profile.profileVersion
    ) {
      throw new NexusError(
        "SAVE_CONTEXT_STALE",
        "Save Backup profile does not match the current Save Context.",
      );
    }
    this.#unit(context, backup.unitId);
  }

  #unit(context: SaveContext, unitId: string): SaveContext["saveUnits"][number] {
    const unit = context.saveUnits.find((candidate) => candidate.unitId === unitId);
    if (!unit) {
      throw new NexusError("SAVE_BACKUP_INVALID", "Save Unit is not declared by the Save Context.");
    }
    return unit;
  }

  #primaryRoot(context: SaveContext): SaveContext["saveRoots"][number] {
    const root = context.saveRoots.find((candidate) => candidate.role === "primary");
    if (!root) {
      throw new NexusError("SAVE_CONTEXT_STALE", "Save Context has no primary save root.");
    }
    return root;
  }

  async #checkpoint(
    checkpoint: SaveRestoreCheckpoint,
    plan: SaveRestorePlan,
    transaction: SaveTransactionWriter,
    operationId?: string,
  ): Promise<void> {
    await this.#faultInjector?.checkpoint(checkpoint, {
      restorePlanId: plan.restorePlanId,
      transactionId: transaction.transactionId,
      ...(operationId === undefined ? {} : { operationId }),
    });
  }
}
