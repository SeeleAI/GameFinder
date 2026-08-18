import { randomUUID } from "node:crypto";
import path from "node:path";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import type { SaveReplacementPlan } from "../contracts.js";
import { saveReplacementPlanSchema } from "../contracts.js";
import {
  assertUuid,
  ensureRealStoreDirectory,
  publishJsonExclusive,
  readStoredJson,
} from "../storage/json-store.js";

export type SaveReplacementPlanDraft = Omit<
  SaveReplacementPlan,
  | "schemaVersion"
  | "replacementPlanId"
  | "status"
  | "createdAt"
  | "expiresAt"
  | "planHash"
>;

export class SaveReplacementPlanStore {
  readonly #root: string;
  readonly #defaultTtlMs: number;

  private constructor(root: string, defaultTtlMs: number) {
    this.#root = root;
    this.#defaultTtlMs = defaultTtlMs;
  }

  static async create(options: {
    managerRoot: string;
    defaultTtlMs?: number;
  }): Promise<SaveReplacementPlanStore> {
    return new SaveReplacementPlanStore(
      await ensureRealStoreDirectory(options.managerRoot, "replacement-plans"),
      options.defaultTtlMs ?? 30 * 60_000,
    );
  }

  async save(draft: SaveReplacementPlanDraft): Promise<Readonly<SaveReplacementPlan>> {
    const now = new Date();
    const withoutHash = {
      schemaVersion: 1 as const,
      replacementPlanId: randomUUID(),
      status: "planned" as const,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#defaultTtlMs).toISOString(),
      ...draft,
    };
    const plan = saveReplacementPlanSchema.parse({
      ...withoutHash,
      planHash: sha256CanonicalJson(withoutHash),
    });
    await publishJsonExclusive(this.#pathFor(plan.replacementPlanId), plan);
    return Object.freeze(plan);
  }

  async get(
    replacementPlanId: string,
    options: { allowExpired?: boolean } = {},
  ): Promise<Readonly<SaveReplacementPlan>> {
    assertUuid(replacementPlanId, "replacementPlanId");
    const plan = await readStoredJson(
      this.#pathFor(replacementPlanId),
      saveReplacementPlanSchema,
      "Save Replacement Plan was not found.",
    );
    const { planHash: _hash, ...payload } = plan;
    if (
      plan.replacementPlanId !== replacementPlanId ||
      sha256CanonicalJson(payload) !== plan.planHash
    ) {
      throw new NexusError("SAVE_TARGET_DRIFTED", "Save Replacement Plan hash failed.");
    }
    if (!options.allowExpired && Date.parse(plan.expiresAt) <= Date.now()) {
      throw new NexusError("SAVE_PLAN_EXPIRED", "Save Replacement Plan expired.");
    }
    return Object.freeze(plan);
  }

  #pathFor(replacementPlanId: string): string {
    return path.join(this.#root, `${replacementPlanId}.json`);
  }
}
