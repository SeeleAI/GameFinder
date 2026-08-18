import { randomUUID } from "node:crypto";
import path from "node:path";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import type { SaveRestorePlan } from "../contracts.js";
import { saveRestorePlanSchema } from "../contracts.js";
import {
  assertUuid,
  ensureRealStoreDirectory,
  publishJsonExclusive,
  readStoredJson,
} from "../storage/json-store.js";

export type SaveRestorePlanDraft = Omit<
  SaveRestorePlan,
  | "schemaVersion"
  | "restorePlanId"
  | "status"
  | "createdAt"
  | "expiresAt"
  | "planHash"
>;

export class SaveRestorePlanStore {
  readonly #root: string;
  readonly #defaultTtlMs: number;

  private constructor(root: string, defaultTtlMs: number) {
    this.#root = root;
    this.#defaultTtlMs = defaultTtlMs;
  }

  static async create(options: {
    managerRoot: string;
    defaultTtlMs?: number;
  }): Promise<SaveRestorePlanStore> {
    const ttl = options.defaultTtlMs ?? 30 * 60_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 24 * 60 * 60_000) {
      throw new NexusError(
        "SAVE_CONTRACT_INVALID",
        "Restore Plan TTL must be between one second and 24 hours.",
      );
    }
    return new SaveRestorePlanStore(
      await ensureRealStoreDirectory(options.managerRoot, "restore-plans"),
      ttl,
    );
  }

  async save(
    draft: SaveRestorePlanDraft,
    options: { now?: Date; ttlMs?: number } = {},
  ): Promise<Readonly<SaveRestorePlan>> {
    const now = options.now ?? new Date();
    const ttl = options.ttlMs ?? this.#defaultTtlMs;
    if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 24 * 60 * 60_000) {
      throw new NexusError(
        "SAVE_CONTRACT_INVALID",
        "Restore Plan TTL must be between one second and 24 hours.",
      );
    }
    const withoutHash = {
      schemaVersion: 1 as const,
      restorePlanId: randomUUID(),
      status: "planned" as const,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
      ...draft,
    };
    const plan = saveRestorePlanSchema.parse({
      ...withoutHash,
      planHash: sha256CanonicalJson(withoutHash),
    });
    await publishJsonExclusive(this.#pathFor(plan.restorePlanId), plan);
    return Object.freeze(plan);
  }

  async get(
    restorePlanId: string,
    options: { allowExpired?: boolean; now?: Date } = {},
  ): Promise<Readonly<SaveRestorePlan>> {
    assertUuid(restorePlanId, "restorePlanId");
    const plan = await readStoredJson(
      this.#pathFor(restorePlanId),
      saveRestorePlanSchema,
      "Save Restore Plan was not found.",
    );
    if (plan.restorePlanId !== restorePlanId) {
      throw new NexusError(
        "SAVE_TARGET_DRIFTED",
        "Save Restore Plan identity does not match its storage key.",
      );
    }
    const { planHash: _hash, ...payload } = plan;
    const actualHash = sha256CanonicalJson(payload);
    if (actualHash !== plan.planHash) {
      throw new NexusError(
        "SAVE_TARGET_DRIFTED",
        "Save Restore Plan content changed after it was frozen.",
        { details: { restorePlanId, actualHash, expectedHash: plan.planHash } },
      );
    }
    if (
      !options.allowExpired &&
      Date.parse(plan.expiresAt) <= (options.now ?? new Date()).getTime()
    ) {
      throw new NexusError(
        "SAVE_PLAN_EXPIRED",
        "Save Restore Plan expired and must be generated again.",
        { details: { restorePlanId, expiresAt: plan.expiresAt } },
      );
    }
    return Object.freeze(plan);
  }

  #pathFor(restorePlanId: string): string {
    return path.join(this.#root, `${restorePlanId}.json`);
  }
}
