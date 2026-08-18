import { randomUUID } from "node:crypto";
import path from "node:path";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import type { SaveRuntimeVerificationRecord } from "../contracts.js";
import {
  hashWithoutField,
  saveRuntimeVerificationRecordSchema,
} from "../contracts.js";
import { SaveOperationRecordStore } from "../restore/save-operation-record-store.js";
import {
  assertUuid,
  ensureRealStoreDirectory,
  publishJsonExclusive,
  readStoredJson,
} from "../storage/json-store.js";

export class SaveRuntimeVerificationService {
  readonly #operations: SaveOperationRecordStore;
  readonly #root: string;

  private constructor(operations: SaveOperationRecordStore, root: string) {
    this.#operations = operations;
    this.#root = root;
  }

  static async create(managerRoot: string): Promise<SaveRuntimeVerificationService> {
    const [operations, root] = await Promise.all([
      SaveOperationRecordStore.create(managerRoot),
      ensureRealStoreDirectory(managerRoot, "runtime-verifications"),
    ]);
    return new SaveRuntimeVerificationService(operations, root);
  }

  async record(input: {
    operationRecordId: string;
    outcome: SaveRuntimeVerificationRecord["outcome"];
    notes?: string;
  }): Promise<Readonly<SaveRuntimeVerificationRecord>> {
    await this.#operations.get(input.operationRecordId);
    const withoutHash = {
      schemaVersion: 1 as const,
      verificationId: randomUUID(),
      operationRecordId: input.operationRecordId,
      outcome: input.outcome,
      notes: input.notes?.trim() || null,
      observedAt: new Date().toISOString(),
    };
    const record = saveRuntimeVerificationRecordSchema.parse({
      ...withoutHash,
      verificationHash: sha256CanonicalJson(withoutHash),
    });
    await publishJsonExclusive(this.#pathFor(record.verificationId), record);
    return Object.freeze(record);
  }

  async get(verificationId: string): Promise<Readonly<SaveRuntimeVerificationRecord>> {
    assertUuid(verificationId, "verificationId");
    const record = await readStoredJson(
      this.#pathFor(verificationId),
      saveRuntimeVerificationRecordSchema,
      "Save Runtime Verification Record was not found.",
    );
    if (
      record.verificationId !== verificationId ||
      hashWithoutField(record, "verificationHash") !== record.verificationHash
    ) {
      throw new NexusError(
        "SAVE_RUNTIME_VERIFICATION_FAILED",
        "Save Runtime Verification Record hash failed.",
      );
    }
    return Object.freeze(record);
  }

  #pathFor(verificationId: string): string {
    return path.join(this.#root, `${verificationId}.json`);
  }
}
