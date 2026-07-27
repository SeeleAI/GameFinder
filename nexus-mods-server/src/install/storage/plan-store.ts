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
import type { GameInstance, GameProfile, InstallPlan } from "../contracts.js";
import { installPlanSchema } from "../contracts.js";
import {
  inspectOperationConflict,
  preconditionStateHash,
} from "../core/conflict-detector.js";

export type ImmutableInstallPlanDraft = Omit<
  InstallPlan,
  | "schemaVersion"
  | "planId"
  | "planHash"
  | "status"
  | "createdAt"
  | "expiresAt"
>;

function planHashPayload(plan: InstallPlan): Omit<InstallPlan, "planHash"> {
  const { planHash: _planHash, ...payload } = plan;
  return payload;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function assertPlanId(planId: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      planId,
    )
  ) {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      "planId must be a UUID.",
    );
  }
}

export class PlanStore {
  readonly #root: string;
  readonly #defaultTtlMs: number;

  private constructor(root: string, defaultTtlMs: number) {
    this.#root = root;
    this.#defaultTtlMs = defaultTtlMs;
  }

  static async create(options: {
    managerRoot: string;
    defaultTtlMs?: number;
  }): Promise<PlanStore> {
    if (!path.isAbsolute(options.managerRoot)) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Plan Store managerRoot must be absolute.",
      );
    }
    const managerRoot = path.resolve(options.managerRoot);
    if (managerRoot === path.parse(managerRoot).root) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "A filesystem root cannot be used as the Plan Store root.",
      );
    }
    const root = path.join(managerRoot, "plans");
    await mkdir(root, { recursive: true });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new NexusError(
        "PROTECTED_PATH",
        "The Plan Store must be a real directory.",
        { details: { root } },
      );
    }
    const defaultTtlMs = options.defaultTtlMs ?? 30 * 60_000;
    if (
      !Number.isSafeInteger(defaultTtlMs) ||
      defaultTtlMs < 1_000 ||
      defaultTtlMs > 24 * 60 * 60_000
    ) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Plan TTL must be between one second and 24 hours.",
      );
    }
    return new PlanStore(root, defaultTtlMs);
  }

  async save(
    draft: ImmutableInstallPlanDraft,
    options: { ttlMs?: number; now?: Date } = {},
  ): Promise<Readonly<InstallPlan>> {
    const now = options.now ?? new Date();
    const ttlMs = options.ttlMs ?? this.#defaultTtlMs;
    if (
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1_000 ||
      ttlMs > 24 * 60 * 60_000
    ) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Plan TTL must be between one second and 24 hours.",
      );
    }
    const withoutHash = {
      schemaVersion: 1 as const,
      planId: randomUUID(),
      status: "planned" as const,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      ...draft,
    };
    const plan = installPlanSchema.parse({
      ...withoutHash,
      planHash: sha256CanonicalJson(withoutHash),
    });
    const planPath = this.#pathFor(plan.planId);
    const temporaryPath = `${planPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(plan, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    try {
      await link(temporaryPath, planPath);
    } catch (error) {
      throw new NexusError(
        "APPLY_FAILED",
        "The immutable Install Plan could not be published.",
        { cause: error, details: { planId: plan.planId } },
      );
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
    return deepFreeze(plan);
  }

  async get(
    planId: string,
    options: { allowExpired?: boolean; now?: Date } = {},
  ): Promise<Readonly<InstallPlan>> {
    const planPath = this.#pathFor(planId);
    let parsed: InstallPlan;
    try {
      parsed = installPlanSchema.parse(
        JSON.parse(await readFile(planPath, "utf8")) as unknown,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new NexusError("NOT_FOUND", "Install Plan was not found.", {
          details: { planId },
        });
      }
      throw new NexusError(
        "PLAN_STALE",
        "Install Plan storage is unreadable or invalid.",
        { cause: error, details: { planId } },
      );
    }
    if (parsed.planId !== planId) {
      throw new NexusError(
        "PLAN_STALE",
        "Install Plan identity does not match its storage key.",
        { details: { planId, storedPlanId: parsed.planId } },
      );
    }
    const actualHash = sha256CanonicalJson(planHashPayload(parsed));
    if (actualHash !== parsed.planHash) {
      throw new NexusError(
        "PLAN_STALE",
        "Install Plan content has changed since it was frozen.",
        {
          details: {
            planId,
            expectedPlanHash: parsed.planHash,
            actualPlanHash: actualHash,
          },
        },
      );
    }
    const now = options.now ?? new Date();
    if (!options.allowExpired && Date.parse(parsed.expiresAt) <= now.getTime()) {
      throw new NexusError(
        "PLAN_STALE",
        "Install Plan has expired and must be generated again.",
        { details: { planId, expiresAt: parsed.expiresAt } },
      );
    }
    return deepFreeze(parsed);
  }

  async assertPreconditions(input: {
    plan: InstallPlan;
    profile: GameProfile;
    instance: GameInstance;
  }): Promise<void> {
    const inspections = await Promise.all(
      input.plan.operations.map((operation) =>
        inspectOperationConflict({
          operation,
          gameRoot: input.instance.gameRoot,
          writableRoots: input.profile.filesystem.writableRoots,
          protectedRoots: input.profile.filesystem.protectedRoots,
        }),
      ),
    );
    const actualHash = preconditionStateHash(inspections);
    if (actualHash !== input.plan.preconditionStateHash) {
      throw new NexusError(
        "PLAN_STALE",
        "The target filesystem changed after the Install Plan was created.",
        {
          details: {
            planId: input.plan.planId,
            expectedPreconditionStateHash: input.plan.preconditionStateHash,
            actualPreconditionStateHash: actualHash,
          },
        },
      );
    }
  }

  #pathFor(planId: string): string {
    assertPlanId(planId);
    return path.join(this.#root, `${planId}.json`);
  }
}
