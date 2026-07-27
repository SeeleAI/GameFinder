import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../content-hash.js";
import type { UninstallPlan } from "../contracts.js";
import { uninstallPlanSchema } from "../contracts.js";

export type ImmutableUninstallPlanDraft = Omit<
  UninstallPlan,
  | "schemaVersion"
  | "uninstallPlanId"
  | "uninstallPlanHash"
  | "status"
  | "createdAt"
  | "expiresAt"
>;

function hashPayload(
  plan: UninstallPlan,
): Omit<UninstallPlan, "uninstallPlanHash"> {
  const { uninstallPlanHash: _hash, ...payload } = plan;
  return payload;
}

export class UninstallPlanStore {
  readonly #root: string;
  readonly #defaultTtlMs: number;

  private constructor(root: string, defaultTtlMs: number) {
    this.#root = root;
    this.#defaultTtlMs = defaultTtlMs;
  }

  static async create(input: {
    managerRoot: string;
    defaultTtlMs?: number;
  }): Promise<UninstallPlanStore> {
    if (!path.isAbsolute(input.managerRoot)) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Uninstall Plan managerRoot must be absolute.",
      );
    }
    const root = path.join(
      path.resolve(input.managerRoot),
      "uninstall-plans",
    );
    await mkdir(root, { recursive: true });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new NexusError(
        "PROTECTED_PATH",
        "Uninstall Plan Store must be a real directory.",
      );
    }
    return new UninstallPlanStore(
      root,
      input.defaultTtlMs ?? 30 * 60_000,
    );
  }

  async save(
    draft: ImmutableUninstallPlanDraft,
    options: { ttlMs?: number; now?: Date } = {},
  ): Promise<UninstallPlan> {
    const now = options.now ?? new Date();
    const ttlMs = options.ttlMs ?? this.#defaultTtlMs;
    if (
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1_000 ||
      ttlMs > 24 * 60 * 60_000
    ) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Uninstall Plan TTL must be between one second and 24 hours.",
      );
    }
    const withoutHash = {
      schemaVersion: 1 as const,
      uninstallPlanId: randomUUID(),
      status: "planned" as const,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      ...draft,
    };
    const plan = uninstallPlanSchema.parse({
      ...withoutHash,
      uninstallPlanHash: sha256CanonicalJson(withoutHash),
    });
    const planPath = this.#pathFor(plan.uninstallPlanId);
    const temporaryPath = `${planPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(plan, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    try {
      await link(temporaryPath, planPath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
    return plan;
  }

  async get(
    uninstallPlanId: string,
    options: { allowExpired?: boolean; now?: Date } = {},
  ): Promise<UninstallPlan> {
    let plan: UninstallPlan;
    try {
      plan = uninstallPlanSchema.parse(
        JSON.parse(
          await readFile(this.#pathFor(uninstallPlanId), "utf8"),
        ) as unknown,
      );
    } catch (error) {
      throw new NexusError(
        "NOT_FOUND",
        "Uninstall Plan was not found or is invalid.",
        { cause: error, details: { uninstallPlanId } },
      );
    }
    if (
      plan.uninstallPlanId !== uninstallPlanId ||
      sha256CanonicalJson(hashPayload(plan)) !== plan.uninstallPlanHash
    ) {
      throw new NexusError(
        "PLAN_STALE",
        "Uninstall Plan content changed after it was frozen.",
        { details: { uninstallPlanId } },
      );
    }
    const now = options.now ?? new Date();
    if (
      !options.allowExpired &&
      Date.parse(plan.expiresAt) <= now.getTime()
    ) {
      throw new NexusError(
        "PLAN_STALE",
        "Uninstall Plan has expired.",
        { details: { uninstallPlanId, expiresAt: plan.expiresAt } },
      );
    }
    return plan;
  }

  #pathFor(uninstallPlanId: string): string {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        uninstallPlanId,
      )
    ) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "uninstallPlanId must be a UUID.",
      );
    }
    return path.join(this.#root, `${uninstallPlanId}.json`);
  }
}
