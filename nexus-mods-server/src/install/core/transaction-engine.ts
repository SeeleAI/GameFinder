import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";

import { NexusError, asNexusError } from "../../errors.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type {
  GameInstance,
  GameProfile,
  InstallationRecord,
  InstallOperation,
  InstallPlan,
  OperationOutcome,
  PackageAnalysis,
  TransactionEntry,
  TransactionJournal,
  TransactionPhase,
} from "../contracts.js";
import { installationRecordSchema } from "../contracts.js";
import type { StagingManager } from "./staging-manager.js";
import type { PlanStore } from "../storage/plan-store.js";
import type { BackupStore } from "../storage/backup-store.js";
import type {
  TransactionJournalStore,
  TransactionJournalWriter,
} from "../storage/transaction-journal-store.js";
import type { InstallationRecordStore } from "../storage/installation-record-store.js";
import type { VerifiedInstallInput } from "../input-verifier.js";
import { InstanceLock } from "./instance-lock.js";
import {
  applyInstallOperation,
  rollbackInstallOperation,
  type AppliedInstallOperation,
} from "./operation-executor.js";
import { assertSensitiveProcessesStopped } from "./process-guard.js";
import { inspectInstallationState } from "./state-inspector.js";
import { inspectDirectoryTree, inspectPathState } from "./tree-state.js";
import { resolveManagedTarget } from "../path-policy.js";

export type TransactionCheckpoint =
  | "after_journal_created"
  | "after_lock_acquired"
  | "before_backup"
  | "after_backup"
  | "before_target_write"
  | "after_target_write"
  | "before_static_verify"
  | "after_static_verify"
  | "before_record_commit"
  | "after_record_commit";

export interface TransactionFaultInjector {
  checkpoint(
    checkpoint: TransactionCheckpoint,
    context: {
      transactionId: string;
      operationId?: string;
      backupId?: string;
    },
  ): Promise<void>;
}

export class SimulatedTransactionInterruption extends Error {
  constructor(message = "Simulated transaction process interruption.") {
    super(message);
    this.name = "SimulatedTransactionInterruption";
  }
}

export interface ApplyInstallResult {
  transactionId: string;
  record: InstallationRecord;
  journal: TransactionJournal;
  staticVerification: {
    state: "passed";
    summary: string;
    evidence: string[];
    warnings: string[];
  };
}

export interface TransactionEngineOptions {
  managerRoot: string;
  planStore: PlanStore;
  stagingManager: StagingManager;
  backupStore: BackupStore;
  journalStore: TransactionJournalStore;
  recordStore: InstallationRecordStore;
  adapterRegistry: AdapterRegistry;
  processGuard?: (
    processNames: ReadonlyArray<string>,
  ) => Promise<void>;
  faultInjector?: TransactionFaultInjector;
}

function pathStateEquals(
  left: OperationOutcome["postState"],
  right: OperationOutcome["postState"],
): boolean {
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

async function journalEvent(
  writer: TransactionJournalWriter,
  input: {
    phase: TransactionPhase;
    event: string;
    message: string;
    operationId?: string | null;
    preState?: TransactionEntry["preState"];
    postState?: TransactionEntry["postState"];
    backupId?: string | null;
  },
): Promise<void> {
  await writer.append({
    phase: input.phase,
    operationId: input.operationId ?? null,
    event: input.event,
    preState: input.preState ?? null,
    postState: input.postState ?? null,
    backupId: input.backupId ?? null,
    message: input.message,
  });
}

function backupForOperation(
  journal: TransactionJournal,
  operationId: string,
): string | null {
  const event = [...journal.entries]
    .reverse()
    .find(
      (entry) =>
        entry.operationId === operationId &&
        entry.event === "backup_created" &&
        entry.backupId !== null,
    );
  return event?.backupId ?? null;
}

function hasOperationIntent(
  journal: TransactionJournal,
  operationId: string,
): boolean {
  return journal.entries.some(
    (entry) =>
      entry.operationId === operationId &&
      entry.event === "operation_intent",
  );
}

async function removeTransactionTemporaryPaths(
  operation: InstallOperation,
  profile: GameProfile,
  instance: GameInstance,
): Promise<void> {
  const resolved = resolveManagedTarget({
    gameRoot: instance.gameRoot,
    targetRelativePath: operation.targetRelativePath,
    writableRoots: profile.filesystem.writableRoots,
    protectedRoots: profile.filesystem.protectedRoots,
  });
  const parent = path.dirname(resolved.targetAbsolutePath);
  const basename = path.basename(resolved.targetAbsolutePath);
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (
      name.startsWith(`${basename}.`) &&
      (name.endsWith(".installing") || name.endsWith(".restore"))
    ) {
      await rm(path.join(parent, name), { recursive: true, force: true });
    }
  }
}

