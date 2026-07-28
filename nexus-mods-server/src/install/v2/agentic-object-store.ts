import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";

import { NexusError } from "../../errors.js";
import {
  dynamicGameContextSchema,
  evidencePackSchema,
  installPlanV2Schema,
  installerExecutionContextSchema,
  installerInstallationRecordSchema,
  installProposalSchema,
  verifyDynamicGameContextHash,
  verifyEvidencePackHash,
  verifyInstallPlanV2Hash,
  verifyInstallProposalHash,
} from "./contracts.js";
import type {
  DynamicGameContext,
  EvidencePack,
  InstallPlanV2,
  InstallProposal,
  InstallerExecutionContext,
  InstallerInstallationRecord,
} from "./contracts.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const planBridgeSchema = z.object({
  schemaVersion: z.literal(2),
  v2PlanId: z.string().uuid(),
  v2PlanHash: z.string().regex(/^[a-f0-9]{64}$/),
  v1PlanId: z.string().uuid(),
  v1PlanHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
});

const bundleNodeCompletionSchema = z.object({
  schemaVersion: z.literal(2),
  bundleId: z.string().uuid(),
  nodeId: z.string().trim().min(1).max(200),
  planId: z.string().uuid(),
  installationId: z.string().uuid(),
  executionKind: z.enum(["file", "installer"]),
  completedAt: z.string().datetime(),
});

export type BundleNodeCompletion = z.infer<
  typeof bundleNodeCompletionSchema
>;

export type V2PlanBridge = z.infer<typeof planBridgeSchema>;

function assertUuid(id: string, label: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      `${label} must be a UUID.`,
    );
  }
}

async function ensureRealDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new NexusError(
      "PROTECTED_PATH",
      "Agentic installation state must use real directories.",
      { details: { directory } },
    );
  }
}

async function publish(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await link(temporaryPath, filePath);
  } catch (error) {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      "An immutable V2 installation object already exists.",
      { cause: error, details: { filePath } },
    );
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function readObject<T>(
  filePath: string,
  parse: (value: unknown) => T,
  verify: (value: T) => boolean,
  label: string,
): Promise<T> {
  try {
    const parsed = parse(
      JSON.parse(await readFile(filePath, "utf8")) as unknown,
    );
    if (!verify(parsed)) throw new Error(`${label} hash mismatch.`);
    return parsed;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new NexusError("NOT_FOUND", `${label} was not found.`, {
        details: { filePath },
      });
    }
    throw new NexusError(
      "RECOVERY_REQUIRED",
      `${label} is unreadable, invalid, or corrupt.`,
      { cause: error, details: { filePath } },
    );
  }
}

export class AgenticObjectStore {
  readonly #evidenceRoot: string;
  readonly #contextRoot: string;
  readonly #proposalRoot: string;
  readonly #planRoot: string;
  readonly #bridgeRoot: string;
  readonly #installerContextRoot: string;
  readonly #installerRecordRoot: string;
  readonly #bundleCompletionRoot: string;

  private constructor(root: string) {
    this.#evidenceRoot = path.join(root, "evidence");
    this.#contextRoot = path.join(root, "game-contexts");
    this.#proposalRoot = path.join(root, "install-proposals");
    this.#planRoot = path.join(root, "plans-v2");
    this.#bridgeRoot = path.join(root, "plan-bridges-v2");
    this.#installerContextRoot = path.join(root, "installer-contexts-v2");
    this.#installerRecordRoot = path.join(root, "installer-records-v2");
    this.#bundleCompletionRoot = path.join(root, "bundle-completions-v2");
  }

