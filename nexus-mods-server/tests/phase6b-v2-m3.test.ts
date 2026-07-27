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
  ControlledInstallerJournalStore,
  InstallService,
  sha256File,
} from "../src/install/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeZip(zipPath: string, script: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const archive = new ZipFile();
    const output = createWriteStream(zipPath, { flags: "wx" });
    output.on("close", resolve);
    output.on("error", reject);
    archive.outputStream.on("error", reject);
    archive.outputStream.pipe(output);
    archive.addBuffer(Buffer.from(script), "Installer/setup.js");
    archive.addBuffer(Buffer.from("Controlled fixture installer."), "Installer/README.txt");
    archive.end();
  });
}

async function createFixture(): Promise<{
  archivePath: string;
  receiptPath: string;
  gameRoot: string;
  managerRoot: string;
}> {
  const downloadsRoot = await temporaryDirectory("phase6b-v2-m3-download-");
  const gameRoot = await temporaryDirectory("phase6b-v2-m3-game-");
  const managerRoot = await temporaryDirectory("phase6b-v2-m3-manager-");
  const archivePath = path.join(downloadsRoot, "FixtureInstaller.zip");
  const receiptPath = `${archivePath}.nexus-receipt.json`;
  await writeZip(
    archivePath,
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const target = process.argv[2];",
      'const mode = process.argv[3] || "success";',
      'if (mode === "smapi") {',
      "  fs.mkdirSync(path.dirname(target), { recursive: true });",
      '  fs.writeFileSync(target, "fixture-smapi");',
      "  process.exit(0);",
      "}",
      "fs.mkdirSync(target, { recursive: true });",
      'fs.writeFileSync(path.join(target, "loader.txt"), "installed");',
      'if (mode === "unexpected") {',
      '  const surprise = path.join(path.dirname(target), "Surprise");',
      "  fs.mkdirSync(surprise, { recursive: true });",
      '  fs.writeFileSync(path.join(surprise, "outside.txt"), "unexpected");',
      "}",
      'if (mode === "fail") process.exit(7);',
    ].join("\n"),
  );
  const archiveInfo = await stat(archivePath);
  const receipt: DownloadReceipt = {
    schemaVersion: 1,
    backend: "persistent_chromium",
    canonicalModUrl: "https://www.nexusmods.com/examplegame/mods/2400",
    domainName: "examplegame",
    modId: 2400,
    fileId: 101,
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
  await writeFile(path.join(gameRoot, "ExampleGame.exe"), "anchor");
  await mkdir(path.join(gameRoot, "Mods"));
  return { archivePath, receiptPath, gameRoot, managerRoot };
}

