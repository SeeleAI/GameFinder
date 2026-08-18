import { readdir } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import {
  type SaveBackupRecord,
  hashWithoutField,
  saveBackupRecordSchema,
} from "../contracts.js";
import {
  assertUuid,
  ensureRealStoreDirectory,
  publishJsonExclusive,
  readStoredJson,
} from "../storage/json-store.js";

export class SaveBackupRecordStore {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  static async create(managerRoot: string): Promise<SaveBackupRecordStore> {
    return new SaveBackupRecordStore(
      await ensureRealStoreDirectory(managerRoot, "backups", "records"),
    );
  }

  async save(
    record: SaveBackupRecord,
  ): Promise<Readonly<SaveBackupRecord>> {
    const parsed = saveBackupRecordSchema.parse(record);
    this.#verifyHash(parsed);
    await publishJsonExclusive(this.#pathFor(parsed.backupId), parsed);
    return Object.freeze(parsed);
  }

  async get(backupId: string): Promise<Readonly<SaveBackupRecord>> {
    assertUuid(backupId, "backupId");
    const parsed = await readStoredJson(
      this.#pathFor(backupId),
      saveBackupRecordSchema,
      "Save Backup Record was not found.",
    );
    if (parsed.backupId !== backupId) {
      throw new NexusError(
        "SAVE_BACKUP_INVALID",
        "Save Backup Record identity does not match its storage key.",
        { details: { backupId, storedBackupId: parsed.backupId } },
      );
    }
    this.#verifyHash(parsed);
    return Object.freeze(parsed);
  }

  async list(
    saveContextId?: string,
  ): Promise<ReadonlyArray<Readonly<SaveBackupRecord>>> {
    if (saveContextId !== undefined) {
      assertUuid(saveContextId, "saveContextId");
    }
    const records: SaveBackupRecord[] = [];
    for (const name of (await readdir(this.#root)).sort()) {
      const match = /^([0-9a-f-]{36})\.json$/i.exec(name);
      const backupId = match?.[1];
      if (!backupId) continue;
      const record = await this.get(backupId);
      if (
        saveContextId === undefined ||
        record.saveContextId === saveContextId
      ) {
        records.push(record);
      }
    }
    return records.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }

  #verifyHash(record: SaveBackupRecord): void {
    const actualHash = hashWithoutField(record, "backupRecordHash");
    if (actualHash !== record.backupRecordHash) {
      throw new NexusError(
        "SAVE_BACKUP_INVALID",
        "Save Backup Record hash verification failed.",
        {
          details: {
            backupId: record.backupId,
            expectedHash: record.backupRecordHash,
            actualHash,
          },
        },
      );
    }
  }

  #pathFor(backupId: string): string {
    return path.join(this.#root, `${backupId}.json`);
  }
}
