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

import {
  resolveModDependencies,
  type DependencyNode,
  type DependencyResolution,
} from "./dependency-resolver.js";
import {
  resolveOutputDirectory,
  verifyExistingDownloadReceipt,
  type DownloadReceipt,
} from "./download-verifier.js";
import { selectDownloadFile } from "./download-manager.js";
import { NexusError } from "./errors.js";
import { sha256CanonicalJson } from "./install/content-hash.js";
import { NexusClient } from "./nexus-client.js";
import type { NexusModFile } from "./types.js";

export interface DownloadPlanItem {
  nodeId: string;
  role: DependencyNode["role"];
  kind: "nexus_mod" | "loader_runtime";
  depth: number;
  parentNodeIds: string[];
  name: string;
  canonicalModUrl: string;
  domainName: string;
  modId: number;
  versionConstraint: string | null;
  action: "download" | "satisfied";
  selectedFile: NexusModFile | null;
  selectionReason: "explicit-file-id" | "latest-active-main" | "already-satisfied";
}

export interface DownloadPlan {
  schemaVersion: 1;
  planId: string;
  planHash: string;
  status: "planned" | "blocked";
  rootNodeId: string;
  createdAt: string;
  expiresAt: string;
  dependencyResolution: DependencyResolution;
  items: DownloadPlanItem[];
  manualRequirements: DependencyNode[];
  blockers: string[];
  warnings: string[];
}

export interface BundleArchive {
  nodeId: string;
  role: DependencyNode["role"];
  kind: "nexus_mod" | "loader_runtime";
  depth: number;
  name: string;
  canonicalModUrl: string;
  domainName: string;
  modId: number;
  fileId: number;
  fileName: string;
  version: string;
  archivePath: string;
  receiptPath: string;
  bytes: number;
  sha256: string;
}

export interface ModBundleManifest {
  schemaVersion: 1;
  bundleId: string;
  bundleHash: string;
  bundlePath: string;
  state: "download_complete" | "download_complete_requirements_pending";
  createdAt: string;
  sourcePlanId: string;
  sourcePlanHash: string;
  rootNodeId: string;
  archives: BundleArchive[];
  installOrder: string[];
  satisfiedNodeIds: string[];
  manualRequirements: DependencyNode[];
  warnings: string[];
}

interface DownloadPlanDraft {
  rootNodeId: string;
  dependencyResolution: DependencyResolution;
  items: DownloadPlanItem[];
  manualRequirements: DependencyNode[];
  blockers: string[];
  warnings: string[];
}

function planHashPayload(plan: DownloadPlan): Omit<DownloadPlan, "planHash"> {
  const { planHash: _planHash, ...payload } = plan;
  return payload;
}

