import { createWriteStream } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ZipFile } from "yazl";
import { afterEach, describe, expect, it } from "vitest";

import {
  AdapterRegistry,
  analyzePackageInventory,
  inspectOperationConflict,
  inspectZipArchive,
  planModInstall,
  PlanStore,
  probeStardewValleyInstance,
  sha256File,
  SmapiFolderModAdapter,
  StagingManager,
  STARDEW_VALLEY_PROFILE,
} from "../src/install/index.js";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
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

async function createPackageFixture(): Promise<{
  downloadsRoot: string;
  inventory: Awaited<ReturnType<typeof inspectZipArchive>>;
  analysis: Awaited<ReturnType<typeof analyzePackageInventory>>;
}> {
  const downloadsRoot = await makeTemporaryDirectory("phase6b2-download-");
  const archivePath = path.join(downloadsRoot, "SkipFishingMinigame.zip");
  await writeZip(archivePath, [
    {
      path: "SkipFishingMinigame/manifest.json",
      content: JSON.stringify({
        Name: "Skip Fishing Minigame",
        Author: "DewMods",
        Version: "0.7.4",
        UniqueID: "DewMods.SkipFishingMinigame",
        EntryDll: "SkipFishingMinigame.dll",
        MinimumApiVersion: "3.0.0",
      }),
    },
    {
      path: "SkipFishingMinigame/SkipFishingMinigame.dll",
      content: "test-dll",
    },
    {
      path: "Unselected/readme.txt",
      content: "must not be staged",
    },
  ]);
  const info = await stat(archivePath);
  const inventory = await inspectZipArchive({
    archive: {
      absolutePath: archivePath,
      fileName: path.basename(archivePath),
      bytes: info.size,
      sha256: await sha256File(archivePath),
    },
  });
  return {
    downloadsRoot,
    inventory,
    analysis: await analyzePackageInventory(inventory),
  };
}

async function createGameFixture(options: {
  withSmapi: boolean;
}): Promise<string> {
  const gameRoot = await makeTemporaryDirectory("phase6b2-game-");
  await writeFile(path.join(gameRoot, "Stardew Valley.exe"), "");
  await mkdir(path.join(gameRoot, "Content"));
  await mkdir(path.join(gameRoot, "Mods"));
  if (options.withSmapi) {
    await writeFile(path.join(gameRoot, "StardewModdingAPI.exe"), "");
  }
  return gameRoot;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Phase 6B-2 staging", () => {
  it("extracts only the selected package root outside the game directory", async () => {
    const fixture = await createPackageFixture();
    const gameRoot = await createGameFixture({ withSmapi: true });
    const managerRoot = await makeTemporaryDirectory("phase6b2-manager-");
    const stagingManager = await StagingManager.create({
      managerRoot,
      gameRoot,
      liveModRoots: ["Mods"],
    });

    const staged = await stagingManager.stagePackage({
      inventory: fixture.inventory,
      packageRoot: fixture.analysis.packages[0]?.packageRoot ?? "",
    });

    expect(staged.packageRoot).toBe("SkipFishingMinigame");
    expect(staged.files.map((file) => file.relativePath)).toEqual([
      "manifest.json",
      "SkipFishingMinigame.dll",
    ]);
    expect(
      await stat(path.join(staged.stagingRoot, "Unselected")).catch(() => null),
    ).toBeNull();
    expect(
      await stat(path.join(gameRoot, "Mods", "SkipFishingMinigame")).catch(
        () => null,
      ),
    ).toBeNull();

    await stagingManager.cleanup(staged.stagingId);
    expect(await stat(staged.stagingRoot).catch(() => null)).toBeNull();
  });

  it("rejects a Manager staging root inside the game directory", async () => {
    const gameRoot = await createGameFixture({ withSmapi: true });

    await expect(
      StagingManager.create({
        managerRoot: path.join(gameRoot, ".manager"),
        gameRoot,
        liveModRoots: ["Mods"],
      }),
    ).rejects.toMatchObject({
      code: "PROTECTED_PATH",
    });
  });
});

