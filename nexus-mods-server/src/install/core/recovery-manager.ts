import path from "node:path";

import { NexusError } from "../../errors.js";
import type { GameInstance, GameProfile } from "../contracts.js";
import type { BackupStore } from "../storage/backup-store.js";
import type { InstallationRecordStore } from "../storage/installation-record-store.js";
import type { PlanStore } from "../storage/plan-store.js";
import type { TransactionJournalStore } from "../storage/transaction-journal-store.js";
import type { UninstallPlanStore } from "../storage/uninstall-plan-store.js";
import { InstanceLock } from "./instance-lock.js";
import { rollbackInstallJournal } from "./transaction-engine.js";
import { rollbackUninstallJournal } from "./uninstall-engine.js";

export interface RecoveryResult {
  transactionId: string;
  action: "completed_commit" | "rolled_back" | "already_terminal";
  installationId: string | null;
}

export class RecoveryManager {
  readonly #managerRoot: string;
  readonly #planStore: PlanStore;
  readonly #backupStore: BackupStore;
  readonly #journalStore: TransactionJournalStore;
  readonly #recordStore: InstallationRecordStore;
  readonly #uninstallPlanStore: UninstallPlanStore | undefined;

  constructor(input: {
    managerRoot: string;
    planStore: PlanStore;
    backupStore: BackupStore;
    journalStore: TransactionJournalStore;
    recordStore: InstallationRecordStore;
    uninstallPlanStore?: UninstallPlanStore;
  }) {
    this.#managerRoot = path.resolve(input.managerRoot);
    this.#planStore = input.planStore;
    this.#backupStore = input.backupStore;
    this.#journalStore = input.journalStore;
    this.#recordStore = input.recordStore;
    this.#uninstallPlanStore = input.uninstallPlanStore;
  }