function bundleHashPayload(
  bundle: ModBundleManifest,
): Omit<ModBundleManifest, "bundleHash"> {
  const { bundleHash: _bundleHash, ...payload } = bundle;
  return payload;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function assertPlanId(planId: string): void {
  if (!isUuid(planId)) {
    throw new NexusError("INVALID_INPUT", "downloadPlanId must be a UUID.");
  }
}

function assertPlanShape(value: unknown): asserts value is DownloadPlan {
  const plan = value as Partial<DownloadPlan>;
  if (
    plan.schemaVersion !== 1 ||
    typeof plan.planId !== "string" ||
    !isUuid(plan.planId) ||
    typeof plan.planHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(plan.planHash) ||
    !Array.isArray(plan.items) ||
    !Array.isArray(plan.manualRequirements) ||
    !Array.isArray(plan.blockers)
  ) {
    throw new NexusError(
      "DOWNLOAD_PLAN_STALE",
      "Stored Download Plan has an invalid schema.",
    );
  }
}

function assertBundleShape(value: unknown): asserts value is ModBundleManifest {
  const bundle = value as Partial<ModBundleManifest>;
  if (
    bundle.schemaVersion !== 1 ||
    typeof bundle.bundleId !== "string" ||
    !isUuid(bundle.bundleId) ||
    typeof bundle.bundleHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(bundle.bundleHash) ||
    typeof bundle.bundlePath !== "string" ||
    !path.isAbsolute(bundle.bundlePath) ||
    !Array.isArray(bundle.archives) ||
    !Array.isArray(bundle.installOrder)
  ) {
    throw new NexusError(
      "BUNDLE_INVALID",
      "Mod Bundle Manifest has an invalid schema.",
    );
  }
}

export async function readVerifiedModBundleManifest(
  bundlePath: string,
): Promise<ModBundleManifest> {
  if (!path.isAbsolute(bundlePath)) {
    throw new NexusError(
      "BUNDLE_INVALID",
      "Mod Bundle path must be absolute.",
    );
  }
  let bundle: ModBundleManifest;
  try {
    const parsed = JSON.parse(
      await readFile(path.resolve(bundlePath), "utf8"),
    ) as unknown;
    assertBundleShape(parsed);
    bundle = parsed;
  } catch (error) {
    if (error instanceof NexusError) throw error;
    throw new NexusError(
      "BUNDLE_INVALID",
      "Mod Bundle Manifest is missing or unreadable.",
      { cause: error, details: { bundlePath } },
    );
  }
  if (
    path.resolve(bundle.bundlePath) !== path.resolve(bundlePath) ||
    sha256CanonicalJson(bundleHashPayload(bundle)) !== bundle.bundleHash
  ) {
    throw new NexusError(
      "BUNDLE_INVALID",
      "Mod Bundle path or content hash no longer matches.",
    );
  }
  return bundle;
}

class DownloadPlanStore {
  readonly #root: string;
  readonly #defaultTtlMs: number;

  private constructor(root: string, defaultTtlMs: number) {
    this.#root = root;
    this.#defaultTtlMs = defaultTtlMs;
  }

  static async create(managerRoot: string): Promise<DownloadPlanStore> {
    if (!path.isAbsolute(managerRoot)) {
      throw new NexusError(
        "INVALID_INPUT",
        "Download Plan managerRoot must be absolute.",
      );
    }
    const resolved = path.resolve(managerRoot);
    if (resolved === path.parse(resolved).root) {
      throw new NexusError(
        "INVALID_INPUT",
        "A filesystem root cannot store Download Plans.",
      );
    }
    const root = path.join(resolved, "download-plans");
    await mkdir(root, { recursive: true });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new NexusError(
        "OUTPUT_PATH_INVALID",
        "Download Plan Store must be a real directory.",
      );
    }
    return new DownloadPlanStore(root, 30 * 60_000);
  }

  async save(draft: DownloadPlanDraft): Promise<DownloadPlan> {
    const now = new Date();
    const withoutHash = {
      schemaVersion: 1 as const,
      planId: randomUUID(),
      status: draft.blockers.length > 0 ? ("blocked" as const) : ("planned" as const),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#defaultTtlMs).toISOString(),
      ...draft,
    };
    const plan: DownloadPlan = {
      ...withoutHash,
      planHash: sha256CanonicalJson(withoutHash),
    };
    const planPath = this.#pathFor(plan.planId);
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
    planId: string,
    options: { allowExpired?: boolean } = {},
  ): Promise<DownloadPlan> {
    assertPlanId(planId);
    let plan: DownloadPlan;
    try {
      const parsed = JSON.parse(
        await readFile(this.#pathFor(planId), "utf8"),
      ) as unknown;
      assertPlanShape(parsed);
      plan = parsed;
    } catch (error) {
      if (error instanceof NexusError) throw error;
      throw new NexusError(
        "DOWNLOAD_PLAN_STALE",
        "Download Plan was not found or is unreadable.",
        { cause: error, details: { planId } },
      );
    }
    if (
      plan.planId !== planId ||
      sha256CanonicalJson(planHashPayload(plan)) !== plan.planHash
    ) {
      throw new NexusError(
        "DOWNLOAD_PLAN_STALE",
        "Download Plan identity or hash no longer matches.",
        { details: { planId } },
      );
    }
    if (
      !options.allowExpired &&
      Date.parse(plan.expiresAt) <= Date.now()
    ) {
      throw new NexusError(
        "DOWNLOAD_PLAN_STALE",
        "Download Plan expired and must be generated again.",
        { details: { planId, expiresAt: plan.expiresAt } },
      );
    }
    return plan;
  }

  #pathFor(planId: string): string {
    assertPlanId(planId);
    return path.join(this.#root, `${planId}.json`);
  }
}

function overrideFileId(
  overrides: ReadonlyArray<{ modUrl: string; fileId: number }>,
  canonicalModUrl: string,
): number | undefined {
  const override = overrides.find(
    (item) =>
      item.modUrl.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase() ===
      canonicalModUrl.toLowerCase(),
  );
  return override?.fileId;
}

export class DownloadBundleService {
  readonly #client: NexusClient;
  readonly #planStore: DownloadPlanStore;

  private constructor(client: NexusClient, planStore: DownloadPlanStore) {
    this.#client = client;
    this.#planStore = planStore;
  }

  static async create(input: {
    client: NexusClient;
    managerRoot: string;
  }): Promise<DownloadBundleService> {
    return new DownloadBundleService(
      input.client,
      await DownloadPlanStore.create(input.managerRoot),
    );
  }

  async resolve(input: {
    modUrl: string;
    maxDepth?: number;
  }): Promise<DependencyResolution> {
    return await resolveModDependencies({
      client: this.#client,
      modUrl: input.modUrl,
      ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
    });
  }

  async plan(input: {
    modUrl: string;
    rootFileId?: number;
    dependencyFileOverrides?: ReadonlyArray<{
      modUrl: string;
      fileId: number;
    }>;
    satisfiedNodeIds?: ReadonlyArray<string>;
    maxDepth?: number;
  }): Promise<DownloadPlan> {
    const dependencyResolution = await this.resolve({
      modUrl: input.modUrl,
      ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
    });
    const satisfied = new Set(input.satisfiedNodeIds ?? []);
    const overrides = input.dependencyFileOverrides ?? [];
    const items: DownloadPlanItem[] = [];
    const blockers: string[] = [];
    const warnings = [...dependencyResolution.warnings];
    const manualRequirements = dependencyResolution.nodes.filter((node) =>
      ["external_requirement", "dlc"].includes(node.kind),
    );

    if (dependencyResolution.cycles.length > 0) {
      blockers.push("Dependency graph contains a cycle.");
    }
    if (dependencyResolution.truncated) {
      blockers.push("Dependency graph traversal was truncated.");
    }

    for (const node of dependencyResolution.nodes) {
      if (!["nexus_mod", "loader_runtime"].includes(node.kind)) continue;
      if (
        !node.canonicalModUrl ||
        !node.domainName ||
        node.modId === null
      ) {
        blockers.push(`Dependency ${node.nodeId} has no canonical Nexus identity.`);
        continue;
      }
      if (satisfied.has(node.nodeId)) {
        items.push({
          nodeId: node.nodeId,
          role: node.role,
          kind: node.kind as "nexus_mod" | "loader_runtime",
          depth: node.depth,
          parentNodeIds: node.parentNodeIds,
          name: node.name,
          canonicalModUrl: node.canonicalModUrl,
          domainName: node.domainName,
          modId: node.modId,
          versionConstraint: node.versionConstraint,
          action: "satisfied",
          selectedFile: null,
          selectionReason: "already-satisfied",
        });
        continue;
      }
      if (node.resolutionState !== "resolved" || node.available === false) {
        blockers.push(`Required dependency ${node.nodeId} is not available.`);
        continue;
      }
      try {
        const { files } = await this.#client.getModFiles(
          node.domainName,
          node.modId,
        );
        const requestedFileId =
          node.role === "root"
            ? input.rootFileId
            : overrideFileId(overrides, node.canonicalModUrl);
        const selectedFile = selectDownloadFile(files, requestedFileId);
        items.push({
          nodeId: node.nodeId,
          role: node.role,
          kind: node.kind as "nexus_mod" | "loader_runtime",
          depth: node.depth,
          parentNodeIds: node.parentNodeIds,
          name: node.name,
          canonicalModUrl: node.canonicalModUrl,
          domainName: node.domainName,
          modId: node.modId,
          versionConstraint: node.versionConstraint,
          action: "download",
          selectedFile,
          selectionReason:
            requestedFileId === undefined
              ? "latest-active-main"
              : "explicit-file-id",
        });
        if (node.versionConstraint) {
          warnings.push(
            `${node.nodeId} requirement notes "${node.versionConstraint}" are preserved but not machine-interpreted against selected file version ${selectedFile.version}.`,
          );
        }
      } catch (error) {
        blockers.push(
          `Could not select a file for ${node.nodeId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    for (const nodeId of satisfied) {
      if (!dependencyResolution.nodes.some((node) => node.nodeId === nodeId)) {
        blockers.push(`Satisfied node ${nodeId} is not in the dependency graph.`);
      }
    }

    return await this.#planStore.save({
      rootNodeId: dependencyResolution.rootNodeId,
      dependencyResolution,
      items: items.sort(
        (left, right) =>
          right.depth - left.depth || left.nodeId.localeCompare(right.nodeId),
      ),
      manualRequirements,
      blockers,
      warnings: [...new Set(warnings)],
    });
  }

  async getPlan(planId: string): Promise<DownloadPlan> {
    return await this.#planStore.get(planId, { allowExpired: true });
  }

  async createBundle(input: {
    planId: string;
    receiptPaths: ReadonlyArray<string>;
    outputDirectory: string;
  }): Promise<ModBundleManifest> {
    const plan = await this.#planStore.get(input.planId);
    if (plan.status === "blocked" || plan.blockers.length > 0) {
      throw new NexusError(
        "BUNDLE_INCOMPLETE",
        "A blocked Download Plan cannot produce a Mod Bundle.",
        { details: { blockers: plan.blockers } },
      );
    }
    const receipts = await Promise.all(
      input.receiptPaths.map((receiptPath) =>
        verifyExistingDownloadReceipt(receiptPath),
      ),
    );
    const receiptKeys = new Set<string>();
    const receiptByKey = new Map<string, DownloadReceipt>();
    for (const receipt of receipts) {
      const key = `${receipt.domainName}:${receipt.modId}:${receipt.fileId}`;
      if (receiptKeys.has(key)) {
        throw new NexusError(
          "BUNDLE_INVALID",
          "A Mod Bundle cannot contain duplicate receipts.",
          { details: { key } },
        );
      }
      receiptKeys.add(key);
      receiptByKey.set(key, receipt);
    }

    const archives: BundleArchive[] = [];
    for (const item of plan.items.filter(
      (candidate) => candidate.action === "download",
    )) {
      if (!item.selectedFile) {
        throw new NexusError(
          "BUNDLE_INVALID",
          "Download Plan item has no frozen file selection.",
          { details: { nodeId: item.nodeId } },
        );
      }
      const key = `${item.domainName}:${item.modId}:${item.selectedFile.fileId}`;
      const receipt = receiptByKey.get(key);
      if (!receipt) {
        throw new NexusError(
          "BUNDLE_INCOMPLETE",
          "A required Download Plan item has no verified receipt.",
          {
            details: {
              nodeId: item.nodeId,
              modId: item.modId,
              fileId: item.selectedFile.fileId,
            },
          },
        );
      }
      if (
        receipt.canonicalModUrl.toLowerCase() !==
        item.canonicalModUrl.toLowerCase()
      ) {
        throw new NexusError(
          "BUNDLE_INVALID",
          "A receipt canonical Mod URL does not match its Download Plan item.",
          { details: { nodeId: item.nodeId } },
        );
      }
      receiptByKey.delete(key);
      archives.push({
        nodeId: item.nodeId,
        role: item.role,
        kind: item.kind,
        depth: item.depth,
        name: item.name,
        canonicalModUrl: item.canonicalModUrl,
        domainName: item.domainName,
        modId: item.modId,
        fileId: item.selectedFile.fileId,
        fileName: receipt.fileName,
        version: item.selectedFile.version,
        archivePath: receipt.absolutePath,
        receiptPath: receipt.receiptPath,
        bytes: receipt.bytes,
        sha256: receipt.sha256,
      });
    }
    if (receiptByKey.size > 0) {
      throw new NexusError(
        "BUNDLE_INVALID",
        "Receipt list contains files that are not part of the Download Plan.",
        { details: { unexpected: [...receiptByKey.keys()] } },
      );
    }

    const outputDirectory = await resolveOutputDirectory(input.outputDirectory);
    const bundleId = randomUUID();
    const bundlePath = path.join(
      outputDirectory,
      `nexus-mod-bundle-${bundleId}.json`,
    );
    const withoutHash = {
      schemaVersion: 1 as const,
      bundleId,
      bundlePath,
      state:
        plan.manualRequirements.length === 0
          ? ("download_complete" as const)
          : ("download_complete_requirements_pending" as const),
      createdAt: new Date().toISOString(),
      sourcePlanId: plan.planId,
      sourcePlanHash: plan.planHash,
      rootNodeId: plan.rootNodeId,
      archives: archives.sort(
        (left, right) =>
          right.depth - left.depth || left.nodeId.localeCompare(right.nodeId),
      ),
      installOrder: archives
        .sort(
          (left, right) =>
            right.depth - left.depth || left.nodeId.localeCompare(right.nodeId),
        )
        .map((archive) => archive.nodeId),
      satisfiedNodeIds: plan.items
        .filter((item) => item.action === "satisfied")
        .map((item) => item.nodeId),
      manualRequirements: plan.manualRequirements,
      warnings: plan.warnings,
    };
    const bundle: ModBundleManifest = {
      ...withoutHash,
      bundleHash: sha256CanonicalJson(withoutHash),
    };
    await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return bundle;
  }

  async inspectBundle(bundlePath: string): Promise<ModBundleManifest> {
    const bundle = await readVerifiedModBundleManifest(bundlePath);
    await Promise.all(
      bundle.archives.map(async (archive) => {
        const receipt = await verifyExistingDownloadReceipt(
          archive.receiptPath,
        );
        if (
          receipt.sha256 !== archive.sha256 ||
          path.resolve(receipt.absolutePath) !==
            path.resolve(archive.archivePath) ||
          receipt.modId !== archive.modId ||
          receipt.fileId !== archive.fileId
        ) {
          throw new NexusError(
            "BUNDLE_INVALID",
            "A bundled Archive no longer matches its receipt or manifest.",
            { details: { nodeId: archive.nodeId } },
          );
        }
      }),
    );
    return bundle;
  }
}
