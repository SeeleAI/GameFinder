import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ZipFile } from "yazl";
import { afterEach, describe, expect, it } from "vitest";

import type { DownloadReceipt } from "../src/download-verifier.js";
import {
  AgenticInstallService,
  InstallService,
  MethodStore,
  sha256File,
} from "../src/install/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeZip(
  zipPath: string,
  entries: ReadonlyArray<{ path: string; content: string }>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const archive = new ZipFile();
    const output = createWriteStream(zipPath, { flags: "wx" });
    output.on("close", resolve);
    output.on("error", reject);
    archive.outputStream.on("error", reject);
    archive.outputStream.pipe(output);
    for (const entry of entries) {
      archive.addBuffer(Buffer.from(entry.content), entry.path);
    }
    archive.end();
  });
}

async function createSmapiArchive(input: {
  downloadsRoot: string;
  packageName: string;
  uniqueId: string;
  nexusModId: number;
  nexusFileId: number;
}): Promise<{ archivePath: string; receiptPath: string }> {
  const archivePath = path.join(
    input.downloadsRoot,
    `${input.packageName}.zip`,
  );
  const receiptPath = `${archivePath}.nexus-receipt.json`;
  const entryDll = `${input.packageName}.dll`;
  await writeZip(archivePath, [
    {
      path: `${input.packageName}/manifest.json`,
      content: JSON.stringify({
        Name: input.packageName,
        Author: "Fixture",
        Version: "1.0.0",
        UniqueID: input.uniqueId,
        EntryDll: entryDll,
        MinimumApiVersion: "4.0.0",
      }),
    },
    {
      path: `${input.packageName}/${entryDll}`,
      content: `${input.uniqueId}-payload`,
    },
  ]);
  const info = await stat(archivePath);
  const receipt: DownloadReceipt = {
    schemaVersion: 1,
    backend: "persistent_chromium",
    canonicalModUrl: `https://www.nexusmods.com/stardewvalley/mods/${input.nexusModId}`,
    domainName: "stardewvalley",
    modId: input.nexusModId,
    fileId: input.nexusFileId,
    fileName: path.basename(archivePath),
    bytes: info.size,
    sha256: await sha256File(archivePath),
    completedAt: new Date().toISOString(),
    absolutePath: archivePath,
    targetPath: archivePath,
    receiptPath,
    archiveValid: true,
    archiveCheck: {
      format: "zip",
      valid: true,
      detail: "Fixture ZIP central directory is readable.",
    },
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { archivePath, receiptPath };
}

async function probeFixtureContext(
  service: AgenticInstallService,
  gameRoot: string,
) {
  return await service.probeGameContext({
    gameRoot,
    gameId: "stardew-learning-fixture",
    gameName: "Stardew Valley Learning Fixture",
    operatingSystem: "win32",
    anchorPaths: ["Stardew Valley.exe"],
    writableRoots: ["Mods"],
    liveModRoots: ["Mods"],
    detectedLoaders: [
      {
        loaderId: "smapi",
        state: "detected",
        version: "4.5.2",
        absolutePath: path.join(gameRoot, "StardewModdingAPI.exe"),
        modRoots: [path.join(gameRoot, "Mods")],
        evidence: ["Fixture SMAPI runtime is present."],
      },
    ],
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Phase 6B V2 M4 learned Method reuse", () => {
  it("learns one SMAPI folder method and generalizes it to a second Mod", async () => {
    const downloadsRoot = await temporaryDirectory("phase6b-v2-m4-download-");
    const gameRoot = await temporaryDirectory("phase6b-v2-m4-game-");
    const managerRoot = await temporaryDirectory("phase6b-v2-m4-manager-");
    await writeFile(path.join(gameRoot, "Stardew Valley.exe"), "game");
    await writeFile(path.join(gameRoot, "StardewModdingAPI.exe"), "smapi");
    await mkdir(path.join(gameRoot, "Mods"));
    const firstArchive = await createSmapiArchive({
      downloadsRoot,
      packageName: "FirstMod",
      uniqueId: "Fixture.FirstMod",
      nexusModId: 2697,
      nexusFileId: 115145,
    });
    const secondArchive = await createSmapiArchive({
      downloadsRoot,
      packageName: "SecondMod",
      uniqueId: "Fixture.SecondMod",
      nexusModId: 9999,
      nexusFileId: 200000,
    });

    const coldLegacy = await InstallService.create({ managerRoot });
    const cold = await AgenticInstallService.create({
      managerRoot,
      legacy: coldLegacy,
    });
    const coldContext = await probeFixtureContext(cold, gameRoot);
    const coldEvidence = await cold.prepareEvidence({
      ...firstArchive,
      gameContextId: coldContext.gameContextId,
    });
    const firstUnit = coldEvidence.packageUnits[0];
    if (!firstUnit) throw new Error("Expected the first SMAPI package unit.");
    const coldQuery = await cold.queryMethods({
      evidencePackId: coldEvidence.evidencePackId,
      gameContextId: coldContext.gameContextId,
    });
    expect(coldQuery.candidates).toEqual([]);
    expect(coldQuery.proposalReadiness.recommendedAction).toBe(
      "construct_agent_file_proposal",
    );

    const coldProposal = await cold.submitProposal({
      evidencePackId: coldEvidence.evidencePackId,
      gameContextId: coldContext.gameContextId,
      draft: {
        strategyBinding: {
          origin: "agent_proposal",
          methodId: null,
          methodRevision: null,
          methodHash: null,
          legacyAdapterBinding: null,
        },
        selection: {
          packageUnitId: firstUnit.packageUnitId,
          packageRoot: firstUnit.packageRoot,
          selectedComponents: [],
        },
        operations: [
          {
            operationId: randomUUID(),
            kind: "install_tree",
            sourceRelativePath: firstUnit.packageRoot,
            targetRelativePath: "Mods/FirstMod",
            ownershipMode: "exclusive_tree",
          },
        ],
        preconditions: [],
        verificationRequirements: [],
        unresolvedChoices: [],
        risk: {
          level: "low",
          reasons: ["One self-contained SMAPI Mod folder."],
        },
      },
    });
    const coldPlan = await cold.freezePlan({
      proposalId: coldProposal.proposalId,
    });
    const coldResult = await cold.applyPlan(coldPlan.planId);
    if (coldResult.executionKind !== "file") {
      throw new Error("Expected file-tree execution.");
    }
    expect(coldResult.dependencySnapshot).toMatchObject({
      warning: null,
      snapshot: {
        installationId: coldResult.applied.record.installationId,
        dependent: {
          nexus: {
            nodeId: "nexus:stardewvalley:2697",
          },
        },
        dependencies: [
          {
            nodeId: "Pathoschild.SMAPI",
            kind: "external_requirement",
            required: true,
            relation: "direct",
          },
        ],
        completeness: {
          state: "partial",
        },
      },
    });
    const learned = coldResult.methodLearning.method;
    if (!learned) throw new Error("Expected a learned SMAPI folder Method.");
    expect(learned).toMatchObject({
      state: "local_verified",
      scope: {
        loaderSelectors: [
          {
            kind: "loader_state",
            subject: "smapi",
            expected: "smapi:detected",
          },
        ],
      },
      provenance: {
        origin: "agent_learned",
        derivedFromInstallationIds: [
          coldResult.applied.record.installationId,
        ],
      },
    });

    const warmLegacy = await InstallService.create({ managerRoot });
    const warm = await AgenticInstallService.create({
      managerRoot,
      legacy: warmLegacy,
    });
    const warmContext = await probeFixtureContext(warm, gameRoot);
    const warmEvidence = await warm.prepareEvidence({
      ...secondArchive,
      gameContextId: warmContext.gameContextId,
    });
    const secondUnit = warmEvidence.packageUnits[0];
    if (!secondUnit) throw new Error("Expected the second SMAPI package unit.");
    const warmQuery = await warm.queryMethods({
      evidencePackId: warmEvidence.evidencePackId,
      gameContextId: warmContext.gameContextId,
    });
    expect(warmQuery.proposalReadiness.recommendedAction).toBe(
      "select_verified_method",
    );
    expect(warmQuery.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: "method-store",
          state: "verified_match",
          methodBinding: {
            methodId: learned.methodId,
            revision: learned.revision,
            methodHash: learned.methodHash,
          },
        }),
      ]),
    );

    const warmProposal = await warm.instantiateMethodProposal({
      methodId: learned.methodId,
      methodRevision: learned.revision,
      evidencePackId: warmEvidence.evidencePackId,
      gameContextId: warmContext.gameContextId,
      packageUnitId: secondUnit.packageUnitId,
    });
    expect(warmProposal.operations).toEqual([
      expect.objectContaining({
        kind: "install_tree",
        sourceRelativePath: "SecondMod",
        targetRelativePath: "Mods/SecondMod",
      }),
    ]);
    const warmPlan = await warm.freezePlan({
      proposalId: warmProposal.proposalId,
    });
    const warmResult = await warm.applyPlan(warmPlan.planId);
    if (warmResult.executionKind !== "file") {
      throw new Error("Expected file-tree execution.");
    }
    expect(warmResult.methodLearning).toMatchObject({
      warning: null,
      method: {
        methodId: learned.methodId,
        revision: learned.revision,
        state: "local_verified",
      },
      outcome: { state: "succeeded" },
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(gameRoot, "Mods", "SecondMod", "manifest.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ UniqueID: "Fixture.SecondMod" });

    const outcomes = await (
      await MethodStore.create(managerRoot)
    ).listOutcomes(learned.methodId);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((outcome) => outcome.installationId)).toEqual(
      expect.arrayContaining([
        coldResult.applied.record.installationId,
        warmResult.applied.record.installationId,
      ]),
    );

    const uninstall = await warmLegacy.planUninstall(
      warmResult.applied.record.installationId,
    );
    expect(uninstall.plan).toMatchObject({
      installationId: warmResult.applied.record.installationId,
      installationRevision: warmResult.applied.record.revision,
      status: "planned",
    });
    expect(uninstall.plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "delete_owned_file",
          targetRelativePath: "Mods/SecondMod/manifest.json",
        }),
        expect.objectContaining({
          kind: "delete_owned_file",
          targetRelativePath: "Mods/SecondMod/SecondMod.dll",
        }),
        expect.objectContaining({
          kind: "remove_empty_directory",
          targetRelativePath: "Mods/SecondMod",
        }),
      ]),
    );
    const uninstalled = await warmLegacy.applyUninstall(
      uninstall.plan.uninstallPlanId,
    );
    expect(uninstalled.record.state).toBe("uninstalled");
    expect(
      await stat(path.join(gameRoot, "Mods", "SecondMod")).catch(() => null),
    ).toBeNull();
  });
});