export async function rollbackInstallJournal(input: {
  plan: InstallPlan;
  journal: TransactionJournal;
  writer: TransactionJournalWriter;
  profile: GameProfile;
  instance: GameInstance;
  backupStore: BackupStore;
}): Promise<void> {
  await input.writer.setState("rolling_back");
  await journalEvent(input.writer, {
    phase: "rolling_back",
    event: "rollback_started",
    message: "Rolling back the incomplete install transaction.",
  });

  for (const operation of [...input.plan.operations].reverse()) {
    if (!hasOperationIntent(input.journal, operation.operationId)) continue;
    await removeTransactionTemporaryPaths(
      operation,
      input.profile,
      input.instance,
    );
    const resolved = resolveManagedTarget({
      gameRoot: input.instance.gameRoot,
      targetRelativePath: operation.targetRelativePath,
      writableRoots: input.profile.filesystem.writableRoots,
      protectedRoots: input.profile.filesystem.protectedRoots,
    });
    const currentState = await inspectPathState(resolved.targetAbsolutePath);
    const backupId = backupForOperation(
      input.journal,
      operation.operationId,
    );

    if (pathStateEquals(currentState, operation.expectedPreState)) {
      await journalEvent(input.writer, {
        phase: "rolling_back",
        operationId: operation.operationId,
        event: "rollback_not_needed",
        preState: currentState,
        postState: currentState,
        message: "The operation target is already at its pre-state.",
      });
      continue;
    }

    if (
      currentState.kind === "absent" &&
      (operation.kind === "replace_file" ||
        operation.kind === "replace_managed_tree") &&
      backupId
    ) {
      if (operation.kind === "replace_file") {
        await input.backupStore.restoreFile(
          backupId,
          resolved.targetAbsolutePath,
        );
      } else {
        await input.backupStore.restoreTree(
          backupId,
          resolved.targetAbsolutePath,
        );
      }
      await journalEvent(input.writer, {
        phase: "rolling_back",
        operationId: operation.operationId,
        event: "operation_rolled_back",
        preState: currentState,
        postState: operation.expectedPreState,
        backupId,
        message: "Restored a preimage after an interrupted replacement.",
      });
      continue;
    }

    if (!pathStateEquals(currentState, operation.expectedPostState)) {
      throw new NexusError(
        "ROLLBACK_FAILED",
        "Recovery found an operation target in an unknown state.",
        {
          details: {
            operationId: operation.operationId,
            expectedPreState: operation.expectedPreState,
            expectedPostState: operation.expectedPostState,
            actualState: currentState,
          },
        },
      );
    }
    const applied: AppliedInstallOperation = {
      operation,
      outcome: {
        operationId: operation.operationId,
        operationKind: operation.kind,
        targetRelativePath: operation.targetRelativePath,
        outcome: "applied",
        preState: operation.expectedPreState,
        postState: operation.expectedPostState,
        ownershipMode:
          operation.kind === "install_tree" ||
          operation.kind === "replace_managed_tree"
            ? operation.ownershipMode
            : "none",
        ownedFiles: [],
        ownedDirectories: [],
        backupId,
        previousOwnerInstallationId:
          operation.kind === "replace_managed_tree"
            ? operation.previousOwnerInstallationId
            : null,
      },
    };
    await rollbackInstallOperation({
      applied,
      profile: input.profile,
      instance: input.instance,
      backupStore: input.backupStore,
    });
    await journalEvent(input.writer, {
      phase: "rolling_back",
      operationId: operation.operationId,
      event: "operation_rolled_back",
      preState: operation.expectedPostState,
      postState: operation.expectedPreState,
      backupId,
      message: "Restored the operation pre-state.",
    });
  }

  await journalEvent(input.writer, {
    phase: "rolled_back",
    event: "rollback_completed",
    message: "All applied operations were rolled back.",
  });
  await input.writer.setState("rolled_back", { completed: true });
}

