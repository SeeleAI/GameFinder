import path from "node:path";

import { NexusError } from "../../errors.js";
import { ensureRealStoreDirectory, publishJsonExclusive, readStoredJson } from "../storage/json-store.js";
import type { AdapterRequirementAssessment } from "../v2/contracts.js";
import {
  adapterRequirementAssessmentSchema,
  verifyAdapterRequirementAssessmentHash,
} from "../v2/contracts.js";

export class AdapterRequirementAssessmentStore {
  private constructor(private readonly root: string) {}

  static async create(managerRoot: string): Promise<AdapterRequirementAssessmentStore> {
    return new AdapterRequirementAssessmentStore(
      await ensureRealStoreDirectory(managerRoot, "adapter-requirement-assessments"),
    );
  }

  async save(value: AdapterRequirementAssessment): Promise<Readonly<AdapterRequirementAssessment>> {
    const parsed = adapterRequirementAssessmentSchema.parse(value);
    if (!verifyAdapterRequirementAssessmentHash(parsed)) {
      throw new NexusError("SAVE_CONTRACT_INVALID", "Adapter Requirement Assessment hash verification failed.");
    }
    await publishJsonExclusive(path.join(this.root, `${parsed.assessmentId}.json`), parsed);
    return Object.freeze(parsed);
  }

  async get(assessmentId: string): Promise<Readonly<AdapterRequirementAssessment>> {
    const parsed = await readStoredJson(
      path.join(this.root, `${assessmentId}.json`),
      adapterRequirementAssessmentSchema,
      "Adapter Requirement Assessment was not found.",
    );
    if (parsed.assessmentId !== assessmentId || !verifyAdapterRequirementAssessmentHash(parsed)) {
      throw new NexusError("SAVE_CONTEXT_STALE", "Stored Adapter Requirement Assessment is stale.");
    }
    return Object.freeze(parsed);
  }
}
