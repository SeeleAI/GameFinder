import { randomUUID } from "node:crypto";
import { mkdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";

import { NexusError, asNexusError } from "../../errors.js";
import type {
  GameInstance,
  GameProfile,
  InstallationRecord,
  PathState,
  UninstallAction,
  UninstallPlan,
  TransactionJournal,
} from "../contracts.js";
import type { BackupStore } from "../storage/backup-store.js";
import type { InstallationRecordStore } from "../storage/installation-record-store.js";
import type { TransactionJournalStore } from "../storage/transaction-journal-store.js";
import type { TransactionJournalWriter } from "../storage/transaction-journal-store.js";
import type { UninstallPlanStore } from "../storage/uninstall-plan-store.js";
import {
  normalizeManagedRelativePath,
  resolveManagedTarget,
} from "../path-policy.js";
import { InstanceLock } from "./instance-lock.js";
import { assertSensitiveProcessesStopped } from "./process-guard.js";
import { inspectInstallationState } from "./state-inspector.js";
import { inspectDirectoryTree, inspectPathState } from "./tree-state.js";
import type {
  TransactionFaultInjector,
  TransactionCheckpoint,
} from "./transaction-engine.js";
import { SimulatedTransactionInterruption } from "./transaction-engine.js";

interface AppliedUninstallAction {
  action: UninstallAction;
  backupId: string | null;
  applied: boolean;
  retained: boolean;
}

export interface ApplyUninstallResult {
  transactionId: string;
  record: InstallationRecord;
  retainedPaths: ReadonlyArray<string>;
  retainedFilePaths: ReadonlyArray<string>;
}

function stateEquals(left: PathState, right: PathState): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "absent" || right.kind === "absent") return true;
  if (left.kind === "file" && right.kind === "file") {
    return left.bytes === right.bytes && left.sha256 === right.sha256;
  }
  if (left.kind === "directory" && right.kind === "directory") {
    return left.treeHash === right.treeHash;
  }
  return false;
}

async function collectRetainedFilePaths(input: {
  retainedPaths: ReadonlyArray<string>;
  profile: GameProfile;
  instance: GameInstance;
}): Promise<string[]> {
  const retainedFilePaths: string[] = [];
  for (const retainedPath of input.retainedPaths) {
    const target = resolveManagedTarget({
      gameRoot: input.instance.gameRoot,
      targetRelativePath: retainedPath,
      writableRoots: input.profile.filesystem.writableRoots,
      protectedRoots: input.profile.filesystem.protectedRoots,
    });
    const state = await inspectPathState(target.targetAbsolutePath);
    if (state.kind === "file") {
      retainedFilePaths.push(target.targetRelativePath);
      continue;
    }
    if (state.kind !== "directory") continue;
    const tree = await inspectDirectoryTree(target.targetAbsolutePath);
    retainedFilePaths.push(
      ...tree.files.map((file) =>
        normalizeManagedRelativePath(
          path.posix.join(target.targetRelativePath, file.relativePath),
        ),
      ),
    );
  }
  return [...new Set(retainedFilePaths)].sort((left, right) =>
    left.localeCompare(right),
  );
}

function rollbackBackupForAction(
  journal: TransactionJournal,
  actionId: string,
): string | null {
  return (
    [...journal.entries]
      .reverse()
      .find(
        (entry) =>
          entry.operationId === actionId &&
          entry.event === "backup_created" &&
          entry.backupId !== null,
      )?.backupId ?? null
  );
}

