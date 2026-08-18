import path from "node:path";

import { NexusError } from "../../errors.js";
import type { SaveCompatibilityAssessment } from "../contracts.js";
import {
  hashWithoutField,
  saveCompatibilityAssessmentSchema,
} from "../contracts.js";
import {
  assertUuid,
  ensureRealStoreDirectory,
  publishJsonExclusive,
  readStoredJson,
} from "../storage/json-store.js";

export class SaveCompatibilityAssessmentStore {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  static async create(managerRoot: string): Promise<SaveCompatibilityAssessmentStore> {
    return new SaveCompatibilityAssessmentStore(
      await ensureRealStoreDirectory(managerRoot, "compatibility-assessments"),
    );
  }

  async save(
    assessment: SaveCompatibilityAssessment,
  ): Promise<Readonly<SaveCompatibilityAssessment>> {
    const parsed = saveCompatibilityAssessmentSchema.parse(assessment);
    this.#verify(parsed);
    await publishJsonExclusive(this.#pathFor(parsed.assessmentId), parsed);
    return Object.freeze(parsed);
  }

  async get(assessmentId: string): Promise<Readonly<SaveCompatibilityAssessment>> {
    assertUuid(assessmentId, "assessmentId");
    const parsed = await readStoredJson(
      this.#pathFor(assessmentId),
      saveCompatibilityAssessmentSchema,
      "Save Compatibility Assessment was not found.",
    );
    if (parsed.assessmentId !== assessmentId) {
      throw new NexusError("SAVE_PACKAGE_INVALID", "Compatibility Assessment identity mismatch.");
    }
    this.#verify(parsed);
    return Object.freeze(parsed);
  }

  #verify(assessment: SaveCompatibilityAssessment): void {
    if (hashWithoutField(assessment, "assessmentHash") !== assessment.assessmentHash) {
      throw new NexusError("SAVE_PACKAGE_INVALID", "Compatibility Assessment hash failed.");
    }
  }

  #pathFor(assessmentId: string): string {
    return path.join(this.#root, `${assessmentId}.json`);
  }
}
