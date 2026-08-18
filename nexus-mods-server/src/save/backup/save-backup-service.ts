import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import { assertSensitiveProcessesStopped } from "../../install/core/process-guard.js";
import { inspectPathState } from "../../install/core/tree-state.js";
import { BackupStore } from "../../install/storage/backup-store.js";
import type {
  GameSaveProfile,
  SaveBackupRecord,
  SaveContext,
} from "../contracts.js";
import { saveBackupRecordSchema } from "../contracts.js";
import {
  assertNoSaveReparsePointTraversal,
  resolveSaveTarget,
} from "../path-policy.js";
import type { GameSaveProfileRegistry } from "../profiles/registry.js";
import type { SaveContextStore } from "../storage/context-store.js";
import { SaveBackupRecordStore } from "./save-backup-record-store.js";

export type SaveBackupCheckpoint =
  | "before_source_snapshot"
  | "after_source_snapshot"
  | "after_object_backup"
  | "before_record_publish";

export interface SaveBackupFaultInjector {
  checkpoint(
    checkpoint: SaveBackupCheckpoint,
    context: {
      saveContextId: string;
      unitId: string;
      attempt: number;
      relativePath?: string;
    },
  ): Promise<void>;
}

export interface SaveBackupServiceOptions {
  managerRoot: string;
  contexts: SaveContextStore;
  profiles: GameSaveProfileRegistry;
  processGuard?: (processNames: ReadonlyArray<string>) => Promise<void>;
  faultInjector?: SaveBackupFaultInjector;
}

interface ManagedUnitPath {
  relativePath: string;
  role: "essential" | "companion" | "auxiliary";
  required: boolean;
}

