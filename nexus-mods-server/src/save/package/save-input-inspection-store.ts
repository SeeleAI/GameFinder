import path from "node:path";

import { NexusError } from "../../errors.js";
import {
  hashWithoutField,
  type SaveInputInspection,
  saveInputInspectionSchema,
} from "../contracts.js";
import {
  assertUuid,
  ensureRealStoreDirectory,
  publishJsonExclusive,
  readStoredJson,
} from "../storage/json-store.js";

export class SaveInputInspectionStore {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  static async create(managerRoot: string): Promise<SaveInputInspectionStore> {
    return new SaveInputInspectionStore(
      await ensureRealStoreDirectory(managerRoot, "input-inspections"),
    );
  }

  async save(
    inspection: SaveInputInspection,
  ): Promise<Readonly<SaveInputInspection>> {
    const parsed = saveInputInspectionSchema.parse(inspection);
    this.#verify(parsed);
    await publishJsonExclusive(this.#pathFor(parsed.inspectionId), parsed);
    return Object.freeze(parsed);
  }

  async get(inspectionId: string): Promise<Readonly<SaveInputInspection>> {
    assertUuid(inspectionId, "inspectionId");
    const parsed = await readStoredJson(
      this.#pathFor(inspectionId),
      saveInputInspectionSchema,
      "Save Input Inspection was not found.",
    );
    if (parsed.inspectionId !== inspectionId) {
      throw new NexusError(
        "SAVE_PACKAGE_INVALID",
        "Save Input Inspection identity does not match its storage key.",
      );
    }
    this.#verify(parsed);
    return Object.freeze(parsed);
  }

  #verify(inspection: SaveInputInspection): void {
    const actualHash = hashWithoutField(inspection, "inspectionHash");
    if (actualHash !== inspection.inspectionHash) {
      throw new NexusError(
        "SAVE_PACKAGE_INVALID",
        "Save Input Inspection hash verification failed.",
        { details: { inspectionId: inspection.inspectionId } },
      );
    }
  }

  #pathFor(inspectionId: string): string {
    return path.join(this.#root, `${inspectionId}.json`);
  }
}
