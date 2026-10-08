import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import { InstanceLock } from "../../install/core/instance-lock.js";
import { inspectPathState } from "../../install/core/tree-state.js";
import type { SaveBackupService } from "../backup/save-backup-service.js";
import type { EldenRingSlotImportService } from "../adapters/elden-ring-slot-import-service.js";
import type {
  SaveCompatibilityAssessment,
  SaveContext,
  SaveOperationRecord,
  SaveReplacementPlan,
} from "../contracts.js";
import { saveOperationRecordSchema } from "../contracts.js";
import type { SavePackageNormalizer } from "../package/package-normalizer.js";
import {
  assertNoSaveReparsePointTraversal,
  resolveSaveTarget,
} from "../path-policy.js";
import { SaveOperationRecordStore } from "../restore/save-operation-record-store.js";
import {
  SaveTransactionStore,
  type SaveTransactionWriter,
} from "../restore/save-transaction-store.js";
import type { SaveContextStore } from "../storage/context-store.js";
import { ensureRealStoreDirectory } from "../storage/json-store.js";
import type { SaveCompatibilityAssessor } from "./compatibility-assessor.js";
import { SaveReplacementPlanStore } from "./save-replacement-plan-store.js";
import {
  createPlanReview,
  type PlanReviewMode,
} from "../../plan-review.js";

type SavePathState = SaveReplacementPlan["operations"][number]["expectedPreState"];

export type SaveReplacementCheckpoint =
  | "after_lock_acquired"
  | "before_rescue_backup"
  | "after_rescue_backup"
  | "after_staging"
  | "before_target_write"
  | "after_target_write"
  | "before_static_verify"
  | "before_record_commit"
  | "after_record_commit";

export interface SaveReplacementFaultInjector {
  checkpoint(
    checkpoint: SaveReplacementCheckpoint,
    context: {
      replacementPlanId: string;
      transactionId: string;
      operationId?: string;
    },
  ): Promise<void>;
}

export interface AppliedSaveReplacement {
  plan: Readonly<SaveReplacementPlan>;
  record: Readonly<SaveOperationRecord>;
  rescueBackupId: string;
  idempotentReplay: boolean;
}

interface AppliedMutation {
  targetPath: string;
  rollbackPath: string | null;
}

function comparableState(state: Awaited<ReturnType<typeof inspectPathState>>): SavePathState {
  if (state.kind === "directory") {
    if (state.treeHash === null) {
      throw new NexusError("SAVE_STATIC_VERIFICATION_FAILED", "Managed directory could not be hashed.");
    }
    return { kind: "directory", treeHash: state.treeHash };
  }
  return state;
}

function statesEqual(left: SavePathState, right: SavePathState): boolean {
  return sha256CanonicalJson(left) === sha256CanonicalJson(right);
}

