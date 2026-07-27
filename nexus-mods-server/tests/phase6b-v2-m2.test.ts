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
  options: { installerOnly?: boolean } = {},
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
    options.installerOnly ? "ExampleInstaller.zip" : "ExampleUnknownMod.zip",
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
    canonicalModUrl: "https://www.nexusmods.com/examplegame/mods/42",
    domainName: "examplegame",
    modId: 42,
    fileId: 100,
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
    expect(plan.approval.requiresExplicitConfirmation).toBe(true);
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