  async recoverUninstall(input: {
    transactionId: string;
    profile: GameProfile;
    instance: GameInstance;
  }): Promise<RecoveryResult> {
    const journal = await this.#journalStore.read(input.transactionId);
    if (journal.transactionKind !== "uninstall") {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "This recovery path only handles uninstall transactions.",
      );
    }
    if (["uninstalled", "installed_restored"].includes(journal.state)) {
      return {
        transactionId: journal.transactionId,
        action: "already_terminal",
        installationId:
          (
            await this.#recordStore.findByTransaction(
              journal.gameInstanceId,
              journal.transactionId,
            )
          )?.installationId ?? null,
      };
    }
    if (!this.#uninstallPlanStore) {
      throw new NexusError(
        "RECOVERY_REQUIRED",
        "Uninstall recovery requires the Uninstall Plan Store.",
      );
    }
    const writer = await this.#journalStore.openJournal(journal.transactionId);
    const committedRecord = await this.#recordStore.findByTransaction(
      journal.gameInstanceId,
      journal.transactionId,
    );
    if (committedRecord) {
      await writer.append({
        phase: "uninstalled",
        operationId: null,
        event: "recovery_completed_uninstall_commit",
        preState: null,
        postState: null,
        backupId: null,
        message:
          "Recovery found the committed uninstall Record revision and finalized the journal.",
      });
      await writer.setState("uninstalled", { completed: true });
      return {
        transactionId: journal.transactionId,
        action: "completed_commit",
        installationId: committedRecord.installationId,
      };
    }

    const plan = await this.#uninstallPlanStore.get(journal.planId, {
      allowExpired: true,
    });
    const lock = new InstanceLock({
      locksRoot: path.join(this.#managerRoot, "locks"),
      instanceId: input.instance.instanceId,
      transactionId: journal.transactionId,
    });
    await lock.acquire();
    try {
      await rollbackUninstallJournal({
        plan,
        journal,
        writer,
        profile: input.profile,
        instance: input.instance,
        backupStore: this.#backupStore,
      });
      return {
        transactionId: journal.transactionId,
        action: "rolled_back",
        installationId: plan.installationId,
      };
    } catch (error) {
      await writer.setState("recovery_required", { completed: true });
      throw new NexusError(
        "RECOVERY_REQUIRED",
        "Automatic uninstall recovery could not restore the installed state.",
        { cause: error, details: { transactionId: journal.transactionId } },
      );
    } finally {
      await lock.release();
    }
  }

  async recoverInstall(input: {
    transactionId: string;
    profile: GameProfile;
    instance: GameInstance;
  }): Promise<RecoveryResult> {
    const journal = await this.#journalStore.read(input.transactionId);
    if (journal.transactionKind !== "install") {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "This recovery path only handles install transactions.",
      );
    }
    if (
      ["committed", "rolled_back", "preflight_failed"].includes(journal.state)
    ) {
      return {
        transactionId: journal.transactionId,
        action: "already_terminal",
        installationId:
          (
            await this.#recordStore.findByTransaction(
              journal.gameInstanceId,
              journal.transactionId,
            )
          )?.installationId ?? null,
      };
    }
    if (journal.gameInstanceId !== input.instance.instanceId) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Recovery Game Instance does not match the transaction journal.",
      );
    }

    const writer = await this.#journalStore.openJournal(journal.transactionId);
    const committedRecord = await this.#recordStore.findByTransaction(
      journal.gameInstanceId,
      journal.transactionId,
    );
    if (committedRecord) {
      await writer.append({
        phase: "committed",
        operationId: null,
        event: "recovery_completed_commit",
        preState: null,
        postState: null,
        backupId: null,
        message:
          "Recovery found the committed Installation Record and finalized the journal.",
      });
      await writer.setState("committed", { completed: true });
      return {
        transactionId: journal.transactionId,
        action: "completed_commit",
        installationId: committedRecord.installationId,
      };
    }

    const plan = await this.#planStore.get(journal.planId, {
      allowExpired: true,
    });
    const lock = new InstanceLock({
      locksRoot: path.join(this.#managerRoot, "locks"),
      instanceId: input.instance.instanceId,
      transactionId: journal.transactionId,
    });
    await lock.acquire();
    try {
      await rollbackInstallJournal({
        plan,
        journal,
        writer,
        profile: input.profile,
        instance: input.instance,
        backupStore: this.#backupStore,
      });
      return {
        transactionId: journal.transactionId,
        action: "rolled_back",
        installationId: null,
      };
    } catch (error) {
      await writer.setState("recovery_required", { completed: true });
      throw new NexusError(
        "RECOVERY_REQUIRED",
        "Automatic recovery could not prove and restore the transaction pre-state.",
        { cause: error, details: { transactionId: journal.transactionId } },
      );
    } finally {
      await lock.release();
    }
  }

  async recoverAllTransactions(input: {
    profilesById: ReadonlyMap<string, GameProfile>;
    instancesById: ReadonlyMap<string, GameInstance>;
  }): Promise<ReadonlyArray<RecoveryResult>> {
    const incomplete = await this.#journalStore.listIncomplete();
    const results: RecoveryResult[] = [];
    for (const journal of incomplete) {
      const instance = input.instancesById.get(journal.gameInstanceId);
      if (!instance) {
        throw new NexusError(
          "RECOVERY_REQUIRED",
          "An incomplete transaction references an unavailable Game Instance.",
          { details: { transactionId: journal.transactionId } },
        );
      }
      const profile = input.profilesById.get(instance.profileId);
      if (!profile) {
        throw new NexusError(
          "RECOVERY_REQUIRED",
          "An incomplete transaction references an unavailable Game Profile.",
          { details: { transactionId: journal.transactionId } },
        );
      }
      results.push(
        journal.transactionKind === "uninstall"
          ? await this.recoverUninstall({
              transactionId: journal.transactionId,
              profile,
              instance,
            })
          : await this.recoverInstall({
              transactionId: journal.transactionId,
              profile,
              instance,
            }),
      );
    }
    return results;
  }

  async recoverAllInstallTransactions(input: {
    profilesById: ReadonlyMap<string, GameProfile>;
    instancesById: ReadonlyMap<string, GameInstance>;
  }): Promise<ReadonlyArray<RecoveryResult>> {
    return await this.recoverAllTransactions(input);
  }
}
