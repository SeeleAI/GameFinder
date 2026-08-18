import path from "node:path";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import type { EldenRingSaveAnalysis, EldenRingSlotImportPlan, EldenRingStagedImport } from "../contracts.js";
import {
  eldenRingSaveAnalysisSchema,
  eldenRingSlotImportPlanSchema,
  eldenRingStagedImportSchema,
} from "../contracts.js";
import { assertUuid, ensureRealStoreDirectory, publishJsonExclusive, readStoredJson } from "../storage/json-store.js";

export class EldenRingSlotImportStore {
  readonly #analysesRoot: string;
  readonly #plansRoot: string;
  readonly #recordsRoot: string;
  readonly stagingRoot: string;

  private constructor(analysesRoot: string, plansRoot: string, recordsRoot: string, stagingRoot: string) {
    this.#analysesRoot = analysesRoot;
    this.#plansRoot = plansRoot;
    this.#recordsRoot = recordsRoot;
    this.stagingRoot = stagingRoot;
  }

  static async create(managerRoot: string): Promise<EldenRingSlotImportStore> {
    const [analysesRoot, plansRoot, recordsRoot, stagingRoot] = await Promise.all([
      ensureRealStoreDirectory(managerRoot, "elden-ring", "analyses"),
      ensureRealStoreDirectory(managerRoot, "elden-ring", "slot-import-plans"),
      ensureRealStoreDirectory(managerRoot, "elden-ring", "staged-imports"),
      ensureRealStoreDirectory(managerRoot, "elden-ring", "staging"),
    ]);
    return new EldenRingSlotImportStore(analysesRoot, plansRoot, recordsRoot, stagingRoot);
  }

  async saveAnalysis(value: EldenRingSaveAnalysis): Promise<Readonly<EldenRingSaveAnalysis>> {
    const parsed = eldenRingSaveAnalysisSchema.parse(value);
    this.#verifyHash(parsed, "analysisHash");
    await publishJsonExclusive(path.join(this.#analysesRoot, `${parsed.analysisId}.json`), parsed);
    return Object.freeze(parsed);
  }

  async getAnalysis(id: string): Promise<Readonly<EldenRingSaveAnalysis>> {
    assertUuid(id, "analysisId");
    const value = await readStoredJson(path.join(this.#analysesRoot, `${id}.json`), eldenRingSaveAnalysisSchema, "Elden Ring save analysis was not found.");
    if (value.analysisId !== id) throw new NexusError("SAVE_STAGING_INVALID", "Analysis storage identity mismatch.");
    this.#verifyHash(value, "analysisHash");
    return Object.freeze(value);
  }

  async savePlan(value: EldenRingSlotImportPlan): Promise<Readonly<EldenRingSlotImportPlan>> {
    const parsed = eldenRingSlotImportPlanSchema.parse(value);
    this.#verifyHash(parsed, "planHash");
    await publishJsonExclusive(path.join(this.#plansRoot, `${parsed.slotImportPlanId}.json`), parsed);
    return Object.freeze(parsed);
  }

  async getPlan(id: string, allowExpired = false): Promise<Readonly<EldenRingSlotImportPlan>> {
    assertUuid(id, "slotImportPlanId");
    const value = await readStoredJson(path.join(this.#plansRoot, `${id}.json`), eldenRingSlotImportPlanSchema, "Elden Ring Slot Import Plan was not found.");
    if (value.slotImportPlanId !== id) throw new NexusError("SAVE_STAGING_INVALID", "Slot Import Plan storage identity mismatch.");
    this.#verifyHash(value, "planHash");
    if (!allowExpired && Date.parse(value.expiresAt) <= Date.now()) throw new NexusError("SAVE_PLAN_EXPIRED", "Elden Ring Slot Import Plan expired.");
    return Object.freeze(value);
  }

  async saveRecord(value: EldenRingStagedImport): Promise<Readonly<EldenRingStagedImport>> {
    const parsed = eldenRingStagedImportSchema.parse(value);
    this.#verifyHash(parsed, "recordHash");
    await publishJsonExclusive(path.join(this.#recordsRoot, `${parsed.stagedImportId}.json`), parsed);
    return Object.freeze(parsed);
  }

  async getRecord(id: string): Promise<Readonly<EldenRingStagedImport>> {
    assertUuid(id, "stagedImportId");
    const value = await readStoredJson(path.join(this.#recordsRoot, `${id}.json`), eldenRingStagedImportSchema, "Elden Ring staged import was not found.");
    if (value.stagedImportId !== id) throw new NexusError("SAVE_STAGING_INVALID", "Staged import storage identity mismatch.");
    this.#verifyHash(value, "recordHash");
    return Object.freeze(value);
  }

  #verifyHash(value: Record<string, unknown>, field: string): void {
    const payload = { ...value }; delete payload[field];
    if (value[field] !== sha256CanonicalJson(payload)) throw new NexusError("SAVE_STAGING_INVALID", `Elden Ring ${field} verification failed.`);
  }
}
