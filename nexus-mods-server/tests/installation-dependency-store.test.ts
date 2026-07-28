import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { DependencyResolution } from "../src/dependency-resolver.js";
import {
  collectDependencyClosure,
  InstallationDependencyStore,
  verifyInstallationDependencySnapshotHash,
} from "../src/install/v2/installation-dependency-store.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function dependencyResolution(): DependencyResolution {
  const node = (
    modId: number,
    kind: "nexus_mod" | "loader_runtime",
    depth: number,
  ) => ({
    nodeId: `nexus:stardewvalley:${modId}`,
    role: depth === 0 ? ("root" as const) : ("dependency" as const),
    kind,
    required: true as const,
    depth,
    parentNodeIds:
      modId === 2697
        ? []
        : modId === 2400
          ? ["nexus:stardewvalley:2697"]
          : ["nexus:stardewvalley:2400"],
    domainName: "stardewvalley",
    gameId: 1303,
    modId,
    name: String(modId),
    canonicalModUrl: `https://www.nexusmods.com/stardewvalley/mods/${modId}`,
    versionConstraint: modId === 2400 ? "v4.0.5+" : null,
    currentVersion: null,
    available: true,
    resolutionState: "resolved" as const,
    evidence: [`Fixture requirement for ${modId}.`],
  });
  return {
    schemaVersion: 1,
    rootNodeId: "nexus:stardewvalley:2697",
    nodes: [
      node(2697, "nexus_mod", 0),
      node(2400, "loader_runtime", 1),
      node(9999, "nexus_mod", 2),
    ],
    edges: [
      {
        fromNodeId: "nexus:stardewvalley:2697",
        toNodeId: "nexus:stardewvalley:2400",
        required: true,
      },
      {
        fromNodeId: "nexus:stardewvalley:2400",
        toNodeId: "nexus:stardewvalley:9999",
        required: true,
      },
    ],
    cycles: [],
    maxDepth: 5,
    truncated: false,
    warnings: [],
    fetchedAt: "2026-07-28T00:00:00.000Z",
    quota: null,
  };
}

describe("Installation Dependency Snapshot Store", () => {
  it("distinguishes direct and transitive required dependencies", () => {
    expect(
      collectDependencyClosure(
        dependencyResolution(),
        "nexus:stardewvalley:2697",
      ).map((entry) => [entry.node.nodeId, entry.relation]),
    ).toEqual([
      ["nexus:stardewvalley:2400", "direct"],
      ["nexus:stardewvalley:9999", "transitive"],
    ]);
  });

  it("persists hash-verified revisions and supports reverse dependent lookup", async () => {
    const managerRoot = await temporaryDirectory("dependency-store-");
    const store = await InstallationDependencyStore.create(managerRoot);
    const installationId = randomUUID();
    const dependencyInstallationId = randomUUID();
    const draft = {
      schemaVersion: 2 as const,
      installationId,
      dependent: {
        recordKind: "file_transaction" as const,
        nexus: {
          nodeId: "nexus:stardewvalley:2697",
          domainName: "stardewvalley",
          modId: 2697,
          canonicalModUrl:
            "https://www.nexusmods.com/stardewvalley/mods/2697",
        },
        game: {
          gameRoot: path.join(managerRoot, "game"),
          gameContextId: randomUUID(),
        },
      },
      dependencies: [
        {
          nodeId: "nexus:stardewvalley:2400",
          kind: "loader_runtime" as const,
          required: true,
          relation: "direct" as const,
          nexus: {
            nodeId: "nexus:stardewvalley:2400",
            domainName: "stardewvalley",
            modId: 2400,
            canonicalModUrl:
              "https://www.nexusmods.com/stardewvalley/mods/2400",
          },
          versionConstraint: "v4.0.5+",
          dependencyInstallationId,
          evidence: ["Frozen Download Plan fixture."],
        },
      ],
      completeness: { state: "complete" as const, reasons: [] },
      provenance: {
        evidencePackId: randomUUID(),
        evidencePackHash: "a".repeat(64),
        bundle: null,
        downloadPlan: null,
      },
    };

    const first = await store.save(draft);
    const second = await store.save({
      ...draft,
      completeness: {
        state: "partial",
        reasons: ["Fixture reconciliation warning."],
      },
    });

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(verifyInstallationDependencySnapshotHash(second)).toBe(true);
    await expect(store.get(installationId)).resolves.toEqual(second);
    await expect(
      store.findDependents({
        dependencyNodeId: "nexus:stardewvalley:2400",
        gameRoot: draft.dependent.game.gameRoot,
      }),
    ).resolves.toEqual([second]);
  });
});
