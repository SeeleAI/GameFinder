import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";

import type {
  DependencyNode,
  DependencyResolution,
} from "../../dependency-resolver.js";
import {
  DownloadPlanStore,
  readVerifiedModBundleManifest,
  type DownloadPlan,
} from "../../download-bundle-service.js";
import { NexusError } from "../../errors.js";
import type { InstallationRecord } from "../contracts.js";
import { sha256CanonicalJson } from "../content-hash.js";
import type { InstallService } from "../install-service.js";
import { AgenticObjectStore } from "./agentic-object-store.js";
import type {
  DynamicGameContext,
  EvidencePack,
  InstallPlanV2,
  InstallerInstallationRecord,
} from "./contracts.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime();
const identifier = z.string().trim().min(1).max(200);
const absolutePath = z.string().trim().min(3).max(32_768);

const nexusIdentitySchema = z.object({
  nodeId: identifier,
  domainName: z.string().trim().min(1).max(100),
  modId: z.number().int().positive(),
  canonicalModUrl: z.string().url(),
});

export const installationDependencySnapshotSchema = z.object({
  schemaVersion: z.literal(2),
  snapshotHash: sha256,
  installationId: z.string().uuid(),
  revision: z.number().int().positive(),
  dependent: z.object({
    recordKind: z.enum(["file_transaction", "controlled_installer"]),
    nexus: nexusIdentitySchema,
    game: z.object({
      gameRoot: absolutePath,
      gameContextId: z.string().uuid(),
    }),
  }),
  dependencies: z
    .array(
      z.object({
        nodeId: identifier,
        kind: z.enum([
          "nexus_mod",
          "loader_runtime",
          "external_requirement",
          "dlc",
        ]),
        required: z.boolean(),
        relation: z.enum(["direct", "transitive"]),
        nexus: nexusIdentitySchema.nullable(),
        versionConstraint: z.string().trim().min(1).max(2_000).nullable(),
        dependencyInstallationId: z.string().uuid().nullable(),
        evidence: z.array(z.string().trim().min(1).max(2_000)).max(100),
      }),
    )
    .max(2_000),
  completeness: z.object({
    state: z.enum(["complete", "partial"]),
    reasons: z.array(z.string().trim().min(1).max(2_000)).max(100),
  }),
  provenance: z.object({
    evidencePackId: z.string().uuid(),
    evidencePackHash: sha256,
    bundle: z
      .object({
        bundleId: z.string().uuid(),
        bundleHash: sha256,
        bundlePath: absolutePath,
        nodeId: identifier,
      })
      .nullable(),
    downloadPlan: z
      .object({
        planId: z.string().uuid(),
        planHash: sha256,
      })
      .nullable(),
  }),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export type InstallationDependencySnapshot = z.infer<
  typeof installationDependencySnapshotSchema
>;

export interface DependencyClosureEntry {
  node: DependencyNode;
  relation: "direct" | "transitive";
}

function snapshotHashPayload(
  snapshot: InstallationDependencySnapshot,
): Omit<InstallationDependencySnapshot, "snapshotHash"> {
  const { snapshotHash: _snapshotHash, ...payload } = snapshot;
  return payload;
}

export function verifyInstallationDependencySnapshotHash(
  snapshot: InstallationDependencySnapshot,
): boolean {
  return (
    sha256CanonicalJson(snapshotHashPayload(snapshot)) === snapshot.snapshotHash
  );
}

export function collectDependencyClosure(
  resolution: DependencyResolution,
  dependentNodeId: string,
): DependencyClosureEntry[] {
  const nodes = new Map(
    resolution.nodes.map((node) => [node.nodeId, node] as const),
  );
  const outgoing = new Map<string, string[]>();
  for (const edge of resolution.edges) {
    const targets = outgoing.get(edge.fromNodeId) ?? [];
    targets.push(edge.toNodeId);
    outgoing.set(edge.fromNodeId, targets);
  }
  const depths = new Map<string, number>();
  const queue: Array<{ nodeId: string; depth: number }> = [
    { nodeId: dependentNodeId, depth: 0 },
  ];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dependencyNodeId of outgoing.get(current.nodeId) ?? []) {
      const depth = current.depth + 1;
      const previous = depths.get(dependencyNodeId);
      if (previous !== undefined && previous <= depth) continue;
      depths.set(dependencyNodeId, depth);
      queue.push({ nodeId: dependencyNodeId, depth });
    }
  }
  return [...depths.entries()]
    .map(([nodeId, depth]) => {
      const node = nodes.get(nodeId);
      return node
        ? { node, relation: depth === 1 ? "direct" : "transitive" }
        : null;
    })
    .filter((entry): entry is DependencyClosureEntry => entry !== null)
    .sort(
      (left, right) =>
        (left.relation === "direct" ? 0 : 1) -
          (right.relation === "direct" ? 0 : 1) ||
        left.node.nodeId.localeCompare(right.node.nodeId),
    );
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function nodeId(domainName: string, modId: number): string {
  return `nexus:${domainName.toLowerCase()}:${modId}`;
}

function assertUuid(value: string, label: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
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
      "Installation Dependency Store must use real directories.",
      { details: { directory } },
    );
  }
}