  static async create(managerRoot: string): Promise<AgenticObjectStore> {
    if (!path.isAbsolute(managerRoot)) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Agentic Object Store managerRoot must be absolute.",
      );
    }
    const root = path.resolve(managerRoot);
    if (root === path.parse(root).root) {
      throw new NexusError(
        "PROTECTED_PATH",
        "A filesystem root cannot store V2 installation objects.",
      );
    }
    const store = new AgenticObjectStore(root);
    await Promise.all([
      ensureRealDirectory(store.#evidenceRoot),
      ensureRealDirectory(store.#contextRoot),
      ensureRealDirectory(store.#proposalRoot),
      ensureRealDirectory(store.#planRoot),
      ensureRealDirectory(store.#bridgeRoot),
      ensureRealDirectory(store.#installerContextRoot),
      ensureRealDirectory(store.#installerRecordRoot),
      ensureRealDirectory(store.#bundleCompletionRoot),
    ]);
    return store;
  }

  async saveEvidence(evidence: EvidencePack): Promise<EvidencePack> {
    const parsed = evidencePackSchema.parse(evidence);
    if (!verifyEvidencePackHash(parsed)) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Evidence Pack hash does not match its content.",
      );
    }
    await publish(this.#path(this.#evidenceRoot, parsed.evidencePackId), parsed);
    return parsed;
  }

  async getEvidence(evidencePackId: string): Promise<EvidencePack> {
    return await readObject(
      this.#path(this.#evidenceRoot, evidencePackId),
      (value) => evidencePackSchema.parse(value),
      verifyEvidencePackHash,
      "Evidence Pack",
    );
  }

  async saveGameContext(
    context: DynamicGameContext,
  ): Promise<DynamicGameContext> {
    const parsed = dynamicGameContextSchema.parse(context);
    if (!verifyDynamicGameContextHash(parsed)) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Dynamic Game Context hash does not match its content.",
      );
    }
    await publish(this.#path(this.#contextRoot, parsed.gameContextId), parsed);
    return parsed;
  }

  async getGameContext(gameContextId: string): Promise<DynamicGameContext> {
    return await readObject(
      this.#path(this.#contextRoot, gameContextId),
      (value) => dynamicGameContextSchema.parse(value),
      verifyDynamicGameContextHash,
      "Dynamic Game Context",
    );
  }

  async saveProposal(proposal: InstallProposal): Promise<InstallProposal> {
    const parsed = installProposalSchema.parse(proposal);
    if (!verifyInstallProposalHash(parsed)) {
      throw new NexusError(
        "PROPOSAL_INVALID",
        "Install Proposal hash does not match its content.",
      );
    }
    await publish(this.#path(this.#proposalRoot, parsed.proposalId), parsed);
    return parsed;
  }

  async getProposal(proposalId: string): Promise<InstallProposal> {
    return await readObject(
      this.#path(this.#proposalRoot, proposalId),
      (value) => installProposalSchema.parse(value),
      verifyInstallProposalHash,
      "Install Proposal",
    );
  }

  async savePlan(plan: InstallPlanV2): Promise<InstallPlanV2> {
    const parsed = installPlanV2Schema.parse(plan);
    if (!verifyInstallPlanV2Hash(parsed)) {
      throw new NexusError(
        "PLAN_STALE",
        "Install Plan V2 hash does not match its content.",
      );
    }
    await publish(this.#path(this.#planRoot, parsed.planId), parsed);
    return parsed;
  }

  async getPlan(
    planId: string,
    options: { allowExpired?: boolean; now?: Date } = {},
  ): Promise<InstallPlanV2> {
    const plan = await readObject(
      this.#path(this.#planRoot, planId),
      (value) => installPlanV2Schema.parse(value),
      verifyInstallPlanV2Hash,
      "Install Plan V2",
    );
    if (
      !options.allowExpired &&
      Date.parse(plan.expiresAt) <= (options.now ?? new Date()).getTime()
    ) {
      throw new NexusError(
        "PLAN_STALE",
        "Install Plan V2 expired and must be regenerated.",
        { details: { planId, expiresAt: plan.expiresAt } },
      );
    }
    return plan;
  }

  async saveBridge(bridge: V2PlanBridge): Promise<V2PlanBridge> {
    const parsed = planBridgeSchema.parse(bridge);
    await publish(this.#path(this.#bridgeRoot, parsed.v2PlanId), parsed);
    return parsed;
  }

  async getBridge(v2PlanId: string): Promise<V2PlanBridge> {
    try {
      return planBridgeSchema.parse(
        JSON.parse(
          await readFile(this.#path(this.#bridgeRoot, v2PlanId), "utf8"),
        ) as unknown,
      );
    } catch (error) {
      throw new NexusError(
        "PLAN_STALE",
        "Install Plan V2 execution bridge is missing or invalid.",
        { cause: error, details: { v2PlanId } },
      );
    }
  }

  async saveInstallerContext(
    context: InstallerExecutionContext,
  ): Promise<InstallerExecutionContext> {
    const parsed = installerExecutionContextSchema.parse(context);
    await publish(this.#path(this.#installerContextRoot, parsed.planId), parsed);
    return parsed;
  }

  async getInstallerContext(
    planId: string,
  ): Promise<InstallerExecutionContext> {
    try {
      return installerExecutionContextSchema.parse(
        JSON.parse(
          await readFile(this.#path(this.#installerContextRoot, planId), "utf8"),
        ) as unknown,
      );
    } catch (error) {
      throw new NexusError(
        "PLAN_STALE",
        "Controlled-installer execution context is missing or invalid.",
        { cause: error, details: { planId } },
      );
    }
  }

  async saveInstallerRecord(
    record: InstallerInstallationRecord,
  ): Promise<InstallerInstallationRecord> {
    const parsed = installerInstallationRecordSchema.parse(record);
    await publish(this.#path(this.#installerRecordRoot, parsed.planId), parsed);
    return parsed;
  }

  async getInstallerRecordByPlan(
    planId: string,
  ): Promise<InstallerInstallationRecord> {
    try {
      return installerInstallationRecordSchema.parse(
        JSON.parse(
          await readFile(this.#path(this.#installerRecordRoot, planId), "utf8"),
        ) as unknown,
      );
    } catch (error) {
      throw new NexusError(
        "NOT_FOUND",
        "Controlled-installer Installation Record was not found.",
        { cause: error, details: { planId } },
      );
    }
  }

  async listInstallerRecordsByBundle(
    bundleId: string,
  ): Promise<ReadonlyArray<InstallerInstallationRecord>> {
    assertUuid(bundleId, "bundleId");
    const records = await this.listInstallerRecords();
    return records.filter((record) => record.bundle?.bundleId === bundleId);
  }

  async listInstallerRecords(): Promise<
    ReadonlyArray<InstallerInstallationRecord>
  > {
    const records: InstallerInstallationRecord[] = [];
    for (const name of await readdir(this.#installerRecordRoot)) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = installerInstallationRecordSchema.parse(
          JSON.parse(
            await readFile(path.join(this.#installerRecordRoot, name), "utf8"),
          ) as unknown,
        );
        records.push(record);
      } catch {
        // Corrupt records remain isolated and are surfaced by exact lookup.
      }
    }
    return records.sort((left, right) =>
      left.installedAt.localeCompare(right.installedAt),
    );
  }

  async saveBundleNodeCompletion(
    completion: BundleNodeCompletion,
  ): Promise<BundleNodeCompletion> {
    const parsed = bundleNodeCompletionSchema.parse(completion);
    await publish(
      this.#path(this.#bundleCompletionRoot, parsed.planId),
      parsed,
    );
    return parsed;
  }

  async listBundleNodeCompletions(
    bundleId: string,
  ): Promise<ReadonlyArray<BundleNodeCompletion>> {
    assertUuid(bundleId, "bundleId");
    const completions: BundleNodeCompletion[] = [];
    for (const name of await readdir(this.#bundleCompletionRoot)) {
      if (!name.endsWith(".json")) continue;
      try {
        const completion = bundleNodeCompletionSchema.parse(
          JSON.parse(
            await readFile(path.join(this.#bundleCompletionRoot, name), "utf8"),
          ) as unknown,
        );
        if (completion.bundleId === bundleId) completions.push(completion);
      } catch {
        // Corrupt completion objects remain isolated from valid records.
      }
    }
    return completions.sort((left, right) =>
      left.completedAt.localeCompare(right.completedAt),
    );
  }

  #path(root: string, id: string): string {
    assertUuid(id, "Object id");
    return path.join(root, `${id}.json`);
  }
}
