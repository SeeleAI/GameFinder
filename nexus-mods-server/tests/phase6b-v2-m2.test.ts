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
  AGENTIC_FILE_METHOD_ADAPTER_ID,
  AgenticInstallService,
  InstallService,
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

async function createFixture(
  options: { installerOnly?: boolean; portableOnly?: boolean } = {},
): Promise<{
  archivePath: string;
  receiptPath: string;
  gameRoot: string;
  managerRoot: string;
}> {
  const downloadsRoot = await temporaryDirectory("phase6b-v2-m2-download-");
  const gameRoot = await temporaryDirectory("phase6b-v2-m2-game-");
  const managerRoot = await temporaryDirectory("phase6b-v2-m2-manager-");
  const archivePath = path.join(
    downloadsRoot,
    options.installerOnly
      ? "ExampleInstaller.zip"
      : options.portableOnly
        ? "TarnishedTool.zip"
        : "ExampleUnknownMod.zip",
  );
  const receiptPath = `${archivePath}.nexus-receipt.json`;

  await writeZip(
    archivePath,
    options.installerOnly
      ? [
          {
            path: "Example Installer/internal/windows/Setup.exe",
            content: "fixture-installer",
          },
          {
            path: "Example Installer/README.txt",
            content: "Run the bundled installer.",
          },
        ]
      : options.portableOnly
        ? [
            {
              path: "TarnishedTool.exe",
              content: "portable-tool-payload",
            },
          ]
        : [
          {
            path: "ExampleUnknownMod/manifest.json",
            content: JSON.stringify({
              Name: "Example Unknown Mod",
              Author: "Fixture",
              Version: "1.0.0",
              UniqueID: "Fixture.ExampleUnknownMod",
              EntryDll: "ExampleUnknownMod.dll",
            }),
          },
          {
            path: "ExampleUnknownMod/ExampleUnknownMod.dll",
            content: "fixture-payload",
          },
        ],
  );
  const archiveInfo = await stat(archivePath);
  const receipt: DownloadReceipt = {
    schemaVersion: 1,
    backend: "persistent_chromium",
    canonicalModUrl: options.portableOnly
      ? "https://www.nexusmods.com/eldenring/mods/9277"
      : "https://www.nexusmods.com/examplegame/mods/42",
    domainName: options.portableOnly ? "eldenring" : "examplegame",
    modId: options.portableOnly ? 9277 : 42,
    fileId: options.portableOnly ? 48456 : 100,
    fileName: path.basename(archivePath),
    bytes: archiveInfo.size,
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

  await writeFile(path.join(gameRoot, "ExampleGame.exe"), "game-anchor");
  await mkdir(path.join(gameRoot, "Mods"));
  await mkdir(path.join(gameRoot, "Protected"));
  return { archivePath, receiptPath, gameRoot, managerRoot };
}

async function createNexusArchiveFixture(input: {
  downloadsRoot: string;
  fileName: string;
  modId: number;
  fileId: number;
  entries: ReadonlyArray<{ path: string; content: string }>;
}): Promise<{ archivePath: string; receiptPath: string }> {
  const archivePath = path.join(input.downloadsRoot, input.fileName);
  const receiptPath = `${archivePath}.nexus-receipt.json`;
  await writeZip(archivePath, input.entries);
  const archiveInfo = await stat(archivePath);
  const receipt: DownloadReceipt = {
    schemaVersion: 1,
    backend: "persistent_chromium",
    canonicalModUrl: `https://www.nexusmods.com/eldenring/mods/${input.modId}`,
    domainName: "eldenring",
    modId: input.modId,
    fileId: input.fileId,
    fileName: input.fileName,
    bytes: archiveInfo.size,
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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Phase 6B V2 M2 Agentic planning and file execution", () => {
  it("installs an unseen file package without a prewritten game Adapter", async () => {
    const fixture = await createFixture();
    const legacy = await InstallService.create({
      managerRoot: fixture.managerRoot,
    });
    const service = await AgenticInstallService.create({
      managerRoot: fixture.managerRoot,
      legacy,
    });

    const context = await service.probeGameContext({
      gameRoot: fixture.gameRoot,
      gameId: "example-game",
      gameName: "Example Game",
      nexusDomainName: "examplegame",
      platform: "manual",
      operatingSystem: "win32",
      anchorPaths: ["ExampleGame.exe"],
      writableRoots: ["Mods"],
      protectedRoots: ["Protected"],
      liveModRoots: ["Mods"],
      knownProcessNames: [],
      lockSensitiveProcessNames: [],
    });
    const evidence = await service.prepareEvidence({
      archivePath: fixture.archivePath,
      receiptPath: fixture.receiptPath,
      gameContextId: context.gameContextId,
    });
    const packageUnit = evidence.packageUnits[0];
    if (!packageUnit) throw new Error("Expected one analyzed package unit.");

    const queried = await service.queryMethods({
      evidencePackId: evidence.evidencePackId,
      gameContextId: context.gameContextId,
    });
    expect(queried.candidates).toEqual([]);
    expect(queried.operationCapabilities).toMatchObject({
      installTree: { state: "available", executableIn: "M2" },
      runBundledInstaller: {
        state: "available",
        executableIn: "M3",
      },
    });
    expect(queried.proposalReadiness).toMatchObject({
      packageUnitCount: 1,
      canSubmitFileProposal: true,
      recommendedAction: "construct_agent_file_proposal",
      blockers: [],
    });

    const proposal = await service.submitProposal({
      evidencePackId: evidence.evidencePackId,
      gameContextId: context.gameContextId,
      draft: {
        strategyBinding: {
          origin: "agent_proposal",
          methodId: null,
          methodRevision: null,
          methodHash: null,
          legacyAdapterBinding: null,
        },
        selection: {
          packageUnitId: packageUnit.packageUnitId,
          packageRoot: packageUnit.packageRoot,
          selectedComponents: [],
        },
        operations: [
          {
            operationId: randomUUID(),
            kind: "install_tree",
            sourceRelativePath: packageUnit.packageRoot,
            targetRelativePath: "Mods/ExampleUnknownMod",
            ownershipMode: "exclusive_tree",
          },
        ],
        preconditions: [],
        verificationRequirements: [],
        unresolvedChoices: [],
        risk: {
          level: "low",
          reasons: ["Self-contained directory under the declared Mods root."],
        },
      },
    });
    const plan = await service.freezePlan({
      proposalId: proposal.proposalId,
    });
    const target = path.join(fixture.gameRoot, "Mods", "ExampleUnknownMod");
    expect(await stat(target).catch(() => null)).toBeNull();
    expect(plan.review).toMatchObject({
      classification: "auto_safe",
      nextAction: "apply_now",
      reasonCodes: ["BOUNDED_REVERSIBLE_FILE_OPERATION"],
    });
    expect(plan.operations).toHaveLength(1);

    const result = await service.applyPlan(plan.planId);
    expect(result.executionKind).toBe("file");
    if (result.executionKind !== "file") {
      throw new Error("Expected the file execution bridge.");
    }
    expect(result.applied.record.adapterId).toBe(
      AGENTIC_FILE_METHOD_ADAPTER_ID,
    );
    expect(result.applied.staticVerification.state).toBe("passed");
    expect(
      JSON.parse(await readFile(path.join(target, "manifest.json"), "utf8")),
    ).toMatchObject({ UniqueID: "Fixture.ExampleUnknownMod" });
    expect(
      await readFile(path.join(target, "ExampleUnknownMod.dll"), "utf8"),
    ).toBe("fixture-payload");

    const verified = await legacy.verifyInstallation(
      result.applied.record.installationId,
    );
    expect(verified.staticVerification.state).toBe("passed");
    expect(verified.inspection.blocking).toBe(false);
  });

  it("rejects an Agent Proposal that targets a protected root", async () => {
    const fixture = await createFixture();
    const legacy = await InstallService.create({
      managerRoot: fixture.managerRoot,
    });
    const service = await AgenticInstallService.create({
      managerRoot: fixture.managerRoot,
      legacy,
    });
    const context = await service.probeGameContext({
      gameRoot: fixture.gameRoot,
      gameId: "example-game",
      gameName: "Example Game",
      operatingSystem: "win32",
      anchorPaths: ["ExampleGame.exe"],
      writableRoots: ["Mods", "Protected"],
      protectedRoots: ["Protected"],
      liveModRoots: ["Mods"],
    });
    const evidence = await service.prepareEvidence({
      archivePath: fixture.archivePath,
      receiptPath: fixture.receiptPath,
      gameContextId: context.gameContextId,
    });
    const packageUnit = evidence.packageUnits[0];
    if (!packageUnit) throw new Error("Expected one analyzed package unit.");

    await expect(
      service.submitProposal({
        evidencePackId: evidence.evidencePackId,
        gameContextId: context.gameContextId,
        draft: {
          strategyBinding: {
            origin: "agent_proposal",
            methodId: null,
            methodRevision: null,
            methodHash: null,
            legacyAdapterBinding: null,
          },
          selection: {
            packageUnitId: packageUnit.packageUnitId,
            packageRoot: packageUnit.packageRoot,
            selectedComponents: [],
          },
          operations: [
            {
              operationId: randomUUID(),
              kind: "install_tree",
              sourceRelativePath: packageUnit.packageRoot,
              targetRelativePath: "Protected/ExampleUnknownMod",
              ownershipMode: "exclusive_tree",
            },
          ],
          preconditions: [],
          verificationRequirements: [],
          unresolvedChoices: [],
          risk: { level: "high", reasons: ["Fixture protected path."] },
        },
      }),
    ).rejects.toMatchObject({ code: "PROTECTED_PATH" });
  });

  it("deploys a single-file portable tool through install_tree without executing it", async () => {
    const fixture = await createFixture({ portableOnly: true });
    const legacy = await InstallService.create({
      managerRoot: fixture.managerRoot,
    });
    const service = await AgenticInstallService.create({
      managerRoot: fixture.managerRoot,
      legacy,
    });
    const context = await service.probeGameContext({
      gameRoot: fixture.gameRoot,
      gameId: "elden-ring",
      gameName: "Elden Ring",
      nexusDomainName: "eldenring",
      operatingSystem: "win32",
      anchorPaths: ["ExampleGame.exe"],
      writableRoots: ["TarnishedTool"],
      protectedRoots: ["Protected"],
      liveModRoots: [],
    });
    const evidence = await service.prepareEvidence({
      archivePath: fixture.archivePath,
      receiptPath: fixture.receiptPath,
      gameContextId: context.gameContextId,
    });
    const packageUnit = evidence.packageUnits[0];
    if (!packageUnit) throw new Error("Expected a portable package unit.");
    expect(packageUnit).toMatchObject({
      packageType: "self-contained-folder",
      packageRoot: ".",
      identity: { name: "TarnishedTool" },
      entryFiles: ["TarnishedTool.exe"],
    });

    const queried = await service.queryMethods({
      evidencePackId: evidence.evidencePackId,
      gameContextId: context.gameContextId,
    });
    expect(queried.proposalReadiness).toMatchObject({
      packageUnitCount: 1,
      canSubmitFileProposal: true,
      canSubmitInstallerProposal: false,
      recommendedAction: "construct_agent_file_proposal",
      blockers: [],
    });

    const proposal = await service.submitProposal({
      evidencePackId: evidence.evidencePackId,
      gameContextId: context.gameContextId,
      draft: {
        strategyBinding: {
          origin: "agent_proposal",
          methodId: null,
          methodRevision: null,
          methodHash: null,
          legacyAdapterBinding: null,
        },
        selection: {
          packageUnitId: packageUnit.packageUnitId,
          packageRoot: packageUnit.packageRoot,
          selectedComponents: [],
        },
        operations: [
          {
            operationId: randomUUID(),
            kind: "install_tree",
            sourceRelativePath: ".",
            targetRelativePath: "TarnishedTool",
            ownershipMode: "exclusive_tree",
          },
        ],
        preconditions: [],
        verificationRequirements: [
          {
            checkId: "portable-entry-present",
            kind: "path_exists",
            subject: "TarnishedTool/TarnishedTool.exe",
            expected: null,
            required: true,
            evidenceIds: evidence.evidence.map((item) => item.evidenceId),
          },
        ],
        unresolvedChoices: [],
        risk: {
          level: "low",
          reasons: [
            "Create one isolated portable-tool directory without executing the payload.",
          ],
        },
      },
    });
    const plan = await service.freezePlan({
      proposalId: proposal.proposalId,
    });
    expect(plan.operations).toEqual([
      expect.objectContaining({
        kind: "install_tree",
        sourceRelativePath: ".",
        targetRelativePath: "TarnishedTool",
        ownershipMode: "exclusive_tree",
      }),
    ]);

    const result = await service.applyPlan(plan.planId);
    if (result.executionKind !== "file") {
      throw new Error("Expected portable file-tree execution.");
    }
    expect(result.applied.staticVerification.state).toBe("passed");
    expect(
      await readFile(
        path.join(fixture.gameRoot, "TarnishedTool", "TarnishedTool.exe"),
        "utf8",
      ),
    ).toBe("portable-tool-payload");
    expect(result.applied.record.operationOutcomes).toEqual([
      expect.objectContaining({
        operationKind: "install_tree",
        targetRelativePath: "TarnishedTool",
        ownershipMode: "exclusive_tree",
      }),
    ]);
    expect(result.methodLearning.method?.scope.packageSignals).toContainEqual(
      expect.objectContaining({
        signalId: "portable-entry-name",
        kind: "file_name",
        expected: "TarnishedTool.exe",
        required: true,
      }),
    );
  });

  it("installs dependency-first Elden Ring root overlays with bounded file operations", async () => {
    const downloadsRoot = await temporaryDirectory(
      "phase6b-v2-m2-overlay-download-",
    );
    const gameRoot = await temporaryDirectory(
      "phase6b-v2-m2-overlay-game-",
    );
    const managerRoot = await temporaryDirectory(
      "phase6b-v2-m2-overlay-manager-",
    );
    await mkdir(path.join(gameRoot, "Game"));
    await writeFile(path.join(gameRoot, "Game", "eldenring.exe"), "game");
    const loader = await createNexusArchiveFixture({
      downloadsRoot,
      fileName: "EldenModLoader.zip",
      modId: 117,
      fileId: 8919,
      entries: [
        { path: "dinput8.dll", content: "loader-proxy" },
        { path: "mod_loader_config.ini", content: "[modloader]" },
      ],
    });
    const camera = await createNexusArchiveFixture({
      downloadsRoot,
      fileName: "FreeLockOnCamera.zip",
      modId: 4177,
      fileId: 39620,
      entries: [
        { path: "mods/FreeLockOnCamera.dll", content: "camera-dll" },
        { path: "mods/FreeLockOnCamera.pdb", content: "camera-symbols" },
        {
          path: "mods/FreeLockOnCamera/config.ini",
          content: "[camera]",
        },
      ],
    });
    const legacy = await InstallService.create({ managerRoot });
    const service = await AgenticInstallService.create({
      managerRoot,
      legacy,
    });
    const context = await service.probeGameContext({
      gameRoot,
      gameId: "elden-ring",
      gameName: "ELDEN RING",
      nexusDomainName: "eldenring",
      platform: "steam",
      platformAppId: "1245620",
      operatingSystem: "win32",
      anchorPaths: ["Game/eldenring.exe"],
      writableRoots: [
        "Game/dinput8.dll",
        "Game/mod_loader_config.ini",
        "Game/mods",
      ],
      protectedRoots: ["Game/EasyAntiCheat"],
      liveModRoots: ["Game/mods"],
      knownProcessNames: ["eldenring.exe"],
      lockSensitiveProcessNames: ["eldenring.exe"],
    });

    const loaderEvidence = await service.prepareEvidence({
      ...loader,
      gameContextId: context.gameContextId,
    });
    const loaderUnit = loaderEvidence.packageUnits[0];
    if (!loaderUnit) throw new Error("Expected a loader overlay unit.");
    expect(loaderUnit).toMatchObject({
      packageType: "root-overlay",
      packageRoot: ".",
      entryFiles: ["dinput8.dll", "mod_loader_config.ini"],
    });
    const loaderQuery = await service.queryMethods({
      evidencePackId: loaderEvidence.evidencePackId,
      gameContextId: context.gameContextId,
    });
    expect(loaderQuery.operationCapabilities.fileMapping).toMatchObject({
      state: "available",
      operationKinds: [
        "ensure_directory",
        "install_new_file",
        "replace_file",
      ],
    });
    expect(loaderQuery.proposalReadiness.recommendedAction).toBe(
      "construct_agent_file_proposal",
    );
    const loaderProposal = await service.submitProposal({
      evidencePackId: loaderEvidence.evidencePackId,
      gameContextId: context.gameContextId,
      draft: {
        strategyBinding: {
          origin: "agent_proposal",
          methodId: null,
          methodRevision: null,
          methodHash: null,
          legacyAdapterBinding: null,
        },
        selection: {
          packageUnitId: loaderUnit.packageUnitId,
          packageRoot: loaderUnit.packageRoot,
          selectedComponents: [],
        },
        operations: [
          {
            operationId: randomUUID(),
            kind: "ensure_directory",
            sourceRelativePath: null,
            targetRelativePath: "Game/mods",
            ownershipMode: null,
          },
          {
            operationId: randomUUID(),
            kind: "install_new_file",
            sourceRelativePath: "dinput8.dll",
            targetRelativePath: "Game/dinput8.dll",
            ownershipMode: "installed_file_set",
          },
          {
            operationId: randomUUID(),
            kind: "install_new_file",
            sourceRelativePath: "mod_loader_config.ini",
            targetRelativePath: "Game/mod_loader_config.ini",
            ownershipMode: "installed_file_set",
          },
        ],
        preconditions: [],
        verificationRequirements: [],
        unresolvedChoices: [],
        risk: {
          level: "medium",
          reasons: ["Install a bounded loader proxy and configuration."],
        },
      },
    });
    const loaderPlan = await service.freezePlan({
      proposalId: loaderProposal.proposalId,
    });
    expect(loaderPlan.operations.map((operation) => operation.kind)).toEqual([
      "ensure_directory",
      "install_new_file",
      "install_new_file",
    ]);
    const loaderResult = await service.applyPlan(loaderPlan.planId);
    if (loaderResult.executionKind !== "file") {
      throw new Error("Expected loader file execution.");
    }
    expect(loaderResult.applied.staticVerification.state).toBe("passed");
    expect(loaderResult.methodLearning).toMatchObject({
      warning: null,
      method: {
        state: "local_verified",
        scope: {
          sourceSelectors: [
            expect.objectContaining({
              kind: "source_identity",
              expected: "eldenring:117",
            }),
          ],
        },
      },
      outcome: { state: "succeeded" },
    });
    const learnedLoaderMethod = loaderResult.methodLearning.method;
    if (!learnedLoaderMethod) {
      throw new Error("Expected a learned loader file-mapping Method.");
    }

    const cameraEvidence = await service.prepareEvidence({
      ...camera,
      gameContextId: context.gameContextId,
    });
    const cameraUnit = cameraEvidence.packageUnits[0];
    if (!cameraUnit) throw new Error("Expected a camera overlay unit.");
    const cameraQuery = await service.queryMethods({
      evidencePackId: cameraEvidence.evidencePackId,
      gameContextId: context.gameContextId,
    });
    expect(
      cameraQuery.candidates.some(
        (candidate) => candidate.state === "verified_match",
      ),
    ).toBe(false);
    const cameraProposal = await service.submitProposal({
      evidencePackId: cameraEvidence.evidencePackId,
      gameContextId: context.gameContextId,
      draft: {
        strategyBinding: {
          origin: "agent_proposal",
          methodId: null,
          methodRevision: null,
          methodHash: null,
          legacyAdapterBinding: null,
        },
        selection: {
          packageUnitId: cameraUnit.packageUnitId,
          packageRoot: cameraUnit.packageRoot,
          selectedComponents: [],
        },
        operations: [
          {
            operationId: randomUUID(),
            kind: "ensure_directory",
            sourceRelativePath: null,
            targetRelativePath: "Game/mods",
            ownershipMode: null,
          },
          {
            operationId: randomUUID(),
            kind: "ensure_directory",
            sourceRelativePath: null,
            targetRelativePath: "Game/mods/FreeLockOnCamera",
            ownershipMode: null,
          },
          ...[
            "mods/FreeLockOnCamera.dll",
            "mods/FreeLockOnCamera.pdb",
            "mods/FreeLockOnCamera/config.ini",
          ].map((sourceRelativePath) => ({
            operationId: randomUUID(),
            kind: "install_new_file" as const,
            sourceRelativePath,
            targetRelativePath: `Game/${sourceRelativePath}`,
            ownershipMode: "installed_file_set" as const,
          })),
        ],
        preconditions: [],
        verificationRequirements: [],
        unresolvedChoices: [],
        risk: {
          level: "low",
          reasons: ["Add three bounded files below the declared live Mod root."],
        },
      },
    });
    const cameraPlan = await service.freezePlan({
      proposalId: cameraProposal.proposalId,
    });
    expect(cameraPlan.conflicts).toContainEqual(
      expect.objectContaining({
        target: "Game/mods",
        kind: "same_content",
        blocking: false,
      }),
    );
    const cameraResult = await service.applyPlan(cameraPlan.planId);
    if (cameraResult.executionKind !== "file") {
      throw new Error("Expected camera file execution.");
    }
    expect(cameraResult.applied.staticVerification.state).toBe("passed");
    expect(cameraResult.methodLearning).toMatchObject({
      warning: null,
      method: {
        state: "local_verified",
        scope: {
          sourceSelectors: [
            expect.objectContaining({
              expected: "eldenring:4177",
            }),
          ],
        },
      },
    });
    expect(
      await readFile(
        path.join(gameRoot, "Game", "mods", "FreeLockOnCamera.dll"),
        "utf8",
      ),
    ).toBe("camera-dll");
    expect(
      (
        await legacy.verifyInstallation(
          cameraResult.applied.record.installationId,
        )
      ).staticVerification.state,
    ).toBe("passed");

    const secondGameRoot = await temporaryDirectory(
      "phase6b-v2-m2-overlay-warm-game-",
    );
    await mkdir(path.join(secondGameRoot, "Game"));
    await writeFile(
      path.join(secondGameRoot, "Game", "eldenring.exe"),
      "game",
    );
    const secondContext = await service.probeGameContext({
      gameRoot: secondGameRoot,
      gameId: "elden-ring",
      gameName: "ELDEN RING",
      nexusDomainName: "eldenring",
      platform: "steam",
      platformAppId: "1245620",
      operatingSystem: "win32",
      anchorPaths: ["Game/eldenring.exe"],
      writableRoots: [
        "Game/dinput8.dll",
        "Game/mod_loader_config.ini",
        "Game/mods",
      ],
      liveModRoots: ["Game/mods"],
    });
    const warmEvidence = await service.prepareEvidence({
      ...loader,
      gameContextId: secondContext.gameContextId,
    });
    const warmUnit = warmEvidence.packageUnits[0];
    if (!warmUnit) throw new Error("Expected a warm overlay unit.");
    const warmQuery = await service.queryMethods({
      evidencePackId: warmEvidence.evidencePackId,
      gameContextId: secondContext.gameContextId,
    });
    expect(warmQuery.proposalReadiness.recommendedAction).toBe(
      "select_verified_method",
    );
    expect(warmQuery.candidates).toContainEqual(
      expect.objectContaining({
        state: "verified_match",
        methodBinding: expect.objectContaining({
          methodId: learnedLoaderMethod.methodId,
          revision: learnedLoaderMethod.revision,
        }),
      }),
    );
    const warmProposal = await service.instantiateMethodProposal({
      methodId: learnedLoaderMethod.methodId,
      methodRevision: learnedLoaderMethod.revision,
      evidencePackId: warmEvidence.evidencePackId,
      gameContextId: secondContext.gameContextId,
      packageUnitId: warmUnit.packageUnitId,
    });
    expect(warmProposal.operations.map((operation) => operation.kind)).toEqual(
      ["ensure_directory", "install_new_file", "install_new_file"],
    );
    const warmPlan = await service.freezePlan({
      proposalId: warmProposal.proposalId,
    });
    const warmResult = await service.applyPlan(warmPlan.planId);
    if (warmResult.executionKind !== "file") {
      throw new Error("Expected warm loader file execution.");
    }
    expect(warmResult.methodLearning).toMatchObject({
      warning: null,
      method: {
        methodId: learnedLoaderMethod.methodId,
        revision: learnedLoaderMethod.revision,
      },
      outcome: { state: "succeeded" },
    });
    expect(
      await readFile(
        path.join(secondGameRoot, "Game", "dinput8.dll"),
        "utf8",
      ),
    ).toBe("loader-proxy");
  });

  it("requires high risk and preserves a backup for an explicit root-overlay file replacement", async () => {
    const downloadsRoot = await temporaryDirectory(
      "phase6b-v2-m2-replace-download-",
    );
    const gameRoot = await temporaryDirectory(
      "phase6b-v2-m2-replace-game-",
    );
    const managerRoot = await temporaryDirectory(
      "phase6b-v2-m2-replace-manager-",
    );
    await mkdir(path.join(gameRoot, "Game"));
    await writeFile(path.join(gameRoot, "Game", "eldenring.exe"), "game");
    await writeFile(path.join(gameRoot, "Game", "dinput8.dll"), "old-proxy");
    const loader = await createNexusArchiveFixture({
      downloadsRoot,
      fileName: "ReplacementLoader.zip",
      modId: 117,
      fileId: 8919,
      entries: [{ path: "dinput8.dll", content: "new-proxy" }],
    });
    const legacy = await InstallService.create({ managerRoot });
    const service = await AgenticInstallService.create({
      managerRoot,
      legacy,
    });
    const context = await service.probeGameContext({
      gameRoot,
      gameId: "elden-ring",
      gameName: "ELDEN RING",
      nexusDomainName: "eldenring",
      operatingSystem: "win32",
      anchorPaths: ["Game/eldenring.exe"],
      writableRoots: ["Game/dinput8.dll"],
      liveModRoots: [],
    });
    const evidence = await service.prepareEvidence({
      ...loader,
      gameContextId: context.gameContextId,
    });
    const unit = evidence.packageUnits[0];
    if (!unit) throw new Error("Expected a replacement overlay unit.");
    const draft = {
      strategyBinding: {
        origin: "agent_proposal" as const,
        methodId: null,
        methodRevision: null,
        methodHash: null,
        legacyAdapterBinding: null,
      },
      selection: {
        packageUnitId: unit.packageUnitId,
        packageRoot: unit.packageRoot,
        selectedComponents: [],
      },
      operations: [
        {
          operationId: randomUUID(),
          kind: "replace_file" as const,
          sourceRelativePath: "dinput8.dll",
          targetRelativePath: "Game/dinput8.dll",
          ownershipMode: "layered_path" as const,
        },
      ],
      preconditions: [],
      verificationRequirements: [],
      unresolvedChoices: [],
    };
    await expect(
      service.submitProposal({
        evidencePackId: evidence.evidencePackId,
        gameContextId: context.gameContextId,
        draft: {
          ...draft,
          risk: {
            level: "medium",
            reasons: ["An intentionally under-classified replacement."],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "PROPOSAL_INVALID" });

    const proposal = await service.submitProposal({
      evidencePackId: evidence.evidencePackId,
      gameContextId: context.gameContextId,
      draft: {
        ...draft,
        risk: {
          level: "high",
          reasons: ["Replace one existing proxy DLL with a verified backup."],
        },
      },
    });
    const plan = await service.freezePlan({
      proposalId: proposal.proposalId,
    });
    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        target: "Game/dinput8.dll",
        kind: "unmanaged_existing",
        blocking: false,
      }),
    ]);
    const result = await service.applyPlan(plan.planId);
    if (result.executionKind !== "file") {
      throw new Error("Expected replacement file execution.");
    }
    expect(await readFile(path.join(gameRoot, "Game", "dinput8.dll"), "utf8"))
      .toBe("new-proxy");
    expect(result.applied.record.operationOutcomes).toEqual([
      expect.objectContaining({
        operationKind: "replace_file",
        ownershipMode: "layered_path",
        backupId: expect.any(String),
      }),
    ]);
    expect(result.methodLearning.warning).toBeNull();
  });

  it("recognizes a bundled installer as an M3 Proposal-ready package unit", async () => {
    const fixture = await createFixture({ installerOnly: true });
    const legacy = await InstallService.create({
      managerRoot: fixture.managerRoot,
    });
    const service = await AgenticInstallService.create({
      managerRoot: fixture.managerRoot,
      legacy,
    });
    const context = await service.probeGameContext({
      gameRoot: fixture.gameRoot,
      gameId: "example-game",
      gameName: "Example Game",
      nexusDomainName: "examplegame",
      operatingSystem: "win32",
      anchorPaths: ["ExampleGame.exe"],
      writableRoots: ["Mods"],
      liveModRoots: ["Mods"],
    });
    const evidence = await service.prepareEvidence({
      archivePath: fixture.archivePath,
      receiptPath: fixture.receiptPath,
      gameContextId: context.gameContextId,
    });
    expect(evidence.packageUnits).toHaveLength(1);
    const installerUnit = evidence.packageUnits[0];
    if (!installerUnit) throw new Error("Expected an installer package unit.");
    expect(installerUnit).toMatchObject({
      packageType: "executable-installer",
      packageRoot: "Example Installer",
      entryFiles: ["Example Installer/internal/windows/Setup.exe"],
    });
    const entry = evidence.archive.entries.find(
      (candidate) =>
        candidate.relativePath ===
        "Example Installer/internal/windows/Setup.exe",
    );
    expect(entry?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const installerEvidenceId = evidence.evidence[0]?.evidenceId;
    if (!installerEvidenceId) throw new Error("Expected installer evidence.");

    const queried = await service.queryMethods({
      evidencePackId: evidence.evidencePackId,
      gameContextId: context.gameContextId,
    });
    expect(queried.proposalReadiness).toMatchObject({
      packageUnitCount: 1,
      canSubmitFileProposal: false,
      canSubmitInstallerProposal: true,
      recommendedAction: "construct_agent_installer_proposal",
      blockers: [],
    });
    expect(queried.operationCapabilities.runBundledInstaller).toMatchObject({
      state: "available",
      executableIn: "M3",
    });

    await expect(
      service.submitProposal({
        evidencePackId: evidence.evidencePackId,
        gameContextId: context.gameContextId,
        draft: {
          strategyBinding: {
            origin: "agent_proposal",
            methodId: null,
            methodRevision: null,
            methodHash: null,
            legacyAdapterBinding: null,
          },
          selection: {
            packageUnitId: installerUnit.packageUnitId,
            packageRoot: installerUnit.packageRoot,
            selectedComponents: ["windows"],
          },
          operations: [
            {
              operationId: randomUUID(),
              kind: "run_bundled_installer",
              entry: {
                source: "verified_staging",
                relativePath:
                  "Example Installer/internal/windows/Setup.exe",
                runtime: "native",
                sha256: entry?.sha256 ?? "a".repeat(64),
              },
              arguments: [],
              workingDirectory: "Example Installer",
              environmentPolicy: "minimal",
              timeoutMs: 300_000,
              allowedExitCodes: [0],
              declaredWriteRoots: [
                {
                  scope: "game_root",
                  path: "Mods",
                  evidenceIds: [installerEvidenceId],
                },
              ],
              postConditions: [
                {
                  checkId: "mods-root-exists",
                  kind: "path_exists",
                  subject: "Mods",
                  expected: "present",
                  required: true,
                  evidenceIds: [],
                },
              ],
              reversibilityLevel: "manual_recovery",
            },
          ],
          preconditions: [],
          verificationRequirements: [],
          unresolvedChoices: [],
          risk: {
            level: "high",
            reasons: ["Bundled installer execution requires M3."],
          },
        },
      }),
    ).resolves.toMatchObject({
      operations: [
        {
          kind: "run_bundled_installer",
          entry: { sha256: entry?.sha256 },
        },
      ],
    });
  });

  it("advises re-probing with a registered legacy profile instead of keeping invented identity", async () => {
    const fixture = await createFixture();
    const legacy = await InstallService.create({
      managerRoot: fixture.managerRoot,
    });
    const service = await AgenticInstallService.create({
      managerRoot: fixture.managerRoot,
      legacy,
    });
    const context = await service.probeGameContext({
      gameRoot: fixture.gameRoot,
      gameId: "1303",
      gameName: "Stardew Valley",
      nexusDomainName: "stardewvalley",
      operatingSystem: "win32",
      anchorPaths: ["ExampleGame.exe"],
      writableRoots: ["Mods"],
      liveModRoots: ["Mods"],
    });
    const evidence = await service.prepareEvidence({
      archivePath: fixture.archivePath,
      receiptPath: fixture.receiptPath,
      gameContextId: context.gameContextId,
    });

    const queried = await service.queryMethods({
      evidencePackId: evidence.evidencePackId,
      gameContextId: context.gameContextId,
    });
    expect(queried.contextAdvisories).toEqual([
      expect.objectContaining({
        code: "REGISTERED_PROFILE_AVAILABLE",
        legacyProfileId: "stardew-valley",
      }),
    ]);
    expect(queried.proposalReadiness).toMatchObject({
      canSubmitFileProposal: false,
      recommendedAction: "reprobe_with_legacy_profile",
      blockers: expect.arrayContaining([
        {
          code: "REGISTERED_PROFILE_AVAILABLE",
          message: expect.any(String),
        },
      ]),
    });
  });
});