function unitPaths(
  unit: SaveContext["saveUnits"][number],
): ManagedUnitPath[] {
  const result = new Map<string, ManagedUnitPath>();
  for (const relativePath of unit.essential) {
    result.set(relativePath.toLowerCase(), {
      relativePath,
      role: "essential",
      required: true,
    });
  }
  for (const relativePath of unit.companions) {
    result.set(relativePath.toLowerCase(), {
      relativePath,
      role: "companion",
      required: false,
    });
  }
  for (const relativePath of unit.auxiliary) {
    result.set(relativePath.toLowerCase(), {
      relativePath,
      role: "auxiliary",
      required: false,
    });
  }
  return [...result.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

async function snapshotManagedState(input: {
  context: SaveContext;
  root: SaveContext["saveRoots"][number];
  unit: SaveContext["saveUnits"][number];
}): Promise<{
  stateHash: string;
  states: Array<{
    relativePath: string;
    state: Awaited<ReturnType<typeof inspectPathState>>;
  }>;
}> {
  const states = [];
  for (const relativePath of input.unit.managedPaths) {
    const resolved = resolveSaveTarget({
      saveRoot: input.root.absolutePath,
      targetRelativePath: relativePath,
      managedPaths: input.unit.managedPaths,
    });
    await assertNoSaveReparsePointTraversal(
      resolved.saveRoot,
      resolved.targetAbsolutePath,
    );
    states.push({
      relativePath: resolved.targetRelativePath,
      state: await inspectPathState(resolved.targetAbsolutePath),
    });
  }
  states.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  return {
    states,
    stateHash: sha256CanonicalJson(states),
  };
}

export class SaveBackupService {
  readonly #contexts: SaveContextStore;
  readonly #profiles: GameSaveProfileRegistry;
  readonly #objects: BackupStore;
  readonly #records: SaveBackupRecordStore;
  readonly #processGuard: (
    processNames: ReadonlyArray<string>,
  ) => Promise<void>;
  readonly #faultInjector: SaveBackupFaultInjector | undefined;

  private constructor(input: {
    contexts: SaveContextStore;
    profiles: GameSaveProfileRegistry;
    objects: BackupStore;
    records: SaveBackupRecordStore;
    processGuard: (processNames: ReadonlyArray<string>) => Promise<void>;
    faultInjector?: SaveBackupFaultInjector;
  }) {
    this.#contexts = input.contexts;
    this.#profiles = input.profiles;
    this.#objects = input.objects;
    this.#records = input.records;
    this.#processGuard = input.processGuard;
    this.#faultInjector = input.faultInjector;
  }

  static async create(
    options: SaveBackupServiceOptions,
  ): Promise<SaveBackupService> {
    const [objects, records] = await Promise.all([
      BackupStore.create(path.join(options.managerRoot, "save-manager")),
      SaveBackupRecordStore.create(options.managerRoot),
    ]);
    return new SaveBackupService({
      contexts: options.contexts,
      profiles: options.profiles,
      objects,
      records,
      processGuard:
        options.processGuard ?? assertSensitiveProcessesStopped,
      ...(options.faultInjector === undefined
        ? {}
        : { faultInjector: options.faultInjector }),
    });
  }

  async createBackup(input: {
    saveContextId: string;
    unitId: string;
    reason: SaveBackupRecord["reason"];
  }): Promise<Readonly<SaveBackupRecord>> {
    const context = await this.#contexts.getSaveContext(input.saveContextId);
    const unit = context.saveUnits.find(
      (candidate) => candidate.unitId === input.unitId,
    );
    if (!unit) {
      throw new NexusError(
        "SAVE_BACKUP_INVALID",
        "The requested Save Unit is not declared by the Save Context.",
        { details: { saveContextId: input.saveContextId, unitId: input.unitId } },
      );
    }
    const root = context.saveRoots.find((candidate) => candidate.role === "primary");
    if (!root) {
      throw new NexusError(
        "SAVE_BACKUP_INVALID",
        "The Save Context has no primary save root.",
      );
    }
    const profile = this.#profileFor(context);
    await this.#guardProcesses(profile);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await this.#faultInjector?.checkpoint("before_source_snapshot", {
        saveContextId: context.saveContextId,
        unitId: unit.unitId,
        attempt,
      });
      const pre = await snapshotManagedState({ context, root, unit });
      await this.#faultInjector?.checkpoint("after_source_snapshot", {
        saveContextId: context.saveContextId,
        unitId: unit.unitId,
        attempt,
      });
      const files: SaveBackupRecord["files"] = [];
      for (const declared of unitPaths(unit)) {
        const resolved = resolveSaveTarget({
          saveRoot: root.absolutePath,
          targetRelativePath: declared.relativePath,
          managedPaths: unit.managedPaths,
        });
        const info = await stat(resolved.targetAbsolutePath).catch(
          (error: unknown) => {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            ) {
              return null;
            }
            throw error;
          },
        );
        if (!info) {
          if (declared.required) {
            throw new NexusError(
              "SAVE_BACKUP_INVALID",
              "An essential save file is missing.",
              { details: { relativePath: declared.relativePath } },
            );
          }
          continue;
        }
        if (!info.isFile()) {
          throw new NexusError(
            "SAVE_BACKUP_INVALID",
            "Save Unit entries must be regular files in M2.",
            { details: { relativePath: declared.relativePath } },
          );
        }
        const object = await this.#objects.backupFile(
          resolved.targetAbsolutePath,
        );
        files.push({
          relativePath: declared.relativePath,
          role: declared.role,
          backupObjectId: object.backupId,
          bytes: object.bytes,
          sha256: object.sha256,
          modifiedAt: info.mtime.toISOString(),
          attributes: [],
        });
        await this.#faultInjector?.checkpoint("after_object_backup", {
          saveContextId: context.saveContextId,
          unitId: unit.unitId,
          attempt,
          relativePath: declared.relativePath,
        });
      }
      const post = await snapshotManagedState({ context, root, unit });
      if (pre.stateHash !== post.stateHash) {
        if (attempt < 2) continue;
        throw new NexusError(
          "SAVE_SOURCE_CHANGED_DURING_BACKUP",
          "The Save Unit changed while it was being backed up.",
          {
            retryable: true,
            details: {
              saveContextId: context.saveContextId,
              unitId: unit.unitId,
              preStateHash: pre.stateHash,
              postStateHash: post.stateHash,
            },
          },
        );
      }
      if (files.length === 0) {
        throw new NexusError(
          "SAVE_BACKUP_INVALID",
          "The Save Unit contains no files to back up.",
        );
      }
      files.sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath),
      );
      await this.#faultInjector?.checkpoint("before_record_publish", {
        saveContextId: context.saveContextId,
        unitId: unit.unitId,
        attempt,
      });
      const withoutHash = {
        schemaVersion: 1 as const,
        backupId: randomUUID(),
        saveContextId: context.saveContextId,
        unitId: unit.unitId,
        reason: input.reason,
        sourceRoot: root.absolutePath,
        files,
        treeHash: sha256CanonicalJson(
          files.map(({ relativePath, bytes, sha256 }) => ({
            relativePath,
            bytes,
            sha256,
          })),
        ),
        sourcePreStateHash: pre.stateHash,
        sourcePostStateHash: post.stateHash,
        profileId: context.profile.profileId,
        profileVersion: context.profile.profileVersion,
        adapterId: context.format.adapterId,
        createdAt: new Date().toISOString(),
        integrity: "verified" as const,
      };
      const record = await this.#records.save(
        saveBackupRecordSchema.parse({
          ...withoutHash,
          backupRecordHash: sha256CanonicalJson(withoutHash),
        }),
      );
      await this.verifyBackup(record.backupId);
      return record;
    }
    throw new NexusError(
      "SAVE_SOURCE_CHANGED_DURING_BACKUP",
      "The Save Unit could not be captured consistently.",
    );
  }

  async getBackup(backupId: string): Promise<Readonly<SaveBackupRecord>> {
    return await this.#records.get(backupId);
  }

  async listBackups(
    saveContextId?: string,
  ): Promise<ReadonlyArray<Readonly<SaveBackupRecord>>> {
    return await this.#records.list(saveContextId);
  }

  async verifyBackup(
    backupId: string,
  ): Promise<Readonly<SaveBackupRecord>> {
    const record = await this.#records.get(backupId);
    for (const file of record.files) {
      const object = await this.#objects.get(file.backupObjectId).catch(
        (error: unknown) => {
          throw new NexusError(
            "SAVE_BACKUP_INVALID",
            "A content object referenced by the Save Backup is missing or corrupt.",
            {
              cause: error,
              details: {
                backupId,
                backupObjectId: file.backupObjectId,
                relativePath: file.relativePath,
              },
            },
          );
        },
      );
      if (
        object.objectKind !== "file" ||
        object.bytes !== file.bytes ||
        object.sha256 !== file.sha256
      ) {
        throw new NexusError(
          "SAVE_BACKUP_INVALID",
          "A Save Backup content object does not match its record.",
          { details: { backupId, relativePath: file.relativePath } },
        );
      }
    }
    const actualTreeHash = sha256CanonicalJson(
      record.files.map(({ relativePath, bytes, sha256 }) => ({
        relativePath,
        bytes,
        sha256,
      })),
    );
    if (actualTreeHash !== record.treeHash) {
      throw new NexusError(
        "SAVE_BACKUP_INVALID",
        "Save Backup tree hash verification failed.",
        { details: { backupId, actualTreeHash, expectedTreeHash: record.treeHash } },
      );
    }
    return record;
  }

  get objectStore(): BackupStore {
    return this.#objects;
  }

  async #guardProcesses(profile: GameSaveProfile | null): Promise<void> {
    try {
      await this.#processGuard(
        profile?.runtime.lockSensitiveProcessNames ?? [],
      );
    } catch (error) {
      if (error instanceof NexusError && error.code === "GAME_PROCESS_RUNNING") {
        throw new NexusError(
          "SAVE_PROCESS_RUNNING",
          "A game or platform process may be writing this Save Unit.",
          {
            cause: error,
            retryable: true,
            ...(error.details === undefined
              ? {}
              : { details: error.details }),
          },
        );
      }
      throw error;
    }
  }

  #profileFor(context: SaveContext): GameSaveProfile | null {
    if (context.profile.source !== "built-in") return null;
    const profile = this.#profiles.findById(context.profile.profileId);
    if (!profile || profile.profileVersion !== context.profile.profileVersion) {
      throw new NexusError(
        "SAVE_CONTEXT_STALE",
        "The Save Context profile is unavailable or changed.",
        { details: { profile: context.profile } },
      );
    }
    return profile;
  }
}