function preconditionHash(
  target: SaveReplacementPlan["target"],
  operations: SaveReplacementPlan["operations"],
  payloadPolicies: SaveReplacementPlan["payloadPolicies"],
): string {
  return sha256CanonicalJson({
    target,
    states: operations.map((operation) => ({
      operationId: operation.operationId,
      targetRelativePath: operation.targetRelativePath,
      expectedPreState: operation.expectedPreState,
    })),
    payloadPolicies,
  });
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export class SaveReplacementService {
  readonly #contexts: SaveContextStore;
  readonly #packages: SavePackageNormalizer;
  readonly #assessments: SaveCompatibilityAssessor;
  readonly #backups: SaveBackupService;
  readonly #plans: SaveReplacementPlanStore;
  readonly #transactions: SaveTransactionStore;
  readonly #records: SaveOperationRecordStore;
  readonly #locksRoot: string;
  readonly #stagingRoot: string;
  readonly #faultInjector: SaveReplacementFaultInjector | undefined;
  readonly #eldenRingSlots: EldenRingSlotImportService | undefined;

  private constructor(input: {
    contexts: SaveContextStore;
    packages: SavePackageNormalizer;
    assessments: SaveCompatibilityAssessor;
    backups: SaveBackupService;
    plans: SaveReplacementPlanStore;
    transactions: SaveTransactionStore;
    records: SaveOperationRecordStore;
    locksRoot: string;
    stagingRoot: string;
    eldenRingSlots?: EldenRingSlotImportService;
    faultInjector?: SaveReplacementFaultInjector;
  }) {
    this.#contexts = input.contexts;
    this.#packages = input.packages;
    this.#assessments = input.assessments;
    this.#backups = input.backups;
    this.#plans = input.plans;
    this.#transactions = input.transactions;
    this.#records = input.records;
    this.#locksRoot = input.locksRoot;
    this.#stagingRoot = input.stagingRoot;
    this.#faultInjector = input.faultInjector;
    this.#eldenRingSlots = input.eldenRingSlots;
  }

  static async create(options: {
    managerRoot: string;
    contexts: SaveContextStore;
    packages: SavePackageNormalizer;
    assessments: SaveCompatibilityAssessor;
    backups: SaveBackupService;
    eldenRingSlots?: EldenRingSlotImportService;
    planTtlMs?: number;
    faultInjector?: SaveReplacementFaultInjector;
  }): Promise<SaveReplacementService> {
    const [plans, transactions, records, locksRoot, stagingRoot] = await Promise.all([
      SaveReplacementPlanStore.create({
        managerRoot: options.managerRoot,
        ...(options.planTtlMs === undefined ? {} : { defaultTtlMs: options.planTtlMs }),
      }),
      SaveTransactionStore.create(options.managerRoot),
      SaveOperationRecordStore.create(options.managerRoot),
      ensureRealStoreDirectory(options.managerRoot, "locks"),
      ensureRealStoreDirectory(options.managerRoot, "replacement-staging"),
    ]);
    return new SaveReplacementService({
      contexts: options.contexts,
      packages: options.packages,
      assessments: options.assessments,
      backups: options.backups,
      plans,
      transactions,
      records,
      locksRoot,
      stagingRoot,
      ...(options.eldenRingSlots === undefined ? {} : { eldenRingSlots: options.eldenRingSlots }),
      ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
    });
  }

  async planReplacement(input: {
    assessmentId: string;
    strategy: "direct_replace";
    reviewMode?: PlanReviewMode;
    replacementMode?: "overlay" | "exact-unit";
    authorizedTargetPaths?: ReadonlyArray<string>;
  }): Promise<Readonly<SaveReplacementPlan>> {
    const assessment = await this.#assessments.get(input.assessmentId);
    if (
      assessment.state !== "compatible_direct" ||
      assessment.recommendedStrategy !== "direct_replace" ||
      input.strategy !== "direct_replace"
    ) {
      throw new NexusError(
        "SAVE_ADAPTER_UNSUPPORTED",
        "M3 can plan only a proven same-account direct replacement.",
        { details: { state: assessment.state, strategy: input.strategy } },
      );
    }
    const [savePackage, context] = await Promise.all([
      this.#packages.verify(assessment.packageId),
      this.#contexts.getSaveContext(assessment.saveContextId),
    ]);
    this.#assertAssessmentCurrent(assessment, savePackage.manifestHash);
    const packageUnitId = "unitId" in savePackage && typeof savePackage.unitId === "string"
      ? savePackage.unitId
      : "vanilla-main";
    const unit = this.#unit(context, packageUnitId);
    const root = this.#primaryRoot(context);
    const operations: SaveReplacementPlan["operations"] = [];
    const payloadPolicies: SaveReplacementPlan["payloadPolicies"] = [];
    const replacementMode = input.replacementMode ?? "overlay";
    const authorizedTargetPaths = replacementMode === "exact-unit"
      ? [...new Set(input.authorizedTargetPaths ?? [])]
      : unit.managedPaths;
    const managedPaths = [...new Set([...unit.managedPaths, ...authorizedTargetPaths])];
    const sourcePaths = new Set(
      savePackage.payload.files.map((file) => file.relativePath.toLocaleLowerCase("en-US")),
    );
    for (const file of savePackage.payload.files) {
      if (
        replacementMode === "exact-unit" &&
        !authorizedTargetPaths.some(
          (candidate) => candidate.toLocaleLowerCase("en-US") === file.relativePath.toLocaleLowerCase("en-US"),
        )
      ) {
        throw new NexusError("SAVE_PATH_PROTECTED", "A package target was not authorized by the V2 Compatibility Assessment.");
      }
      const object = await this.#packages.objectStore.get(file.objectId);
      if (
        object.objectKind !== "file" ||
        object.bytes !== file.bytes ||
        object.sha256 !== file.sha256
      ) {
        throw new NexusError("SAVE_PACKAGE_INVALID", "Package content object does not match its manifest.");
      }
      const resolved = resolveSaveTarget({
        saveRoot: root.absolutePath,
        targetRelativePath: file.relativePath,
        managedPaths,
      });
      await assertNoSaveReparsePointTraversal(resolved.saveRoot, resolved.targetAbsolutePath);
      const pre = comparableState(await inspectPathState(resolved.targetAbsolutePath));
      if (pre.kind === "directory") {
        throw new NexusError("SAVE_TARGET_DRIFTED", "A package file target is a directory.");
      }
      const post: SavePathState = { kind: "file", bytes: file.bytes, sha256: file.sha256 };
      const action = statesEqual(pre, post)
        ? "preserve-identical" as const
        : pre.kind === "absent"
          ? "create" as const
          : "replace" as const;
      payloadPolicies.push({
        relativePath: file.relativePath,
        action,
        expectedPreState: pre,
        expectedPostState: post,
      });
      if (action === "preserve-identical") continue;
      operations.push({
        operationId: randomUUID(),
        kind: pre.kind === "absent" ? "create-file" : "replace-file",
        rootId: root.rootId,
        targetRelativePath: file.relativePath,
        sourceObjectId: file.objectId,
        expectedPreState: pre,
        expectedPostState: post,
      });
    }
    if (replacementMode === "exact-unit") {
      for (const relativePath of unit.managedPaths) {
        if (sourcePaths.has(relativePath.toLocaleLowerCase("en-US"))) continue;
        const resolved = resolveSaveTarget({
          saveRoot: root.absolutePath,
          targetRelativePath: relativePath,
          managedPaths,
        });
        await assertNoSaveReparsePointTraversal(resolved.saveRoot, resolved.targetAbsolutePath);
        const pre = comparableState(await inspectPathState(resolved.targetAbsolutePath));
        if (pre.kind === "absent") continue;
        if (pre.kind === "directory") {
          throw new NexusError("SAVE_TARGET_DRIFTED", "An exact-unit replacement target is a directory.");
        }
        const post: SavePathState = { kind: "absent" };
        payloadPolicies.push({
          relativePath,
          action: "delete",
          expectedPreState: pre,
          expectedPostState: post,
        });
        operations.push({
          operationId: randomUUID(),
          kind: "delete-file",
          rootId: root.rootId,
          targetRelativePath: relativePath,
          sourceObjectId: null,
          expectedPreState: pre,
          expectedPostState: post,
        });
      }
    }
    operations.sort((left, right) => left.targetRelativePath.localeCompare(right.targetRelativePath));
    payloadPolicies.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const target = { rootId: root.rootId, absolutePath: root.absolutePath };
    return await this.#plans.save({
      packageId: savePackage.packageId,
      packageManifestHash: savePackage.manifestHash,
      saveContextId: context.saveContextId,
      compatibilityAssessmentId: assessment.assessmentId,
      compatibilityHash: assessment.assessmentHash,
      target,
      payloadPolicies,
      strategy: "direct_replace",
      replacementMode,
      adapterId: context.format.adapterId ?? "unknown",
      sourceSlot: null,
      targetSlot: null,
      preconditionStateHash: preconditionHash(target, operations, payloadPolicies),
      operations,
      rescueUnitId: unit.unitId,
      review: createPlanReview({
        classification:
          input.reviewMode === "always_review"
            ? "review_required"
            : "auto_safe",
        reasonCodes:
          input.reviewMode === "always_review"
            ? ["USER_REQUESTED_REVIEW"]
            : ["LIVE_SAVE_TRANSACTION"],
        ...(input.reviewMode === undefined
          ? {}
          : { mode: input.reviewMode }),
        action: "replace",
        targetIds: [
          savePackage.packageId,
          context.saveContextId,
          assessment.assessmentId,
        ],
        decisionInputs: {
          strategy: input.strategy,
          replacementMode,
          target,
          operations,
          payloadPolicies,
        },
      }),
    });
  }

  async planStagedSlotImport(
    stagedImportId: string,
    options: { reviewMode?: PlanReviewMode } = {},
  ): Promise<Readonly<SaveReplacementPlan>> {
    const eldenRingSlots = this.#requireEldenRingSlots();
    const staged = await eldenRingSlots.verifyStage(stagedImportId);
    const slotPlan = await eldenRingSlots.getPlan(staged.slotImportPlanId, true);
    const [savePackage, context, assessment] = await Promise.all([
      this.#packages.verify(slotPlan.packageId),
      this.#contexts.getSaveContext(slotPlan.saveContextId),
      this.#assessments.assess({ packageId: slotPlan.packageId, saveContextId: slotPlan.saveContextId }),
    ]);
    if (
      assessment.state !== "compatible_with_slot_import" ||
      assessment.recommendedStrategy !== "slot_import" ||
      staged.planHash !== slotPlan.planHash ||
      staged.sourceFileSha256 !== slotPlan.sourceFileSha256 ||
      staged.targetPreStateSha256 !== slotPlan.targetPreStateSha256
    ) {
      throw new NexusError("SAVE_STAGING_INVALID", "Staged Elden Ring import is not compatible with a slot-import Replacement Plan.");
    }
    const unit = this.#unit(context, "vanilla-main");
    const root = this.#primaryRoot(context);
    const targetPath = resolveSaveTarget({
      saveRoot: root.absolutePath,
      targetRelativePath: "ER0000.sl2",
      managedPaths: unit.managedPaths,
    });
    await assertNoSaveReparsePointTraversal(targetPath.saveRoot, targetPath.targetAbsolutePath);
    const pre = comparableState(await inspectPathState(targetPath.targetAbsolutePath));
    if (pre.kind !== "file" || pre.sha256 !== staged.targetPreStateSha256 || pre.bytes !== staged.bytes) {
      throw new NexusError("SAVE_TARGET_DRIFTED", "Live ER0000.sl2 no longer matches the staged import prestate.");
    }
    const stagedObject = await this.#packages.objectStore.backupFile(staged.stagedPath);
    if (stagedObject.objectKind !== "file" || stagedObject.sha256 !== staged.stagedSha256 || stagedObject.bytes !== staged.bytes) {
      throw new NexusError("SAVE_STAGING_INVALID", "Staged import could not be frozen into the content-addressed object store.");
    }
    const post: SavePathState = { kind: "file", bytes: staged.bytes, sha256: staged.stagedSha256 };
    const operations: SaveReplacementPlan["operations"] = [{
      operationId: randomUUID(),
      kind: "replace-file",
      rootId: root.rootId,
      targetRelativePath: "ER0000.sl2",
      sourceObjectId: stagedObject.backupId,
      expectedPreState: pre,
      expectedPostState: post,
    }];
    const payloadPolicies: SaveReplacementPlan["payloadPolicies"] = [{
      relativePath: "ER0000.sl2", action: "replace", expectedPreState: pre, expectedPostState: post,
    }];
    for (const relativePath of [...unit.companions, ...unit.auxiliary]) {
      const resolved = resolveSaveTarget({ saveRoot: root.absolutePath, targetRelativePath: relativePath, managedPaths: unit.managedPaths });
      await assertNoSaveReparsePointTraversal(resolved.saveRoot, resolved.targetAbsolutePath);
      const state = comparableState(await inspectPathState(resolved.targetAbsolutePath));
      payloadPolicies.push({ relativePath, action: "preserve-identical", expectedPreState: state, expectedPostState: state });
    }
    payloadPolicies.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const target = { rootId: root.rootId, absolutePath: root.absolutePath };
    return await this.#plans.save({
      packageId: savePackage.packageId,
      packageManifestHash: savePackage.manifestHash,
      saveContextId: context.saveContextId,
      compatibilityAssessmentId: assessment.assessmentId,
      compatibilityHash: assessment.assessmentHash,
      target,
      payloadPolicies,
      strategy: "slot_import",
      adapterId: "elden-ring-steam-pc",
      sourceSlot: slotPlan.sourceSlot,
      targetSlot: slotPlan.targetSlot,
      stagedImportId: staged.stagedImportId,
      stagedImportRecordHash: staged.recordHash,
      slotImportPlanId: slotPlan.slotImportPlanId,
      slotImportPlanHash: slotPlan.planHash,
      preconditionStateHash: preconditionHash(target, operations, payloadPolicies),
      operations,
      rescueUnitId: unit.unitId,
      review: createPlanReview({
        classification:
          options.reviewMode === "always_review"
            ? "review_required"
            : "auto_safe",
        reasonCodes:
          options.reviewMode === "always_review"
            ? ["USER_REQUESTED_REVIEW"]
            : ["LIVE_SAVE_TRANSACTION"],
        ...(options.reviewMode === undefined
          ? {}
          : { mode: options.reviewMode }),
        action: "replace",
        targetIds: [
          staged.stagedImportId,
          savePackage.packageId,
          context.saveContextId,
          String(slotPlan.targetSlot),
        ],
        decisionInputs: {
          strategy: "slot_import",
          sourceSlot: slotPlan.sourceSlot,
          targetSlot: slotPlan.targetSlot,
          target,
          operations,
          payloadPolicies,
        },
      }),
    });
  }

  async getPlan(replacementPlanId: string): Promise<Readonly<SaveReplacementPlan>> {
    return await this.#plans.get(replacementPlanId);
  }

  async applyReplacement(replacementPlanId: string): Promise<AppliedSaveReplacement> {
    const existing = await this.#records.findByPlan(replacementPlanId);
    if (existing) {
      const plan = await this.#plans.get(replacementPlanId, { allowExpired: true });
      const transaction = await this.#transactions.getRecord(existing.transactionId);
      if (!transaction.rescueBackupId) {
        throw new NexusError("SAVE_RESCUE_BACKUP_FAILED", "Committed replacement lacks a rescue backup.");
      }
      return {
        plan,
        record: existing,
        rescueBackupId: transaction.rescueBackupId,
        idempotentReplay: true,
      };
    }
    const plan = await this.#plans.get(replacementPlanId);
    if (plan.review?.classification === "blocked") {
      throw new NexusError(
        "PLAN_REVIEW_BLOCKED",
        "Save Replacement Plan review classification blocks execution.",
        {
          details: {
            replacementPlanId,
            reasonCodes: plan.review.reasonCodes,
          },
        },
      );
    }
    const [savePackage, context, assessment] = await Promise.all([
      this.#packages.verify(plan.packageId),
      this.#contexts.getSaveContext(plan.saveContextId),
      this.#assessments.get(plan.compatibilityAssessmentId),
    ]);
    if (plan.strategy === "slot_import") {
      await this.#validateSlotImportPlanBindings(plan, context, assessment, savePackage.manifestHash);
    } else {
      this.#validatePlanBindings(plan, context, assessment, savePackage.manifestHash);
    }
    await this.#verifyStates(plan, context, "pre");

    const transaction = await this.#transactions.create({
      planKind: "replacement",
      planId: plan.replacementPlanId,
      planHash: plan.planHash,
    });
    const lock = new InstanceLock({
      locksRoot: this.#locksRoot,
      instanceId: context.saveContextId,
      transactionId: transaction.transactionId,
    });
    const stagingRoot = path.join(this.#stagingRoot, transaction.transactionId);
    const applied: AppliedMutation[] = [];
    let rescueBackupId: string | null = null;
    let operationPublished = false;
    try {
      await transaction.append("planned", "Frozen Save Replacement Plan loaded and verified.");
      await lock.acquire();
      await transaction.append("locked", "Save Context transaction lock acquired.");
      await this.#checkpoint("after_lock_acquired", plan, transaction);
      await this.#verifyStates(plan, context, "pre");
      await this.#checkpoint("before_rescue_backup", plan, transaction);
      try {
        const rescue = await this.#backups.createBackup({
          saveContextId: context.saveContextId,
          unitId: plan.rescueUnitId,
          reason: "pre_replacement_rescue",
        });
        await this.#backups.verifyBackup(rescue.backupId);
        rescueBackupId = rescue.backupId;
      } catch (error) {
        throw new NexusError(
          "SAVE_RESCUE_BACKUP_FAILED",
          "The pre-replacement rescue backup could not be created and verified.",
          { cause: error },
        );
      }
      await transaction.append("rescue-backed-up", "Pre-replacement rescue backup verified.");
      await this.#checkpoint("after_rescue_backup", plan, transaction);
      await this.#verifyStates(plan, context, "pre");

      await mkdir(stagingRoot, { recursive: false });
      for (const operation of plan.operations) {
        if (operation.kind === "delete-file") continue;
        if (!operation.sourceObjectId) {
          throw new NexusError("SAVE_PACKAGE_INVALID", "Replacement operation has no source object.");
        }
        const staged = path.join(stagingRoot, operation.operationId);
        await this.#packages.objectStore.restoreFile(operation.sourceObjectId, staged);
        const actual = comparableState(await inspectPathState(staged));
        if (!statesEqual(actual, operation.expectedPostState)) {
          throw new NexusError("SAVE_STATIC_VERIFICATION_FAILED", "Staged package file hash failed.");
        }
      }
      await transaction.append("staged", "All package sources staged and verified.");
      await this.#checkpoint("after_staging", plan, transaction);
      await transaction.append("applying", plan.strategy === "slot_import"
        ? "Applying frozen Elden Ring slot-import replacement operation."
        : "Applying direct save replacement operations.");
      const unit = this.#unit(context, plan.rescueUnitId);
      const managedPaths = this.#planManagedPaths(plan, unit);
      for (const operation of plan.operations) {
        await this.#checkpoint("before_target_write", plan, transaction, operation.operationId);
        const resolved = resolveSaveTarget({
          saveRoot: plan.target.absolutePath,
          targetRelativePath: operation.targetRelativePath,
          managedPaths,
        });
        await assertNoSaveReparsePointTraversal(resolved.saveRoot, resolved.targetAbsolutePath);
        const actualPre = comparableState(await inspectPathState(resolved.targetAbsolutePath));
        if (!statesEqual(actualPre, operation.expectedPreState)) {
          throw new NexusError("SAVE_TARGET_DRIFTED", "A replacement target changed after planning.");
        }
        await mkdir(path.dirname(resolved.targetAbsolutePath), { recursive: true });
        const rollbackPath =
          actualPre.kind === "absent"
            ? null
            : `${resolved.targetAbsolutePath}.gamefinder-rollback-${transaction.transactionId}`;
        if (rollbackPath) await rename(resolved.targetAbsolutePath, rollbackPath);
        applied.push({ targetPath: resolved.targetAbsolutePath, rollbackPath });
        if (operation.kind !== "delete-file") {
          const temporary = `${resolved.targetAbsolutePath}.gamefinder-new-${transaction.transactionId}`;
          await copyFile(
            path.join(stagingRoot, operation.operationId),
            temporary,
            constants.COPYFILE_EXCL,
          );
          try {
            await rename(temporary, resolved.targetAbsolutePath);
          } finally {
            await rm(temporary, { force: true }).catch(() => undefined);
          }
        }
        await this.#checkpoint("after_target_write", plan, transaction, operation.operationId);
      }
      await transaction.append("verifying", "Verifying replaced save target states.");
      await this.#checkpoint("before_static_verify", plan, transaction);
      await this.#verifyStates(plan, context, "post");
      await this.#checkpoint("before_record_commit", plan, transaction);
      const withoutHash = {
        schemaVersion: 1 as const,
        recordId: randomUUID(),
        kind: "replacement" as const,
        planId: plan.replacementPlanId,
        transactionId: transaction.transactionId,
        saveContextId: context.saveContextId,
        sourceId: plan.stagedImportId ?? plan.packageId,
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
      await transaction.append("committed", "Save Replacement Operation Record committed.");
      await transaction.finalize({ state: "committed", rescueBackupId });
      await this.#checkpoint("after_record_commit", plan, transaction);
      for (const mutation of applied) {
        if (mutation.rollbackPath) await rm(mutation.rollbackPath, { force: true });
      }
      return {
        plan,
        record,
        rescueBackupId: rescueBackupId!,
        idempotentReplay: false,
      };
    } catch (error) {
      if (operationPublished) throw error;
      try {
        await transaction.append("rolling-back", "Rolling back save replacement mutations.");
        for (const mutation of [...applied].reverse()) {
          await rm(mutation.targetPath, { recursive: true, force: true });
          if (mutation.rollbackPath) await rename(mutation.rollbackPath, mutation.targetPath);
        }
        await this.#verifyStates(plan, context, "pre");
        await transaction.append("rolled-back", "Original save states verified after rollback.");
        await transaction.finalize({ state: "rolled-back", rescueBackupId });
      } catch (rollbackError) {
        await transaction.append("failed", "Replacement rollback failed.").catch(() => undefined);
        await transaction.finalize({ state: "recovery-required", rescueBackupId }).catch(() => undefined);
        throw new NexusError("SAVE_ROLLBACK_FAILED", "Replacement failed and rollback was incomplete.", {
          cause: rollbackError,
          details: { transactionId: transaction.transactionId, rescueBackupId },
        });
      }
      throw error;
    } finally {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      await lock.release().catch(() => undefined);
    }
  }

  async verifyReplacement(recordId: string): Promise<Readonly<SaveOperationRecord>> {
    const record = await this.#records.get(recordId);
    if (record.kind !== "replacement") {
      throw new NexusError("SAVE_STATIC_VERIFICATION_FAILED", "Operation is not a replacement.");
    }
    const plan = await this.#plans.get(record.planId, { allowExpired: true });
    const context = await this.#contexts.getSaveContext(record.saveContextId);
    await this.#verifyStates(plan, context, "post");
    return record;
  }

  async #verifyStates(
    plan: SaveReplacementPlan,
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
      const actual = comparableState(await inspectPathState(resolved.targetAbsolutePath));
      const expected = phase === "pre" ? operation.expectedPreState : operation.expectedPostState;
      if (!statesEqual(actual, expected)) {
        throw new NexusError(
          phase === "pre" ? "SAVE_TARGET_DRIFTED" : "SAVE_STATIC_VERIFICATION_FAILED",
          phase === "pre"
            ? "A replacement target changed after plan approval."
            : "A replacement target failed static verification.",
          { details: { operationId: operation.operationId, expected, actual } },
        );
      }
    }
    for (const policy of plan.payloadPolicies.filter(
      (candidate) => candidate.action === "preserve-identical",
    )) {
      const resolved = resolveSaveTarget({
        saveRoot: plan.target.absolutePath,
        targetRelativePath: policy.relativePath,
        managedPaths,
      });
      const actual = comparableState(await inspectPathState(resolved.targetAbsolutePath));
      const expected = phase === "pre" ? policy.expectedPreState : policy.expectedPostState;
      if (!statesEqual(actual, expected)) {
        throw new NexusError(
          phase === "pre" ? "SAVE_TARGET_DRIFTED" : "SAVE_STATIC_VERIFICATION_FAILED",
          "A preserve-identical package target changed.",
          { details: { relativePath: policy.relativePath, expected, actual } },
        );
      }
    }
  }

  #planManagedPaths(
    plan: SaveReplacementPlan,
    unit: SaveContext["saveUnits"][number],
  ): string[] {
    return [...new Set([
      ...unit.managedPaths,
      ...plan.operations.map((operation) => operation.targetRelativePath),
      ...plan.payloadPolicies.map((policy) => policy.relativePath),
    ])];
  }

  #validatePlanBindings(
    plan: SaveReplacementPlan,
    context: SaveContext,
    assessment: SaveCompatibilityAssessment,
    manifestHash: string,
  ): void {
    const root = this.#primaryRoot(context);
    if (
      !samePath(plan.target.absolutePath, root.absolutePath) ||
      plan.target.rootId !== root.rootId ||
      plan.packageManifestHash !== manifestHash ||
      plan.compatibilityHash !== assessment.assessmentHash ||
      plan.packageId !== assessment.packageId ||
      plan.saveContextId !== assessment.saveContextId ||
      preconditionHash(plan.target, plan.operations, plan.payloadPolicies) !== plan.preconditionStateHash
    ) {
      throw new NexusError("SAVE_TARGET_DRIFTED", "Replacement Plan bindings changed or are stale.");
    }
    this.#assertAssessmentCurrent(assessment, manifestHash);
  }

  async #validateSlotImportPlanBindings(
    plan: SaveReplacementPlan,
    context: SaveContext,
    assessment: SaveCompatibilityAssessment,
    manifestHash: string,
  ): Promise<void> {
    const root = this.#primaryRoot(context);
    if (
      plan.strategy !== "slot_import" ||
      plan.adapterId !== "elden-ring-steam-pc" ||
      !plan.stagedImportId || !plan.stagedImportRecordHash || !plan.slotImportPlanId || !plan.slotImportPlanHash ||
      !samePath(plan.target.absolutePath, root.absolutePath) ||
      plan.target.rootId !== root.rootId ||
      plan.packageManifestHash !== manifestHash ||
      plan.compatibilityHash !== assessment.assessmentHash ||
      plan.packageId !== assessment.packageId ||
      plan.saveContextId !== assessment.saveContextId ||
      assessment.state !== "compatible_with_slot_import" ||
      assessment.recommendedStrategy !== "slot_import" ||
      preconditionHash(plan.target, plan.operations, plan.payloadPolicies) !== plan.preconditionStateHash
    ) {
      throw new NexusError("SAVE_TARGET_DRIFTED", "Slot-import Replacement Plan bindings changed or are stale.");
    }
    const [staged, slotPlan] = await Promise.all([
      this.#requireEldenRingSlots().verifyStage(plan.stagedImportId),
      this.#requireEldenRingSlots().getPlan(plan.slotImportPlanId, true),
    ]);
    if (
      staged.recordHash !== plan.stagedImportRecordHash ||
      staged.slotImportPlanId !== slotPlan.slotImportPlanId ||
      staged.planHash !== slotPlan.planHash ||
      slotPlan.planHash !== plan.slotImportPlanHash ||
      slotPlan.packageId !== plan.packageId ||
      slotPlan.saveContextId !== plan.saveContextId ||
      slotPlan.sourceSlot !== plan.sourceSlot ||
      slotPlan.targetSlot !== plan.targetSlot ||
      plan.operations.length !== 1 ||
      plan.operations[0]?.expectedPostState.kind !== "file" ||
      plan.operations[0].expectedPostState.sha256 !== staged.stagedSha256
    ) {
      throw new NexusError("SAVE_STAGING_INVALID", "Staged import evidence does not match the frozen Replacement Plan.");
    }
  }

  #assertAssessmentCurrent(
    assessment: SaveCompatibilityAssessment,
    manifestHash: string,
  ): void {
    if (
      assessment.packageManifestHash !== manifestHash ||
      assessment.state !== "compatible_direct" ||
      assessment.recommendedStrategy !== "direct_replace"
    ) {
      throw new NexusError("SAVE_PACKAGE_INVALID", "Compatibility Assessment is stale or not direct-compatible.");
    }
  }

  #requireEldenRingSlots(): EldenRingSlotImportService {
    if (!this.#eldenRingSlots) {
      throw new NexusError("SAVE_ADAPTER_UNSUPPORTED", "Elden Ring slot-import service is unavailable.");
    }
    return this.#eldenRingSlots;
  }

  #unit(context: SaveContext, unitId: string): SaveContext["saveUnits"][number] {
    const unit = context.saveUnits.find((candidate) => candidate.unitId === unitId);
    if (!unit) throw new NexusError("SAVE_CONTEXT_STALE", `Save Unit ${unitId} is unavailable.`);
    return unit;
  }

  #primaryRoot(context: SaveContext): SaveContext["saveRoots"][number] {
    const root = context.saveRoots.find((candidate) => candidate.role === "primary");
    if (!root) throw new NexusError("SAVE_CONTEXT_STALE", "Primary save root is unavailable.");
    return root;
  }

  async #checkpoint(
    checkpoint: SaveReplacementCheckpoint,
    plan: SaveReplacementPlan,
    transaction: SaveTransactionWriter,
    operationId?: string,
  ): Promise<void> {
    await this.#faultInjector?.checkpoint(checkpoint, {
      replacementPlanId: plan.replacementPlanId,
      transactionId: transaction.transactionId,
      ...(operationId === undefined ? {} : { operationId }),
    });
  }
}