export async function rollbackUninstallJournal(input: {
  plan: UninstallPlan;
  journal: TransactionJournal;
  writer: TransactionJournalWriter;
  profile: GameProfile;
  instance: GameInstance;
  backupStore: BackupStore;
}): Promise<void> {
  await input.writer.setState("rolling_back_uninstall");
  for (const action of [...input.plan.actions].reverse()) {
    const intentExists = input.journal.entries.some(
      (entry) =>
        entry.operationId === action.actionId &&
        entry.event === "uninstall_action_intent",
    );
    if (!intentExists) continue;
    const resolved = resolveManagedTarget({
      gameRoot: input.instance.gameRoot,
      targetRelativePath: action.targetRelativePath,
      writableRoots: input.profile.filesystem.writableRoots,
      protectedRoots: input.profile.filesystem.protectedRoots,
    });
    const current = await inspectPathState(resolved.targetAbsolutePath);
    const rollbackBackupId = rollbackBackupForAction(
      input.journal,
      action.actionId,
    );

    switch (action.kind) {
      case "delete_owned_file":
        if (stateEquals(current, action.expectedCurrentState)) break;
        if (current.kind !== "absent" || !rollbackBackupId) {
          throw new NexusError(
            "RECOVERY_REQUIRED",
            "Cannot recover an interrupted owned-file deletion.",
            { details: { actionId: action.actionId, current } },
          );
        }
        await input.backupStore.restoreFile(
          rollbackBackupId,
          resolved.targetAbsolutePath,
        );
        break;
      case "remove_empty_directory":
        if (current.kind === "absent") {
          await mkdir(resolved.targetAbsolutePath, { recursive: false });
        } else if (current.kind !== "directory") {
          throw new NexusError(
            "RECOVERY_REQUIRED",
            "Cannot recover an interrupted directory removal.",
          );
        }
        break;
      case "ensure_directory":
        if (current.kind === "directory") {
          await rmdir(resolved.targetAbsolutePath);
        } else if (current.kind !== "absent") {
          throw new NexusError(
            "RECOVERY_REQUIRED",
            "Cannot recover an interrupted directory recreation.",
          );
        }
        break;
      case "restore_backup":
        if (stateEquals(current, action.expectedCurrentState)) break;
        if (!rollbackBackupId) {
          throw new NexusError(
            "RECOVERY_REQUIRED",
            "Cannot recover an interrupted file preimage restoration.",
          );
        }
        if (current.kind !== "absent") {
          await rm(resolved.targetAbsolutePath, { force: false });
        }
        await input.backupStore.restoreFile(
          rollbackBackupId,
          resolved.targetAbsolutePath,
        );
        break;
      case "restore_managed_tree":
        if (stateEquals(current, action.expectedCurrentState)) break;
        if (!rollbackBackupId) {
          throw new NexusError(
            "RECOVERY_REQUIRED",
            "Cannot recover an interrupted tree preimage restoration.",
          );
        }
        if (current.kind !== "absent") {
          await rm(resolved.targetAbsolutePath, {
            recursive: true,
            force: false,
          });
        }
        await input.backupStore.restoreTree(
          rollbackBackupId,
          resolved.targetAbsolutePath,
        );
        break;
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
    await input.writer.append({
      phase: "rolling_back_uninstall",
      operationId: action.actionId,
      event: "uninstall_action_rolled_back",
      preState: current,
      postState:
        "expectedCurrentState" in action
          ? action.expectedCurrentState
          : null,
      backupId: rollbackBackupId,
      message: "Recovery restored the pre-uninstall state.",
    });
  }
  await input.writer.setState("installed_restored", { completed: true });
}

export class UninstallEngine {
  readonly #managerRoot: string;
  readonly #planStore: UninstallPlanStore;
  readonly #backupStore: BackupStore;
  readonly #journalStore: TransactionJournalStore;
  readonly #recordStore: InstallationRecordStore;
  readonly #processGuard: (
    processNames: ReadonlyArray<string>,
  ) => Promise<void>;
  readonly #faultInjector: TransactionFaultInjector | undefined;

  constructor(input: {
    managerRoot: string;
    planStore: UninstallPlanStore;
    backupStore: BackupStore;
    journalStore: TransactionJournalStore;
    recordStore: InstallationRecordStore;
    processGuard?: (
      processNames: ReadonlyArray<string>,
    ) => Promise<void>;
    faultInjector?: TransactionFaultInjector;
  }) {
    this.#managerRoot = path.resolve(input.managerRoot);
    this.#planStore = input.planStore;
    this.#backupStore = input.backupStore;
    this.#journalStore = input.journalStore;
    this.#recordStore = input.recordStore;
    this.#processGuard =
      input.processGuard ?? assertSensitiveProcessesStopped;
    this.#faultInjector = input.faultInjector;
  }

  async applyUninstallPlan(input: {
    uninstallPlanId: string;
    profile: GameProfile;
    instance: GameInstance;
  }): Promise<ApplyUninstallResult> {
    const plan = await this.#planStore.get(input.uninstallPlanId);
    const record = await this.#recordStore.get(plan.installationId);
    if (
      record.revision !== plan.installationRevision ||
      record.gameInstanceId !== input.instance.instanceId ||
      record.gameProfileId !== input.profile.profileId
    ) {
      throw new NexusError(
        "PLAN_STALE",
        "Installation Record changed after the Uninstall Plan was created.",
      );
    }
    const currentInspection = await inspectInstallationState({
      record,
      profile: input.profile,
      instance: input.instance,
    });
    if (
      currentInspection.blocking ||
      currentInspection.stateHash !== plan.inspectionStateHash
    ) {
      throw new NexusError(
        "INSTALLATION_DIRTY",
        "Managed files changed after Uninstall Plan creation.",
        { details: { currentInspection } },
      );
    }

    await this.#processGuard(
      input.profile.runtime.lockSensitiveProcessNames,
    );
    const transactionId = randomUUID();
    const writer = await this.#journalStore.createJournal({
      transactionKind: "uninstall",
      planId: plan.uninstallPlanId,
      gameInstanceId: input.instance.instanceId,
      transactionId,
    });
    const lock = new InstanceLock({
      locksRoot: path.join(this.#managerRoot, "locks"),
      instanceId: input.instance.instanceId,
      transactionId,
    });
    const applied: AppliedUninstallAction[] = [];
    let recordSaved = false;
    try {
      await writer.setState("uninstall_planned");
      await lock.acquire();
      await writer.setState("applying_inverse");
      for (const action of plan.actions) {
        await writer.append({
          phase: "applying_inverse",
          operationId: action.actionId,
          event: "uninstall_action_intent",
          preState:
            "expectedCurrentState" in action
              ? action.expectedCurrentState
              : null,
          postState: null,
          backupId: null,
          message: `Preparing ${action.kind}.`,
        });
        const result = await this.#applyAction({
          action,
          profile: input.profile,
          instance: input.instance,
          transactionId,
          onBackup: async (backupId) => {
            await writer.append({
              phase: "backing_up_current_dirty_state",
              operationId: action.actionId,
              event: "backup_created",
              preState:
                "expectedCurrentState" in action
                  ? action.expectedCurrentState
                  : null,
              postState: null,
              backupId,
              message:
                "Created a rollback backup before applying an Uninstall Action.",
            });
          },
        });
        applied.push(result);
        await writer.append({
          phase: "applying_inverse",
          operationId: action.actionId,
          event: result.retained
            ? "uninstall_path_retained"
            : "uninstall_action_applied",
          preState:
            "expectedCurrentState" in action
              ? action.expectedCurrentState
              : null,
          postState: await this.#actionCurrentState(
            action,
            input.profile,
            input.instance,
          ),
          backupId: result.backupId,
          message: result.retained
            ? "Directory was retained because it contains unowned data."
            : `${action.kind} completed.`,
        });
        if (result.applied) {
          await this.#checkpoint(
            "after_target_write",
            transactionId,
            action.actionId,
            result.backupId ?? undefined,
          );
        }
      }

      await writer.setState("verifying_absence_or_restore");
      for (const result of applied) {
        if (result.retained || !result.applied) continue;
        const current = await this.#actionCurrentState(
          result.action,
          input.profile,
          input.instance,
        );
        if (
          result.action.kind === "delete_owned_file" &&
          current.kind !== "absent"
        ) {
          throw new NexusError(
            "VERIFY_FAILED",
            "An owned file remains after uninstall.",
          );
        }
      }

      const retainedPaths = [
        ...new Set([
          ...plan.retainedPaths,
          ...applied
            .filter((result) => result.retained)
            .map((result) => result.action.targetRelativePath),
        ]),
      ];
      const retainedFilePaths = await collectRetainedFilePaths({
        retainedPaths,
        profile: input.profile,
        instance: input.instance,
      });
      const now = new Date().toISOString();
      const updated: InstallationRecord = {
        ...record,
        revision: record.revision + 1,
        state:
          retainedPaths.length > 0
            ? "uninstalled_with_retained_data"
            : "uninstalled",
        updatedAt: now,
        uninstallTransactionId: transactionId,
      };
      await this.#recordStore.update(updated);
      recordSaved = true;
      await writer.append({
        phase: "uninstalled",
        operationId: null,
        event: "uninstall_record_committed",
        preState: null,
        postState: null,
        backupId: null,
        message: `Committed Installation Record revision ${updated.revision}.`,
      });
      await writer.setState("uninstalled", { completed: true });
      return {
        transactionId,
        record: updated,
        retainedPaths,
        retainedFilePaths,
      };
    } catch (error) {
      if (error instanceof SimulatedTransactionInterruption) throw error;
      if (recordSaved) {
        throw new NexusError(
          "RECOVERY_REQUIRED",
          "Uninstall committed, but journal finalization was interrupted.",
          { cause: error, details: { transactionId } },
        );
      }
      await writer.setState("uninstall_failed").catch(() => undefined);
      try {
        await writer.setState("rolling_back_uninstall");
        for (const result of [...applied].reverse()) {
          await this.#rollbackAction(
            result,
            input.profile,
            input.instance,
          );
          await writer.append({
            phase: "rolling_back_uninstall",
            operationId: result.action.actionId,
            event: "uninstall_action_rolled_back",
            preState: null,
            postState: null,
            backupId: result.backupId,
            message: "Restored the pre-uninstall state.",
          });
        }
        await writer.setState("installed_restored", { completed: true });
      } catch (rollbackError) {
        await writer.setState("recovery_required", { completed: true });
        throw new NexusError(
          "ROLLBACK_FAILED",
          "Uninstall failed and its rollback could not restore the installed state.",
          { cause: rollbackError, details: { transactionId } },
        );
      }
      const nexusError = asNexusError(error);
      throw new NexusError(
        "UNINSTALL_BLOCKED",
        nexusError.message,
        {
          cause: nexusError,
          details: {
            transactionId,
            rolledBack: true,
            originalCode: nexusError.code,
          },
        },
      );
    } finally {
      await lock.release();
    }
  }

  async #applyAction(input: {
    action: UninstallAction;
    profile: GameProfile;
    instance: GameInstance;
    transactionId: string;
    onBackup: (backupId: string) => Promise<void>;
  }): Promise<AppliedUninstallAction> {
    const resolved = resolveManagedTarget({
      gameRoot: input.instance.gameRoot,
      targetRelativePath: input.action.targetRelativePath,
      writableRoots: input.profile.filesystem.writableRoots,
      protectedRoots: input.profile.filesystem.protectedRoots,
    });
    const current = await inspectPathState(resolved.targetAbsolutePath);
    let backupId: string | null = null;

    if ("expectedCurrentState" in input.action) {
      if (!stateEquals(current, input.action.expectedCurrentState)) {
        throw new NexusError(
          "PLAN_STALE",
          "An Uninstall Action target changed after planning.",
          {
            details: {
              actionId: input.action.actionId,
              expected: input.action.expectedCurrentState,
              actual: current,
            },
          },
        );
      }
    }

    switch (input.action.kind) {
      case "delete_owned_file": {
        await this.#checkpoint(
          "before_backup",
          input.transactionId,
          input.action.actionId,
        );
        const backup = await this.#backupStore.backupFile(
          resolved.targetAbsolutePath,
        );
        backupId = backup.backupId;
        await input.onBackup(backupId);
        await this.#checkpoint(
          "after_backup",
          input.transactionId,
          input.action.actionId,
          backupId,
        );
        await this.#checkpoint(
          "before_target_write",
          input.transactionId,
          input.action.actionId,
        );
        await rm(resolved.targetAbsolutePath, { force: false });
        return { action: input.action, backupId, applied: true, retained: false };
      }
      case "remove_empty_directory":
        if (current.kind === "absent") {
          return {
            action: input.action,
            backupId: null,
            applied: false,
            retained: false,
          };
        }
        if (current.kind !== "directory") {
          throw new NexusError(
            "INSTALLATION_DIRTY",
            "A planned empty directory is no longer a directory.",
          );
        }
        try {
          await this.#checkpoint(
            "before_target_write",
            input.transactionId,
            input.action.actionId,
          );
          await rmdir(resolved.targetAbsolutePath);
          return {
            action: input.action,
            backupId: null,
            applied: true,
            retained: false,
          };
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            (error.code === "ENOTEMPTY" || error.code === "EEXIST")
          ) {
            return {
              action: input.action,
              backupId: null,
              applied: false,
              retained: true,
            };
          }
          throw error;
        }
      case "ensure_directory":
        if (current.kind === "directory") {
          return {
            action: input.action,
            backupId: null,
            applied: false,
            retained: false,
          };
        }
        if (current.kind !== "absent") {
          throw new NexusError(
            "INSTALLATION_DIRTY",
            "A directory restore target is occupied by a file.",
          );
        }
        await this.#checkpoint(
          "before_target_write",
          input.transactionId,
          input.action.actionId,
        );
        await mkdir(resolved.targetAbsolutePath, { recursive: false });
        return { action: input.action, backupId: null, applied: true, retained: false };
      case "restore_backup": {
        await this.#checkpoint(
          "before_backup",
          input.transactionId,
          input.action.actionId,
        );
        const currentBackup = await this.#backupStore.backupFile(
          resolved.targetAbsolutePath,
        );
        backupId = currentBackup.backupId;
        await input.onBackup(backupId);
        await this.#checkpoint(
          "after_backup",
          input.transactionId,
          input.action.actionId,
          backupId,
        );
        await this.#checkpoint(
          "before_target_write",
          input.transactionId,
          input.action.actionId,
        );
        await rm(resolved.targetAbsolutePath, { force: false });
        await this.#backupStore.restoreFile(
          input.action.backupId,
          resolved.targetAbsolutePath,
        );
        return { action: input.action, backupId, applied: true, retained: false };
      }
      case "restore_managed_tree": {
        await this.#checkpoint(
          "before_backup",
          input.transactionId,
          input.action.actionId,
        );
        const currentBackup = await this.#backupStore.backupTree(
          resolved.targetAbsolutePath,
        );
        backupId = currentBackup.backupId;
        await input.onBackup(backupId);
        await this.#checkpoint(
          "after_backup",
          input.transactionId,
          input.action.actionId,
          backupId,
        );
        await this.#checkpoint(
          "before_target_write",
          input.transactionId,
          input.action.actionId,
        );
        await rm(resolved.targetAbsolutePath, {
          recursive: true,
          force: false,
        });
        await this.#backupStore.restoreTree(
          input.action.backupId,
          resolved.targetAbsolutePath,
        );
        return { action: input.action, backupId, applied: true, retained: false };
      }
      default: {
        const exhaustive: never = input.action;
        return exhaustive;
      }
    }
  }

  async #rollbackAction(
    result: AppliedUninstallAction,
    profile: GameProfile,
    instance: GameInstance,
  ): Promise<void> {
    if (!result.applied) return;
    const resolved = resolveManagedTarget({
      gameRoot: instance.gameRoot,
      targetRelativePath: result.action.targetRelativePath,
      writableRoots: profile.filesystem.writableRoots,
      protectedRoots: profile.filesystem.protectedRoots,
    });
    switch (result.action.kind) {
      case "delete_owned_file":
        if (!result.backupId) throw new Error("Missing uninstall rollback backup.");
        await this.#backupStore.restoreFile(
          result.backupId,
          resolved.targetAbsolutePath,
        );
        return;
      case "remove_empty_directory":
        await mkdir(resolved.targetAbsolutePath, { recursive: false });
        return;
      case "ensure_directory":
        await rmdir(resolved.targetAbsolutePath);
        return;
      case "restore_backup":
        if (!result.backupId) throw new Error("Missing uninstall rollback backup.");
        await rm(resolved.targetAbsolutePath, { force: false });
        await this.#backupStore.restoreFile(
          result.backupId,
          resolved.targetAbsolutePath,
        );
        return;
      case "restore_managed_tree":
        if (!result.backupId) throw new Error("Missing uninstall rollback backup.");
        await rm(resolved.targetAbsolutePath, {
          recursive: true,
          force: false,
        });
        await this.#backupStore.restoreTree(
          result.backupId,
          resolved.targetAbsolutePath,
        );
        return;
      default: {
        const exhaustive: never = result.action;
        return exhaustive;
      }
    }
  }

  async #actionCurrentState(
    action: UninstallAction,
    profile: GameProfile,
    instance: GameInstance,
  ): Promise<PathState> {
    const resolved = resolveManagedTarget({
      gameRoot: instance.gameRoot,
      targetRelativePath: action.targetRelativePath,
      writableRoots: profile.filesystem.writableRoots,
      protectedRoots: profile.filesystem.protectedRoots,
    });
    return await inspectPathState(resolved.targetAbsolutePath);
  }

  async #checkpoint(
    checkpoint: TransactionCheckpoint,
    transactionId: string,
    operationId?: string,
    backupId?: string,
  ): Promise<void> {
    await this.#faultInjector?.checkpoint(checkpoint, {
      transactionId,
      ...(operationId === undefined ? {} : { operationId }),
      ...(backupId === undefined ? {} : { backupId }),
    });
  }
}