describe("Phase 6B-2 SMAPI dry-run planning", () => {
  it("classifies a protected target as a blocking conflict", async () => {
    const gameRoot = await createGameFixture({ withSmapi: true });
    const inspection = await inspectOperationConflict({
      operation: {
        operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "install_new_file",
        sourceRelativePath: "payload.xnb",
        sourceSha256: "a".repeat(64),
        targetRelativePath: "Content/payload.xnb",
        expectedPreState: { kind: "absent" },
        expectedPostState: {
          kind: "file",
          bytes: 1,
          sha256: "a".repeat(64),
        },
      },
      gameRoot,
      writableRoots: STARDEW_VALLEY_PROFILE.filesystem.writableRoots,
      protectedRoots: STARDEW_VALLEY_PROFILE.filesystem.protectedRoots,
    });

    expect(inspection.conflict).toMatchObject({
      kind: "protected_path",
      blocking: true,
    });
  });

  it("freezes a new-path SMAPI install plan without modifying the game", async () => {
    const fixture = await createPackageFixture();
    const gameRoot = await createGameFixture({ withSmapi: true });
    const managerRoot = await makeTemporaryDirectory("phase6b2-manager-");
    const instance = await probeStardewValleyInstance({
      gameRoot,
      platform: "steam",
      platformAppId: "413150",
    });
    const stagingManager = await StagingManager.create({
      managerRoot,
      gameRoot,
      liveModRoots: ["Mods"],
    });
    const staged = await stagingManager.stagePackage({
      inventory: fixture.inventory,
      packageRoot: fixture.analysis.packages[0]?.packageRoot ?? "",
    });
    const planStore = await PlanStore.create({ managerRoot });
    const registry = new AdapterRegistry([new SmapiFolderModAdapter()]);

    const result = await planModInstall({
      analysis: fixture.analysis,
      profile: STARDEW_VALLEY_PROFILE,
      instance,
      stagedPackage: staged,
      registry,
      planStore,
    });

    expect(result.plan.adapterId).toBe("smapi-folder-mod");
    expect(result.plan.staging).toEqual({
      stagingId: staged.stagingId,
      packageRoot: staged.packageRoot,
      sourceTreeHash: staged.treeHash,
    });
    expect(result.plan.operations).toContainEqual(
      expect.objectContaining({
        kind: "install_tree",
        sourceRelativePath: "SkipFishingMinigame",
        targetRelativePath: "Mods/SkipFishingMinigame",
        sourceTreeHash: staged.treeHash,
        expectedPreState: { kind: "absent" },
      }),
    );
    expect(result.plan.conflicts).toEqual([
      expect.objectContaining({ kind: "new_path", blocking: false }),
    ]);
    expect(Object.isFrozen(result.plan)).toBe(true);
    expect(await planStore.get(result.plan.planId)).toEqual(result.plan);
    await expect(
      planStore.assertPreconditions({
        plan: result.plan,
        profile: STARDEW_VALLEY_PROFILE,
        instance,
      }),
    ).resolves.toBeUndefined();
    expect(
      await stat(path.join(gameRoot, "Mods", "SkipFishingMinigame")).catch(
        () => null,
      ),
    ).toBeNull();
  });

  it("blocks plan creation when SMAPI is missing", async () => {
    const fixture = await createPackageFixture();
    const gameRoot = await createGameFixture({ withSmapi: false });
    const managerRoot = await makeTemporaryDirectory("phase6b2-manager-");
    const instance = await probeStardewValleyInstance({ gameRoot });
    const stagingManager = await StagingManager.create({
      managerRoot,
      gameRoot,
      liveModRoots: ["Mods"],
    });
    const staged = await stagingManager.stagePackage({
      inventory: fixture.inventory,
      packageRoot: fixture.analysis.packages[0]?.packageRoot ?? "",
    });

    await expect(
      planModInstall({
        analysis: fixture.analysis,
        profile: STARDEW_VALLEY_PROFILE,
        instance,
        stagedPackage: staged,
        registry: new AdapterRegistry([new SmapiFolderModAdapter()]),
        planStore: await PlanStore.create({ managerRoot }),
      }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_MISSING",
    });
  });

  it("blocks an unmanaged existing target instead of overwriting it", async () => {
    const fixture = await createPackageFixture();
    const gameRoot = await createGameFixture({ withSmapi: true });
    await mkdir(path.join(gameRoot, "Mods", "SkipFishingMinigame"));
    await writeFile(
      path.join(gameRoot, "Mods", "SkipFishingMinigame", "foreign.txt"),
      "unmanaged",
    );
    const managerRoot = await makeTemporaryDirectory("phase6b2-manager-");
    const instance = await probeStardewValleyInstance({ gameRoot });
    const stagingManager = await StagingManager.create({
      managerRoot,
      gameRoot,
      liveModRoots: ["Mods"],
    });
    const staged = await stagingManager.stagePackage({
      inventory: fixture.inventory,
      packageRoot: fixture.analysis.packages[0]?.packageRoot ?? "",
    });

    await expect(
      planModInstall({
        analysis: fixture.analysis,
        profile: STARDEW_VALLEY_PROFILE,
        instance,
        stagedPackage: staged,
        registry: new AdapterRegistry([new SmapiFolderModAdapter()]),
        planStore: await PlanStore.create({ managerRoot }),
      }),
    ).rejects.toMatchObject({
      code: "INSTALL_CONFLICT",
      details: {
        conflicts: [
          expect.objectContaining({
            kind: "unmanaged_existing",
            blocking: true,
          }),
        ],
      },
    });
  });

  it("invalidates a frozen plan after target filesystem drift", async () => {
    const fixture = await createPackageFixture();
    const gameRoot = await createGameFixture({ withSmapi: true });
    const managerRoot = await makeTemporaryDirectory("phase6b2-manager-");
    const instance = await probeStardewValleyInstance({ gameRoot });
    const stagingManager = await StagingManager.create({
      managerRoot,
      gameRoot,
      liveModRoots: ["Mods"],
    });
    const staged = await stagingManager.stagePackage({
      inventory: fixture.inventory,
      packageRoot: fixture.analysis.packages[0]?.packageRoot ?? "",
    });
    const planStore = await PlanStore.create({ managerRoot });
    const result = await planModInstall({
      analysis: fixture.analysis,
      profile: STARDEW_VALLEY_PROFILE,
      instance,
      stagedPackage: staged,
      registry: new AdapterRegistry([new SmapiFolderModAdapter()]),
      planStore,
    });
    await mkdir(path.join(gameRoot, "Mods", "SkipFishingMinigame"));

    await expect(
      planStore.assertPreconditions({
        plan: result.plan,
        profile: STARDEW_VALLEY_PROFILE,
        instance,
      }),
    ).rejects.toMatchObject({
      code: "PLAN_STALE",
    });
  });

  it("detects persisted Plan tampering and expiration", async () => {
    const fixture = await createPackageFixture();
    const gameRoot = await createGameFixture({ withSmapi: true });
    const managerRoot = await makeTemporaryDirectory("phase6b2-manager-");
    const instance = await probeStardewValleyInstance({ gameRoot });
    const stagingManager = await StagingManager.create({
      managerRoot,
      gameRoot,
      liveModRoots: ["Mods"],
    });
    const staged = await stagingManager.stagePackage({
      inventory: fixture.inventory,
      packageRoot: fixture.analysis.packages[0]?.packageRoot ?? "",
    });
    const planStore = await PlanStore.create({
      managerRoot,
      defaultTtlMs: 1_000,
    });
    const result = await planModInstall({
      analysis: fixture.analysis,
      profile: STARDEW_VALLEY_PROFILE,
      instance,
      stagedPackage: staged,
      registry: new AdapterRegistry([new SmapiFolderModAdapter()]),
      planStore,
    });
    const planPath = path.join(
      managerRoot,
      "plans",
      `${result.plan.planId}.json`,
    );
    const stored = JSON.parse(await readFile(planPath, "utf8")) as Record<
      string,
      unknown
    >;
    stored.adapterVersion = "tampered";
    await writeFile(planPath, `${JSON.stringify(stored, null, 2)}\n`);

    await expect(planStore.get(result.plan.planId)).rejects.toMatchObject({
      code: "PLAN_STALE",
    });

    stored.adapterVersion = result.plan.adapterVersion;
    await writeFile(planPath, `${JSON.stringify(stored, null, 2)}\n`);
    await expect(
      planStore.get(result.plan.planId, {
        now: new Date(Date.parse(result.plan.expiresAt) + 1),
      }),
    ).rejects.toMatchObject({
      code: "PLAN_STALE",
    });
  });
});
