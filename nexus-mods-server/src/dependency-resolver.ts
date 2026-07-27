import { NexusError } from "./errors.js";
import { NexusClient } from "./nexus-client.js";
import type {
  ModRequirement,
  NexusGame,
  NexusMod,
  QuotaSnapshot,
} from "./types.js";
import { parseModRef } from "./url.js";

export type DependencyKind =
  | "nexus_mod"
  | "loader_runtime"
  | "external_requirement"
  | "dlc";

export type DependencyResolutionState =
  | "resolved"
  | "unavailable"
  | "external"
  | "depth_limited";

export interface DependencyNode {
  nodeId: string;
  role: "root" | "dependency";
  kind: DependencyKind;
  required: true;
  depth: number;
  parentNodeIds: string[];
  domainName: string | null;
  gameId: number | null;
  modId: number | null;
  name: string;
  canonicalModUrl: string | null;
  versionConstraint: string | null;
  currentVersion: string | null;
  available: boolean | null;
  resolutionState: DependencyResolutionState;
  evidence: string[];
}

export interface DependencyEdge {
  fromNodeId: string;
  toNodeId: string;
  required: true;
}

export interface DependencyResolution {
  schemaVersion: 1;
  rootNodeId: string;
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  cycles: string[][];
  maxDepth: number;
  truncated: boolean;
  warnings: string[];
  fetchedAt: string;
  quota: QuotaSnapshot | null;
}

interface MutableNode extends DependencyNode {
  parentNodeIds: string[];
  evidence: string[];
}

const KNOWN_LOADER_RUNTIME_MODS = new Map<string, string>([
  ["stardewvalley:2400", "smapi"],
]);

function nexusNodeId(domainName: string, modId: number): string {
  return `nexus:${domainName}:${modId}`;
}

function externalNodeId(parentNodeId: string, requirement: ModRequirement): string {
  return `external:${parentNodeId}:${requirement.id}`;
}

function validPositiveInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function canonicalExternalUrl(value: string): string | null {
  if (!value.trim()) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function gameMaps(games: NexusGame[]): {
  byId: Map<number, NexusGame>;
  byDomain: Map<string, NexusGame>;
} {
  return {
    byId: new Map(games.map((game) => [game.id, game])),
    byDomain: new Map(
      games.map((game) => [game.domainName.toLowerCase(), game]),
    ),
  };
}

export async function resolveModDependencies(input: {
  client: NexusClient;
  modUrl: string;
  maxDepth?: number;
}): Promise<DependencyResolution> {
  const ref = parseModRef(input.modUrl);
  const maxDepth = input.maxDepth ?? 5;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 10) {
    throw new NexusError(
      "INVALID_INPUT",
      "Dependency maxDepth must be between 0 and 10.",
    );
  }
  const { games, quota: gamesQuota } = await input.client.listGames();
  const maps = gameMaps(games);
  const rootGame =
    maps.byDomain.get(ref.domainName) ??
    (await input.client.getGame(ref.domainName)).game;
  maps.byId.set(rootGame.id, rootGame);
  maps.byDomain.set(rootGame.domainName, rootGame);

  const nodes = new Map<string, MutableNode>();
  const edges = new Map<string, DependencyEdge>();
  const cycles: string[][] = [];
  const warnings: string[] = [];
  let truncated = false;
  let lastQuota: QuotaSnapshot | null = gamesQuota;

  const addParent = (node: MutableNode, parentNodeId: string | null): void => {
    if (parentNodeId && !node.parentNodeIds.includes(parentNodeId)) {
      node.parentNodeIds.push(parentNodeId);
    }
  };
  const addEdge = (fromNodeId: string, toNodeId: string): void => {
    edges.set(`${fromNodeId}\0${toNodeId}`, {
      fromNodeId,
      toNodeId,
      required: true,
    });
  };

  const visit = async (visitInput: {
    domainName: string;
    gameId: number;
    modId: number;
    name: string;
    role: "root" | "dependency";
    kind: DependencyKind;
    versionConstraint: string | null;
    parentNodeId: string | null;
    depth: number;
    ancestry: string[];
  }): Promise<void> => {
    const nodeId = nexusNodeId(visitInput.domainName, visitInput.modId);
    if (visitInput.parentNodeId) addEdge(visitInput.parentNodeId, nodeId);
    const cycleStart = visitInput.ancestry.indexOf(nodeId);
    if (cycleStart >= 0) {
      cycles.push([...visitInput.ancestry.slice(cycleStart), nodeId]);
      warnings.push(`Dependency cycle detected at ${nodeId}.`);
      return;
    }
    const existing = nodes.get(nodeId);
    if (existing) {
      addParent(existing, visitInput.parentNodeId);
      if (
        visitInput.versionConstraint &&
        !existing.evidence.includes(
          `Nexus requirement notes: ${visitInput.versionConstraint}`,
        )
      ) {
        existing.evidence.push(
          `Nexus requirement notes: ${visitInput.versionConstraint}`,
        );
      }
      return;
    }

    const node: MutableNode = {
      nodeId,
      role: visitInput.role,
      kind: visitInput.kind,
      required: true,
      depth: visitInput.depth,
      parentNodeIds: visitInput.parentNodeId
        ? [visitInput.parentNodeId]
        : [],
      domainName: visitInput.domainName,
      gameId: visitInput.gameId,
      modId: visitInput.modId,
      name: visitInput.name,
      canonicalModUrl: `https://www.nexusmods.com/${visitInput.domainName}/mods/${visitInput.modId}`,
      versionConstraint: visitInput.versionConstraint,
      currentVersion: null,
      available: null,
      resolutionState: "resolved",
      evidence: [
        ...(visitInput.versionConstraint
          ? [`Nexus requirement notes: ${visitInput.versionConstraint}`]
          : []),
      ],
    };
    nodes.set(nodeId, node);

    if (visitInput.depth > maxDepth) {
      node.resolutionState = "depth_limited";
      truncated = true;
      warnings.push(`Dependency traversal stopped at maxDepth for ${nodeId}.`);
      return;
    }

    let mod: NexusMod;
    let requirements: Awaited<
      ReturnType<NexusClient["getModRequirements"]>
    >["requirements"];
    try {
      const [modResult, requirementResult] = await Promise.all([
        input.client.getMod(visitInput.domainName, visitInput.modId),
        input.client.getModRequirements(
          visitInput.domainName,
          visitInput.modId,
        ),
      ]);
      mod = modResult.mod;
      requirements = requirementResult.requirements;
      lastQuota = requirementResult.quota;
    } catch (error) {
      if (visitInput.role === "root") throw error;
      node.resolutionState = "unavailable";
      node.available = false;
      node.evidence.push(
        `Nexus metadata could not be resolved: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      warnings.push(`Could not resolve dependency metadata for ${nodeId}.`);
      return;
    }
    node.name = mod.name;
    node.currentVersion = mod.version;
    node.available = mod.available && mod.status.toLowerCase() === "published";
    if (!node.available) {
      node.resolutionState = "unavailable";
      node.evidence.push(`Nexus status is ${mod.status}.`);
    }

    for (const dlc of requirements.dlcRequirements) {
      const dlcNodeId = `dlc:${dlc.gameId}:${dlc.id}`;
      addEdge(nodeId, dlcNodeId);
      const existingDlc = nodes.get(dlcNodeId);
      if (existingDlc) {
        addParent(existingDlc, nodeId);
        continue;
      }
      nodes.set(dlcNodeId, {
        nodeId: dlcNodeId,
        role: "dependency",
        kind: "dlc",
        required: true,
        depth: visitInput.depth + 1,
        parentNodeIds: [nodeId],
        domainName: null,
        gameId: validPositiveInteger(dlc.gameId),
        modId: null,
        name: dlc.name,
        canonicalModUrl: null,
        versionConstraint: dlc.notes,
        currentVersion: null,
        available: null,
        resolutionState: "external",
        evidence: [
          "Nexus declares this game expansion as a requirement.",
          ...(dlc.notes ? [`Requirement notes: ${dlc.notes}`] : []),
        ],
      });
    }

    for (const requirement of requirements.nexusRequirements) {
      if (requirement.externalRequirement) {
        const externalId = externalNodeId(nodeId, requirement);
        addEdge(nodeId, externalId);
        const existingExternal = nodes.get(externalId);
        if (existingExternal) {
          addParent(existingExternal, nodeId);
          continue;
        }
        nodes.set(externalId, {
          nodeId: externalId,
          role: "dependency",
          kind: "external_requirement",
          required: true,
          depth: visitInput.depth + 1,
          parentNodeIds: [nodeId],
          domainName: null,
          gameId: validPositiveInteger(requirement.gameId),
          modId: validPositiveInteger(requirement.modId),
          name: requirement.modName,
          canonicalModUrl: canonicalExternalUrl(requirement.url),
          versionConstraint: requirement.notes,
          currentVersion: null,
          available: null,
          resolutionState: "external",
          evidence: [
            "Nexus marks this as an external requirement.",
            ...(requirement.notes
              ? [`Requirement notes: ${requirement.notes}`]
              : []),
          ],
        });
        continue;
      }

      const requirementGameId = validPositiveInteger(requirement.gameId);
      const requirementModId = validPositiveInteger(requirement.modId);
      const requirementGame =
        requirementGameId === null ? undefined : maps.byId.get(requirementGameId);
      if (!requirementGame || requirementModId === null) {
        const unresolvedId = externalNodeId(nodeId, requirement);
        addEdge(nodeId, unresolvedId);
        nodes.set(unresolvedId, {
          nodeId: unresolvedId,
          role: "dependency",
          kind: "external_requirement",
          required: true,
          depth: visitInput.depth + 1,
          parentNodeIds: [nodeId],
          domainName: null,
          gameId: requirementGameId,
          modId: requirementModId,
          name: requirement.modName,
          canonicalModUrl: canonicalExternalUrl(requirement.url),
          versionConstraint: requirement.notes,
          currentVersion: null,
          available: null,
          resolutionState: "unavailable",
          evidence: [
            "Nexus requirement could not be mapped from gameId to a canonical game domain.",
          ],
        });
        warnings.push(
          `Could not canonicalize dependency ${requirement.modName} (${requirement.id}).`,
        );
        continue;
      }
      const runtimeId = KNOWN_LOADER_RUNTIME_MODS.get(
        `${requirementGame.domainName}:${requirementModId}`,
      );
      await visit({
        domainName: requirementGame.domainName,
        gameId: requirementGame.id,
        modId: requirementModId,
        name: requirement.modName,
        role: "dependency",
        kind: runtimeId ? "loader_runtime" : "nexus_mod",
        versionConstraint: requirement.notes,
        parentNodeId: nodeId,
        depth: visitInput.depth + 1,
        ancestry: [...visitInput.ancestry, nodeId],
      });
    }
  };

  await visit({
    domainName: ref.domainName,
    gameId: rootGame.id,
    modId: ref.modId,
    name: `Mod ${ref.modId}`,
    role: "root",
    kind: KNOWN_LOADER_RUNTIME_MODS.has(
      `${ref.domainName}:${ref.modId}`,
    )
      ? "loader_runtime"
      : "nexus_mod",
    versionConstraint: null,
    parentNodeId: null,
    depth: 0,
    ancestry: [],
  });

  return {
    schemaVersion: 1,
    rootNodeId: nexusNodeId(ref.domainName, ref.modId),
    nodes: [...nodes.values()].sort(
      (left, right) =>
        left.depth - right.depth || left.nodeId.localeCompare(right.nodeId),
    ),
    edges: [...edges.values()].sort((left, right) =>
      `${left.fromNodeId}:${left.toNodeId}`.localeCompare(
        `${right.fromNodeId}:${right.toNodeId}`,
      ),
    ),
    cycles,
    maxDepth,
    truncated,
    warnings,
    fetchedAt: new Date().toISOString(),
    quota: lastQuota,
  };
}
