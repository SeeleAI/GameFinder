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
import { z } from "zod/v4";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../content-hash.js";
import {
  gameInstanceSchema,
  gameProfileSchema,
  packageAnalysisSchema,
} from "../contracts.js";

const executionContextSchema = z.object({
  schemaVersion: z.literal(1),
  planId: z.string().uuid(),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  contextHash: z.string().regex(/^[a-f0-9]{64}$/),
  analysis: packageAnalysisSchema,
  profile: gameProfileSchema,
  instance: gameInstanceSchema,
  packageUnitId: z.string().trim().min(1).max(200),
  archivePath: z.string().trim().min(3),
  receiptPath: z.string().trim().min(3),
  expectedSource: z.object({
    domainName: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
    modId: z.number().int().positive(),
    fileId: z.number().int().positive(),
  }),
  createdAt: z.iso.datetime(),
});

export type PlanExecutionContext = z.infer<typeof executionContextSchema>;

type ExecutionContextDraft = Omit<
  PlanExecutionContext,
  "schemaVersion" | "contextHash" | "createdAt"
>;

function contextHashPayload(
  context: PlanExecutionContext,
): Omit<PlanExecutionContext, "contextHash"> {
  const { contextHash: _contextHash, ...payload } = context;
  return payload;
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

export class PlanExecutionContextStore {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  static async create(managerRoot: string): Promise<PlanExecutionContextStore> {
    if (!path.isAbsolute(managerRoot)) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Execution Context managerRoot must be absolute.",
      );
    }
    const resolvedManagerRoot = path.resolve(managerRoot);
    if (resolvedManagerRoot === path.parse(resolvedManagerRoot).root) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "A filesystem root cannot be used for execution contexts.",
      );
    }
    const root = path.join(resolvedManagerRoot, "plan-execution-contexts");
    await mkdir(root, { recursive: true });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new NexusError(
        "PROTECTED_PATH",
        "Execution Context Store must be a real directory.",
        { details: { root } },
      );
    }
    return new PlanExecutionContextStore(root);
  }

  async save(draft: ExecutionContextDraft): Promise<PlanExecutionContext> {
    const withoutHash = {
      schemaVersion: 1 as const,
      ...draft,
      createdAt: new Date().toISOString(),
    };
    const context = executionContextSchema.parse({
      ...withoutHash,
      contextHash: sha256CanonicalJson(withoutHash),
    });
    const contextPath = this.#pathFor(context.planId);
    const temporaryPath = `${contextPath}.${randomUUID()}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(context, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    try {
      await link(temporaryPath, contextPath);
    } catch (error) {
      throw new NexusError(
        "APPLY_FAILED",
        "The immutable Plan Execution Context could not be published.",
        { cause: error, details: { planId: context.planId } },
      );
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
    return context;
  }

  async get(planId: string): Promise<PlanExecutionContext> {
    const contextPath = this.#pathFor(planId);
    let context: PlanExecutionContext;
    try {
      context = executionContextSchema.parse(
        JSON.parse(await readFile(contextPath, "utf8")) as unknown,
      );
    } catch (error) {
      throw new NexusError(
        "NOT_FOUND",
        "Plan Execution Context was not found or is invalid.",
        { cause: error, details: { planId } },
      );
    }
    if (context.planId !== planId) {
      throw new NexusError(
        "PLAN_STALE",
        "Plan Execution Context identity does not match its storage key.",
        { details: { planId, storedPlanId: context.planId } },
      );
    }
    const actualHash = sha256CanonicalJson(contextHashPayload(context));
    if (actualHash !== context.contextHash) {
      throw new NexusError(
        "PLAN_STALE",
        "Plan Execution Context changed after planning.",
        {
          details: {
            planId,
            expectedContextHash: context.contextHash,
            actualContextHash: actualHash,
          },
        },
      );
    }
    return context;
  }

  #pathFor(planId: string): string {
    assertPlanId(planId);
    return path.join(this.#root, `${planId}.json`);
  }
}
