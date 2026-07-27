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

async function createFixture(): Promise<{
  archivePath: string;
  receiptPath: string;
  gameRoot: string;
  managerRoot: string;
}> {
  const downloadsRoot = await temporaryDirectory("phase6b-v2-m2-download-");
  const gameRoot = await temporaryDirectory("phase6b-v2-m2-game-");
  const managerRoot = await temporaryDirectory("phase6b-v2-m2-manager-");
  const archivePath = path.join(downloadsRoot, "ExampleUnknownMod.zip");
  const receiptPath = `${archivePath}.nexus-receipt.json`;

  await writeZip(archivePath, [
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
  ]);
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
});
