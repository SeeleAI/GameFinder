import { readdir } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import {
  type SaveOperationRecord,
  hashWithoutField,
  saveOperationRecordSchema,
} from "../contracts.js";
import {
  assertUuid,
  ensureRealStoreDirectory,
  publishJsonExclusive,
  readStoredJson,
} from "../storage/json-store.js";

export class SaveOperationRecordStore {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  static async create(managerRoot: string): Promise<SaveOperationRecordStore> {
    return new SaveOperationRecordStore(
      await ensureRealStoreDirectory(managerRoot, "records"),
    );
  }

  async save(
    record: SaveOperationRecord,
  ): Promise<Readonly<SaveOperationRecord>> {
    const parsed = saveOperationRecordSchema.parse(record);
    this.#verify(parsed);
    await publishJsonExclusive(this.#pathFor(parsed.recordId), parsed);
    return Object.freeze(parsed);
  }

  async get(recordId: string): Promise<Readonly<SaveOperationRecord>> {
    assertUuid(recordId, "recordId");
    const parsed = await readStoredJson(
      this.#pathFor(recordId),
      saveOperationRecordSchema,
      "Save Operation Record was not found.",
    );
    this.#verify(parsed);
    return Object.freeze(parsed);
  }

  async findByPlan(
    planId: string,
  ): Promise<Readonly<SaveOperationRecord> | null> {
    assertUuid(planId, "planId");
    for (const name of (await readdir(this.#root)).sort()) {
      const match = /^([0-9a-f-]{36})\.json$/i.exec(name);
      const recordId = match?.[1];
      if (!recordId) continue;
      const record = await this.get(recordId);
      if (record.planId === planId) return record;
    }
    return null;
  }

  #verify(record: SaveOperationRecord): void {
    const actualHash = hashWithoutField(record, "recordHash");
    if (actualHash !== record.recordHash) {
      throw new NexusError(
        "SAVE_STATIC_VERIFICATION_FAILED",
        "Save Operation Record hash verification failed.",
        { details: { recordId: record.recordId } },
      );
    }
  }

  #pathFor(recordId: string): string {
    return path.join(this.#root, `${recordId}.json`);
  }
}