export class TransactionEngine {
  readonly #managerRoot: string;
  readonly #planStore: PlanStore;
  readonly #stagingManager: StagingManager;
  readonly #backupStore: BackupStore;
  readonly #journalStore: TransactionJournalStore;
  readonly #recordStore: InstallationRecordStore;
  readonly #adapterRegistry: AdapterRegistry;
  readonly #processGuard: (
    processNames: ReadonlyArray<string>,
  ) => Promise<void>;
  readonly #faultInjector: TransactionFaultInjector | undefined;

  constructor(options: TransactionEngineOptions) {
    if (!path.isAbsolute(options.managerRoot)) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Transaction Engine managerRoot must be absolute.",
      );
    }
    this.#managerRoot = path.resolve(options.managerRoot);
    this.#planStore = options.planStore;
    this.#stagingManager = options.stagingManager;
    this.#backupStore = options.backupStore;
    this.#journalStore = options.journalStore;
    this.#recordStore = options.recordStore;
    this.#adapterRegistry = options.adapterRegistry;
    this.#processGuard =
      options.processGuard ?? assertSensitiveProcessesStopped;
    this.#faultInjector = options.faultInjector;
  }

  async applyInstallPlan(input: {
    planId: string;
    profile: GameProfile;
    instance: GameInstance;
    analysis: PackageAnalysis;
    packageUnitId: string;
    verifiedInput: VerifiedInstallInput;
  }): Promise<ApplyInstallResult> {
    const plan = await this.#planStore.get(input.planId);
    if (
      plan.gameInstanceId !== input.instance.instanceId ||
      plan.gameProfileId !== input.profile.profileId ||
      plan.gameProfileVersion !== input.profile.profileVersion ||
      plan.analysisId !== input.analysis.analysisId ||
      plan.analysisHash !== input.analysis.analysisHash ||
      plan.archive.sha256 !== input.verifiedInput.archive.sha256
    ) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Install Plan execution inputs do not match the frozen plan.",
      );
    }
    const packageUnit = input.analysis.packages.find(
      (unit) => unit.packageUnitId === input.packageUnitId,
    );
    if (!packageUnit || packageUnit.packageRoot !== plan.staging.packageRoot) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "The selected package unit does not match the frozen Install Plan.",
      );
    }

    await this.#processGuard(
      input.profile.runtime.lockSensitiveProcessNames,
    );
    const transactionId = randomUUID();
    const writer = await this.#journalStore.createJournal({
      transactionKind: "install",
      planId: plan.planId,
      gameInstanceId: input.instance.instanceId,
      transactionId,
    });
    await this.#checkpoint("after_journal_created", transactionId);
    const lock = new InstanceLock({
      locksRoot: path.join(this.#managerRoot, "locks"),
      instanceId: input.instance.instanceId,
      transactionId,
    });
    let recordSaved = false;
    let prospectiveRecord: InstallationRecord | null = null;
    try {
      await writer.setState("preflight");
      await this.#planStore.assertPreconditions({
        plan,
        profile: input.profile,
        instance: input.instance,
      });
      await lock.acquire();
      await writer.setState("locked");
      await journalEvent(writer, {
        phase: "locked",
        event: "instance_lock_acquired",
        message: "Acquired the game-instance transaction lock.",
      });
      await this.#checkpoint("after_lock_acquired", transactionId);

      const stagingRoot = this.#stagingManager.resolveStagingRoot(
        plan.staging.stagingId,
      );
      const packageAbsolutePath =
        plan.staging.packageRoot === "."
          ? stagingRoot
          : path.resolve(
              stagingRoot,
              ...plan.staging.packageRoot.split("/"),
            );
      const stagedTree = await inspectDirectoryTree(packageAbsolutePath);
      if (stagedTree.treeHash !== plan.staging.sourceTreeHash) {
        throw new NexusError(
          "PLAN_STALE",
          "The frozen staging tree changed before apply.",
        );
      }
      await writer.setState("staging");
      await journalEvent(writer, {
        phase: "staging",
        event: "staging_verified",
        message: "Verified the frozen staging tree.",
      });

      const outcomes: OperationOutcome[] = [];
      await writer.setState("applying");
      for (const operation of plan.operations) {
        await journalEvent(writer, {
          phase: "applying",
          operationId: operation.operationId,
          event: "operation_intent",
          preState: operation.expectedPreState,
          postState: operation.expectedPostState,
          message: `Preparing ${operation.kind}.`,
        });
        const applied = await applyInstallOperation({
          operation,
          profile: input.profile,
          instance: input.instance,
          stagingRoot,
          backupStore: this.#backupStore,
          hooks: {
            beforeBackup: async () => {
              await writer.setState("backing_up");
              await this.#checkpoint(
                "before_backup",
                transactionId,
                operation.operationId,
              );
            },
            afterBackup: async (_operation, backupId) => {
              await journalEvent(writer, {
                phase: "backing_up",
                operationId: operation.operationId,
                event: "backup_created",
                backupId,
                message: "Created and verified the operation preimage backup.",
              });
              await this.#checkpoint(
                "after_backup",
                transactionId,
                operation.operationId,
                backupId,
              );
              await writer.setState("applying");
            },
            beforeTargetWrite: async () => {
              await this.#checkpoint(
                "before_target_write",
                transactionId,
                operation.operationId,
              );
            },
            afterTargetWrite: async () => {
              await journalEvent(writer, {
                phase: "applying",
                operationId: operation.operationId,
                event: "target_written",
                preState: operation.expectedPreState,
                postState: operation.expectedPostState,
                backupId: backupForOperation(
                  await writer.snapshot(),
                  operation.operationId,
                ),
                message: "The target write completed; post-state verification is pending.",
              });
              await this.#checkpoint(
                "after_target_write",
                transactionId,
                operation.operationId,
              );
            },
          },
        });
        outcomes.push(applied.outcome);
        await journalEvent(writer, {
          phase: "applying",
          operationId: operation.operationId,
          event: "operation_applied",
          preState: applied.outcome.preState,
          postState: applied.outcome.postState,
          backupId: applied.outcome.backupId,
          message: `${operation.kind} produced its verified post-state.`,
        });
      }

      await this.#checkpoint("before_static_verify", transactionId);
      await writer.setState("static_verifying");
      const now = new Date().toISOString();
      prospectiveRecord = installationRecordSchema.parse({
        schemaVersion: 1,
        installationId: randomUUID(),
        revision: 1,
        state: "runtime_unverified",
        transactionId,
        sourcePlanId: plan.planId,
        sourcePlanHash: plan.planHash,
        gameInstanceId: input.instance.instanceId,
        gameProfileId: input.profile.profileId,
        gameProfileVersion: input.profile.profileVersion,
        adapterId: plan.adapterId,
        adapterVersion: plan.adapterVersion,
        archive: plan.archive,
        nexus: {
          domainName: input.verifiedInput.source.domainName,
          modId: input.verifiedInput.source.modId,
          fileId: input.verifiedInput.source.fileId,
          receiptPath: input.verifiedInput.receipt.receiptPath,
        },
        packageSummary: {
          analysisHash: input.analysis.analysisHash,
          packageUnitId: packageUnit.packageUnitId,
          packageRoot: packageUnit.packageRoot,
          identity: packageUnit.identity,
        },
        operationOutcomes: outcomes,
        staticVerification: "passed",
        runtimeVerification: "not-run",
        installedAt: now,
        updatedAt: now,
        uninstallTransactionId: null,
      });
      const inspection = await inspectInstallationState({
        record: prospectiveRecord,
        profile: input.profile,
        instance: input.instance,
      });
      if (inspection.blocking) {
        throw new NexusError(
          "VERIFY_FAILED",
          "Generic post-state verification found blocking differences.",
          { details: { inspection } },
        );
      }
      const adapter = this.#adapterRegistry.get(plan.adapterId);
      const adapterVerification = await adapter.verifyStatic(
        prospectiveRecord,
        inspection,
        input.profile,
        input.instance,
      );
      if (adapterVerification.state !== "passed") {
        throw new NexusError(
          "VERIFY_FAILED",
          "Adapter static verification did not pass.",
          { details: { adapterVerification } },
        );
      }
      await journalEvent(writer, {
        phase: "static_verifying",
        event: "static_verification_passed",
        message: adapterVerification.summary,
      });
      await this.#checkpoint("after_static_verify", transactionId);

      await this.#checkpoint("before_record_commit", transactionId);
      await this.#recordStore.saveNew(prospectiveRecord);
      recordSaved = true;
      await this.#checkpoint("after_record_commit", transactionId);
      await journalEvent(writer, {
        phase: "committed",
        event: "installation_record_committed",
        message: `Committed Installation Record ${prospectiveRecord.installationId}.`,
      });
      await writer.setState("committed", { completed: true });
      await this.#stagingManager
        .cleanup(plan.staging.stagingId)
        .catch(() => undefined);
      return {
        transactionId,
        record: prospectiveRecord,
        journal: await writer.snapshot(),
        staticVerification: {
          state: "passed",
          summary: adapterVerification.summary,
          evidence: adapterVerification.evidence,
          warnings: adapterVerification.warnings,
        },
      };
    } catch (error) {
      if (error instanceof SimulatedTransactionInterruption) throw error;
      if (recordSaved && prospectiveRecord) {
        await writer.setState("recovery_required", { completed: true }).catch(
          () => undefined,
        );
        throw new NexusError(
          "RECOVERY_REQUIRED",
          "Installation Record committed, but transaction finalization was interrupted.",
          {
            cause: error,
            details: {
              transactionId,
              installationId: prospectiveRecord.installationId,
            },
          },
        );
      }
      const nexusError = asNexusError(error);
      await writer
        .setState(
          nexusError.code === "VERIFY_FAILED"
            ? "verification_failed"
            : "apply_failed",
        )
        .catch(() => undefined);
      try {
        await rollbackInstallJournal({
          plan,
          journal: await writer.snapshot(),
          writer,
          profile: input.profile,
          instance: input.instance,
          backupStore: this.#backupStore,
        });
      } catch (rollbackError) {
        await writer
          .setState("recovery_required", { completed: true })
          .catch(() => undefined);
        throw new NexusError(
          "ROLLBACK_FAILED",
          "Install failed and automatic rollback could not restore the pre-state.",
          {
            cause: rollbackError,
            details: {
              transactionId,
              originalError: {
                code: nexusError.code,
                message: nexusError.message,
              },
            },
          },
        );
      }
      throw new NexusError(
        nexusError.code === "VERIFY_FAILED" ? "VERIFY_FAILED" : "APPLY_FAILED",
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

  async #checkpoint(
    checkpoint: TransactionCheckpoint,
    transactionId: string,
    operationId?: string,
    backupId?: string,
  ): Promise<void> {
    if (!this.#faultInjector) return;
    await this.#faultInjector.checkpoint(checkpoint, {
      transactionId,
      ...(operationId === undefined ? {} : { operationId }),
      ...(backupId === undefined ? {} : { backupId }),
    });
  }
}