async function prepareInstaller(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  mode: "success" | "fail" | "unexpected" | "smapi",
  bundleId?: string,
) {
  const legacy = await InstallService.create({
    managerRoot: fixture.managerRoot,
  });
  const service = await AgenticInstallService.create({
    managerRoot: fixture.managerRoot,
    legacy,
  });
  const context =
    mode === "smapi"
      ? await service.probeGameContext({
          gameRoot: fixture.gameRoot,
          legacyProfileId: "stardew-valley",
        })
      : await service.probeGameContext({
          gameRoot: fixture.gameRoot,
          gameId: "example-game",
          gameName: "Example Game",
          nexusDomainName: "examplegame",
          operatingSystem: "win32",
          anchorPaths: ["ExampleGame.exe"],
          writableRoots: ["Mods"],
          liveModRoots: ["Mods"],
          lockSensitiveProcessNames: [],
        });
  const evidence = await service.prepareEvidence({
    archivePath: fixture.archivePath,
    receiptPath: fixture.receiptPath,
    gameContextId: context.gameContextId,
    ...(bundleId === undefined
      ? {}
      : {
          bundle: {
            bundleId,
            bundlePath: path.join(fixture.managerRoot, "fixture-bundle.json"),
            bundleHash: "b".repeat(64),
            nodeId: "loader-runtime",
            installOrderIndex: 0,
          },
        }),
  });
  const unit = evidence.packageUnits[0];
  if (!unit) throw new Error("Expected an executable installer package unit.");
  const entryPath = unit.entryFiles[0];
  const entry = evidence.archive.entries.find(
    (candidate) => candidate.relativePath === entryPath,
  );
  if (!entryPath || !entry?.sha256) {
    throw new Error("Expected a hashed installer entry.");
  }
  const writeRootEvidenceId = evidence.evidence[0]?.evidenceId;
  if (!writeRootEvidenceId) throw new Error("Expected write-root evidence.");
  const target =
    mode === "smapi"
      ? path.join(fixture.gameRoot, "StardewModdingAPI.exe")
      : path.join(fixture.gameRoot, "Mods", "Loader");
  const targetRelativePath =
    mode === "smapi" ? "StardewModdingAPI.exe" : "Mods/Loader";
  const postConditionSubject =
    mode === "smapi"
      ? "StardewModdingAPI.exe"
      : "Mods/Loader/loader.txt";
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
        packageUnitId: unit.packageUnitId,
        packageRoot: unit.packageRoot,
        selectedComponents: [],
      },
      operations: [
        {
          operationId: randomUUID(),
          kind: "run_bundled_installer",
          entry: {
            source: "verified_staging",
            relativePath: entryPath,
            runtime: "fixed-script-runner",
            sha256: entry.sha256,
          },
          arguments: [target, mode],
          workingDirectory: "Installer",
          environmentPolicy: "minimal",
          timeoutMs: 10_000,
          allowedExitCodes: [0],
          declaredWriteRoots: [
            {
              scope: "game_root",
              path: targetRelativePath,
              evidenceIds: [writeRootEvidenceId],
            },
          ],
          postConditions: [
            {
              checkId: "fixture-loader-present",
              kind: "path_exists",
              subject: postConditionSubject,
              expected: "present",
              required: true,
              evidenceIds: [],
            },
          ],
          reversibilityLevel: "bounded",
        },
      ],
      preconditions: [],
      verificationRequirements: [],
      unresolvedChoices: [],
      risk: {
        level: "high",
        reasons: ["The archive contains an executable installation mechanism."],
      },
    },
  });
  const plan = await service.freezePlan({ proposalId: proposal.proposalId });
  return { service, plan, target };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Phase 6B V2 M3 controlled bundled installer", () => {
  it("freezes, explicitly applies, observes, and records a bounded installer", async () => {
    const fixture = await createFixture();
    const { service, plan, target } = await prepareInstaller(fixture, "success");
    expect(await stat(target).catch(() => null)).toBeNull();
    expect(plan.operations[0]).toMatchObject({
      kind: "run_bundled_installer",
      preStateSnapshots: [
        {
          root: { path: "Mods/Loader" },
          expectedPreState: { kind: "absent" },
        },
      ],
    });

    const result = await service.applyPlan(plan.planId);
    expect(result.executionKind).toBe("installer");
    if (result.executionKind !== "installer") {
      throw new Error("Expected controlled installer execution.");
    }
    expect(result.record).toMatchObject({
      state: "installed",
      verification: { static: "passed" },
      unexpectedChanges: [],
    });
    expect(await readFile(path.join(target, "loader.txt"), "utf8")).toBe(
      "installed",
    );
  });

  it("restores an existing declared root when the installer exits unsuccessfully", async () => {
    const fixture = await createFixture();
    const target = path.join(fixture.gameRoot, "Mods", "Loader");
    await mkdir(target);
    await writeFile(path.join(target, "original.txt"), "preserve");
    const prepared = await prepareInstaller(fixture, "fail");
    const result = await prepared.service.applyPlan(prepared.plan.planId);
    if (result.executionKind !== "installer") {
      throw new Error("Expected controlled installer execution.");
    }
    expect(result.record).toMatchObject({
      state: "rolled_back",
      process: { exitCode: 7 },
      recovery: { attempted: true, completed: true },
    });
    expect(await readFile(path.join(target, "original.txt"), "utf8")).toBe(
      "preserve",
    );
    expect(await stat(path.join(target, "loader.txt")).catch(() => null)).toBeNull();
  });

  it("marks recovery_required when an installer writes outside declared roots", async () => {
    const fixture = await createFixture();
    const { service, plan, target } = await prepareInstaller(
      fixture,
      "unexpected",
    );
    const result = await service.applyPlan(plan.planId);
    if (result.executionKind !== "installer") {
      throw new Error("Expected controlled installer execution.");
    }
    expect(result.record.state).toBe("recovery_required");
    expect(result.record.unexpectedChanges).toEqual(
      expect.arrayContaining([
        "Mods/Surprise",
        "Mods/Surprise/outside.txt",
      ]),
    );
    expect(await stat(target).catch(() => null)).toBeNull();
    expect(
      await readFile(
        path.join(fixture.gameRoot, "Mods", "Surprise", "outside.txt"),
        "utf8",
      ),
    ).toBe("unexpected");
  });

  it("does not rerun a plan when a durable journal shows an interrupted process", async () => {
    const fixture = await createFixture();
    const { service, plan, target } = await prepareInstaller(fixture, "success");
    const journals = await ControlledInstallerJournalStore.create(
      fixture.managerRoot,
    );
    const now = new Date().toISOString();
    await journals.save(
      {
        schemaVersion: 2,
        planId: plan.planId,
        planHash: plan.planHash,
        transactionId: randomUUID(),
        phase: "process_started",
        captures: [],
        process: {
          exitCode: null,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
        },
        observedChanges: [],
        unexpectedChanges: [],
        createdAt: now,
        updatedAt: now,
      },
      { create: true },
    );

    const result = await service.applyPlan(plan.planId);
    if (result.executionKind !== "installer") {
      throw new Error("Expected controlled installer recovery.");
    }
    expect(result.record).toMatchObject({
      state: "recovery_required",
      recovery: { attempted: true, completed: false },
    });
    expect(await stat(target).catch(() => null)).toBeNull();
  });

  it("re-probes a registered Game Context after installing a loader runtime", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.gameRoot, "Stardew Valley.exe"), "game");
    await mkdir(path.join(fixture.gameRoot, "Content"));
    const { service, plan } = await prepareInstaller(fixture, "smapi");
    const result = await service.applyPlan(plan.planId);
    if (result.executionKind !== "installer") {
      throw new Error("Expected controlled installer execution.");
    }
    expect(result.record).toMatchObject({
      state: "installed",
      verification: { static: "passed", contextReprobed: true },
    });
    expect(result.refreshedGameContext?.detectedLoaders).toEqual([
      expect.objectContaining({ loaderId: "smapi", state: "detected" }),
    ]);
  });

  it("records a successful Bundle loader node for dependency-first continuation", async () => {
    const fixture = await createFixture();
    const bundleId = randomUUID();
    const { service, plan } = await prepareInstaller(
      fixture,
      "success",
      bundleId,
    );
    const applied = await service.applyPlan(plan.planId);
    if (applied.executionKind !== "installer") {
      throw new Error("Expected controlled installer execution.");
    }
    expect(applied.record.bundle).toEqual({
      bundleId,
      nodeId: "loader-runtime",
    });
    expect(await service.getSatisfiedBundleNodeIds(bundleId)).toEqual([
      "loader-runtime",
    ]);
  });
});