async function publishImmutable(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await link(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export class InstallationDependencyStore {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  static async create(managerRoot: string): Promise<InstallationDependencyStore> {
    if (!path.isAbsolute(managerRoot)) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Installation Dependency Store managerRoot must be absolute.",
      );
    }
    const resolved = path.resolve(managerRoot);
    if (resolved === path.parse(resolved).root) {
      throw new NexusError(
        "PROTECTED_PATH",
        "A filesystem root cannot store installation dependencies.",
      );
    }
    const root = path.join(resolved, "installation-dependencies-v2");
    await ensureRealDirectory(root);
    return new InstallationDependencyStore(root);
  }

  async get(installationId: string): Promise<InstallationDependencySnapshot> {
    assertUuid(installationId, "installationId");
    let revision: number;
    try {
      const pointer = JSON.parse(
        await readFile(
          path.join(this.#installationRoot(installationId), "current.json"),
          "utf8",
        ),
      ) as { revision?: unknown };
      if (
        typeof pointer.revision !== "number" ||
        !Number.isSafeInteger(pointer.revision) ||
        pointer.revision < 1
      ) {
        throw new Error("Invalid dependency snapshot current pointer.");
      }
      revision = pointer.revision;
    } catch (error) {
      throw new NexusError(
        "NOT_FOUND",
        "Installation Dependency Snapshot was not found.",
        { cause: error, details: { installationId } },
      );
    }
    try {
      const snapshot = installationDependencySnapshotSchema.parse(
        JSON.parse(
          await readFile(this.#revisionPath(installationId, revision), "utf8"),
        ) as unknown,
      );
      if (!verifyInstallationDependencySnapshotHash(snapshot)) {
        throw new Error("Dependency snapshot hash mismatch.");
      }
      return snapshot;
    } catch (error) {
      throw new NexusError(
        "RECOVERY_REQUIRED",
        "The current Installation Dependency Snapshot is invalid or corrupt.",
        { cause: error, details: { installationId, revision } },
      );
    }
  }

  async save(
    draft: Omit<
      InstallationDependencySnapshot,
      "snapshotHash" | "revision" | "createdAt" | "updatedAt"
    >,
  ): Promise<InstallationDependencySnapshot> {
    const current = await this.get(draft.installationId).catch(
      (error: unknown) => {
        if (error instanceof NexusError && error.code === "NOT_FOUND") {
          return null;
        }
        throw error;
      },
    );
    const now = new Date().toISOString();
    const withoutHash = {
      ...draft,
      revision: (current?.revision ?? 0) + 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    const snapshot = installationDependencySnapshotSchema.parse({
      ...withoutHash,
      snapshotHash: sha256CanonicalJson(withoutHash),
    });
    const installationRoot = this.#installationRoot(draft.installationId);
    await ensureRealDirectory(path.join(installationRoot, "revisions"));
    await publishImmutable(
      this.#revisionPath(snapshot.installationId, snapshot.revision),
      snapshot,
    );
    const pointerPath = path.join(installationRoot, "current.json");
    const temporaryPath = `${pointerPath}.${randomUUID()}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify({
        revision: snapshot.revision,
        snapshotHash: snapshot.snapshotHash,
        updatedAt: snapshot.updatedAt,
      })}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await rename(temporaryPath, pointerPath);
    return snapshot;
  }

  async list(): Promise<ReadonlyArray<InstallationDependencySnapshot>> {
    const snapshots: InstallationDependencySnapshot[] = [];
    for (const name of await readdir(this.#root)) {
      if (!/^[0-9a-f-]{36}$/i.test(name)) continue;
      try {
        snapshots.push(await this.get(name));
      } catch {
        // Corrupt entries remain isolated and surface through exact lookup.
      }
    }
    return snapshots.sort((left, right) =>
      left.updatedAt.localeCompare(right.updatedAt),
    );
  }

  async findDependents(input: {
    dependencyNodeId: string;
    gameRoot?: string;
  }): Promise<ReadonlyArray<InstallationDependencySnapshot>> {
    const snapshots = await this.list();
    return snapshots.filter(
      (snapshot) =>
        snapshot.dependencies.some(
          (dependency) =>
            dependency.required &&
            dependency.nodeId.toLowerCase() ===
              input.dependencyNodeId.toLowerCase(),
        ) &&
        (input.gameRoot === undefined ||
          samePath(snapshot.dependent.game.gameRoot, input.gameRoot)),
    );
  }

  #installationRoot(installationId: string): string {
    assertUuid(installationId, "installationId");
    return path.join(this.#root, installationId);
  }

  #revisionPath(installationId: string, revision: number): string {
    return path.join(
      this.#installationRoot(installationId),
      "revisions",
      `${String(revision).padStart(8, "0")}.json`,
    );
  }
}

interface InstalledNode {
  installationId: string;
  nodeId: string;
  gameRoot: string;
}

function activeFileRecord(record: InstallationRecord): boolean {
  return [
    "installed",
    "runtime_unverified",
    "runtime_verified",
  ].includes(record.state);
}

function activeInstallerRecord(record: InstallerInstallationRecord): boolean {
  return record.state === "installed";
}

export class InstallationDependencyService {
  readonly #legacy: InstallService;
  readonly #objects: AgenticObjectStore;
  readonly #downloadPlans: DownloadPlanStore;
  readonly #store: InstallationDependencyStore;

  private constructor(input: {
    legacy: InstallService;
    objects: AgenticObjectStore;
    downloadPlans: DownloadPlanStore;
    store: InstallationDependencyStore;
  }) {
    this.#legacy = input.legacy;
    this.#objects = input.objects;
    this.#downloadPlans = input.downloadPlans;
    this.#store = input.store;
  }

  static async create(input: {
    managerRoot: string;
    legacy: InstallService;
    objects?: AgenticObjectStore;
  }): Promise<InstallationDependencyService> {
    const objects =
      input.objects ?? (await AgenticObjectStore.create(input.managerRoot));
    const [downloadPlans, store] = await Promise.all([
      DownloadPlanStore.create(input.managerRoot),
      InstallationDependencyStore.create(input.managerRoot),
    ]);
    return new InstallationDependencyService({
      legacy: input.legacy,
      objects,
      downloadPlans,
      store,
    });
  }

  async get(installationId: string): Promise<InstallationDependencySnapshot> {
    return await this.#store.get(installationId);
  }

  async list(): Promise<ReadonlyArray<InstallationDependencySnapshot>> {
    return await this.#store.list();
  }

  async findDependents(input: {
    dependencyNodeId: string;
    gameRoot?: string;
  }): Promise<ReadonlyArray<InstallationDependencySnapshot>> {
    const [snapshots, installedNodes] = await Promise.all([
      this.#store.findDependents(input),
      this.#installedNodes(),
    ]);
    const activeInstallationIds = new Set(
      installedNodes.map((node) => node.installationId),
    );
    return snapshots.filter((snapshot) =>
      activeInstallationIds.has(snapshot.installationId),
    );
  }

  async capture(input: {
    plan: InstallPlanV2;
    installationId: string;
    recordKind: "file_transaction" | "controlled_installer";
  }): Promise<InstallationDependencySnapshot> {
    const [evidence, context, installedNodes] = await Promise.all([
      this.#objects.getEvidence(input.plan.evidenceBinding.evidencePackId),
      this.#objects.getGameContext(input.plan.gameBinding.gameContextId),
      this.#installedNodes(),
    ]);
    return await this.#captureResolved({
      plan: input.plan,
      evidence,
      context,
      installedNodes,
      installationId: input.installationId,
      recordKind: input.recordKind,
    });
  }

  async reconcile(): Promise<{
    created: InstallationDependencySnapshot[];
    unchangedInstallationIds: string[];
    failures: Array<{ installationId: string; message: string }>;
  }> {
    const completions = await this.#objects.listAllBundleNodeCompletions();
    const created: InstallationDependencySnapshot[] = [];
    const unchangedInstallationIds: string[] = [];
    const failures: Array<{ installationId: string; message: string }> = [];
    for (const completion of completions) {
      const existing = await this.#store.get(completion.installationId).catch(
        () => null,
      );
      if (existing !== null) {
        unchangedInstallationIds.push(completion.installationId);
        continue;
      }
      try {
        const plan = await this.#objects.getPlan(completion.planId, {
          allowExpired: true,
        });
        created.push(
          await this.capture({
            plan,
            installationId: completion.installationId,
            recordKind:
              completion.executionKind === "file"
                ? "file_transaction"
                : "controlled_installer",
          }),
        );
      } catch (error) {
        failures.push({
          installationId: completion.installationId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { created, unchangedInstallationIds, failures };
  }

  async #captureResolved(input: {
    plan: InstallPlanV2;
    evidence: EvidencePack;
    context: DynamicGameContext;
    installedNodes: InstalledNode[];
    installationId: string;
    recordKind: "file_transaction" | "controlled_installer";
  }): Promise<InstallationDependencySnapshot> {
    if (input.evidence.source.nexus === null) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "A Nexus identity is required to persist an installation dependency snapshot.",
      );
    }
    let downloadPlan: DownloadPlan | null = null;
    let closure: DependencyClosureEntry[] = [];
    const completenessReasons: string[] = [];
    if (input.evidence.source.bundle !== null) {
      const bundle = await readVerifiedModBundleManifest(
        input.evidence.source.bundle.bundlePath,
      );
      if (
        bundle.bundleId !== input.evidence.source.bundle.bundleId ||
        bundle.bundleHash !== input.evidence.source.bundle.bundleHash
      ) {
        throw new NexusError(
          "BUNDLE_INVALID",
          "Evidence binding no longer matches its Bundle Manifest.",
        );
      }
      downloadPlan = await this.#downloadPlans.get(bundle.sourcePlanId, {
        allowExpired: true,
      });
      if (downloadPlan.planHash !== bundle.sourcePlanHash) {
        throw new NexusError(
          "DOWNLOAD_PLAN_STALE",
          "Bundle Manifest no longer matches its source Download Plan.",
        );
      }
      closure = collectDependencyClosure(
        downloadPlan.dependencyResolution,
        input.evidence.source.bundle.nodeId,
      );
      if (downloadPlan.dependencyResolution.truncated) {
        completenessReasons.push(
          "The source dependency traversal was depth-limited.",
        );
      }
      if (downloadPlan.dependencyResolution.cycles.length > 0) {
        completenessReasons.push(
          "The source dependency graph contains one or more cycles.",
        );
      }
    } else {
      completenessReasons.push(
        "This installation was not bound to a dependency-aware Bundle Manifest.",
      );
      closure = input.evidence.dependencies.map((dependency) => ({
        relation: "direct" as const,
        node: {
          nodeId: dependency.nodeId,
          role: "dependency" as const,
          kind:
            dependency.kind === "manual_requirement"
              ? ("external_requirement" as const)
              : dependency.kind,
          required: true as const,
          depth: 1,
          parentNodeIds: [],
          domainName: null,
          gameId: null,
          modId: null,
          name: dependency.nodeId,
          canonicalModUrl: null,
          versionConstraint: null,
          currentVersion: null,
          available: null,
          resolutionState: "external" as const,
          evidence: dependency.evidence,
        },
      }));
    }
    const dependencies = closure.map(({ node, relation }) => {
      const nexus =
        node.domainName !== null &&
        node.modId !== null &&
        node.canonicalModUrl !== null
          ? {
              nodeId: node.nodeId,
              domainName: node.domainName,
              modId: node.modId,
              canonicalModUrl: node.canonicalModUrl,
            }
          : null;
      const installed =
        nexus === null
          ? null
          : input.installedNodes.find(
              (candidate) =>
                candidate.installationId !== input.installationId &&
                candidate.nodeId.toLowerCase() === node.nodeId.toLowerCase() &&
                samePath(candidate.gameRoot, input.context.instance.gameRoot),
            ) ?? null;
      return {
        nodeId: node.nodeId,
        kind: node.kind,
        required: node.required,
        relation,
        nexus,
        versionConstraint: node.versionConstraint,
        dependencyInstallationId: installed?.installationId ?? null,
        evidence: [
          ...node.evidence,
          ...(downloadPlan === null
            ? []
            : [
                `Frozen Download Plan ${downloadPlan.planId} records ${input.evidence.source.nexus!.modId} -> ${node.nodeId}.`,
              ]),
        ],
      };
    });
    const bundleBinding = input.evidence.source.bundle;
    return await this.#store.save({
      schemaVersion: 2,
      installationId: input.installationId,
      dependent: {
        recordKind: input.recordKind,
        nexus: {
          nodeId: nodeId(
            input.evidence.source.nexus.domainName,
            input.evidence.source.nexus.modId,
          ),
          domainName: input.evidence.source.nexus.domainName,
          modId: input.evidence.source.nexus.modId,
          canonicalModUrl: input.evidence.source.nexus.canonicalModUrl,
        },
        game: {
          gameRoot: input.context.instance.gameRoot,
          gameContextId: input.context.gameContextId,
        },
      },
      dependencies,
      completeness: {
        state: completenessReasons.length === 0 ? "complete" : "partial",
        reasons: completenessReasons,
      },
      provenance: {
        evidencePackId: input.evidence.evidencePackId,
        evidencePackHash: input.evidence.evidencePackHash,
        bundle:
          bundleBinding === null
            ? null
            : {
                bundleId: bundleBinding.bundleId,
                bundleHash: bundleBinding.bundleHash,
                bundlePath: bundleBinding.bundlePath,
                nodeId: bundleBinding.nodeId,
              },
        downloadPlan:
          downloadPlan === null
            ? null
            : {
                planId: downloadPlan.planId,
                planHash: downloadPlan.planHash,
              },
      },
    });
  }

  async #installedNodes(): Promise<InstalledNode[]> {
    const [fileRecords, installerRecords] = await Promise.all([
      this.#legacy.listInstallations(),
      this.#objects.listInstallerRecords(),
    ]);
    const nodes: InstalledNode[] = [];
    for (const record of fileRecords) {
      if (!activeFileRecord(record)) continue;
      const context = await this.#legacy
        .getInstallationContext(record.installationId)
        .catch(() => null);
      if (context === null) continue;
      nodes.push({
        installationId: record.installationId,
        nodeId: nodeId(record.nexus.domainName, record.nexus.modId),
        gameRoot: context.instance.gameRoot,
      });
    }
    for (const record of installerRecords) {
      if (!activeInstallerRecord(record)) continue;
      const evidence = await this.#objects
        .getEvidence(record.evidencePackId)
        .catch(() => null);
      if (evidence?.source.nexus === null || evidence === null) continue;
      nodes.push({
        installationId: record.installationId,
        nodeId: nodeId(
          evidence.source.nexus.domainName,
          evidence.source.nexus.modId,
        ),
        gameRoot: record.gameRoot,
      });
    }
    return nodes;
  }
}
