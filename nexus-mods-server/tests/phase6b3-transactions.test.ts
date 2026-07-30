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

import type { DownloadReceipt } from "../src/download-verifier.js";
import {
  AdapterRegistry,
  BackupStore,
  InstallService,
  InstallationRecordStore,
  inspectDirectoryTree,
  inspectInstallationState,
  inspectZipArchive,
  InstanceLock,
  planModInstall,
  planModUninstall,
  PlanStore,
  probeStardewValleyInstance,
  RecoveryManager,
  sha256File,
  SimulatedTransactionInterruption,
  SmapiFolderModAdapter,
  StagingManager,
  STARDEW_VALLEY_PROFILE,
  TransactionEngine,
  TransactionJournalStore,
  UninstallEngine,
  UninstallPlanStore,
  verifyInstallInput,
  analyzePackageInventory,
  type TransactionCheckpoint,
  type TransactionFaultInjector,
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

class FailAtCheckpoint implements TransactionFaultInjector {
  readonly checkpointName: TransactionCheckpoint;
  readonly interruption: boolean;
  transactionId: string | null = null;
  #triggered = false;

  constructor(
    checkpointName: TransactionCheckpoint,
    interruption = false,
  ) {
    this.checkpointName = checkpointName;
    this.interruption = interruption;
  }

  async checkpoint(
    checkpoint: TransactionCheckpoint,
    context: { transactionId: string },
  ): Promise<void> {
    this.transactionId = context.transactionId;
    if (this.#triggered || checkpoint !== this.checkpointName) return;
    this.#triggered = true;
    if (this.interruption) {
      throw new SimulatedTransactionInterruption(
        `Interrupted at ${checkpoint}.`,
      );
    }
    throw new Error(`Injected failure at ${checkpoint}.`);
  }
}

interface TransactionFixture {
  gameRoot: string;
  managerRoot: string;
  targetRoot: string;
  instance: Awaited<ReturnType<typeof probeStardewValleyInstance>>;
  analysis: Awaited<ReturnType<typeof analyzePackageInventory>>;
  verifiedInput: Awaited<ReturnType<typeof verifyInstallInput>>;
  packageUnitId: string;
  planId: string;
  planStore: PlanStore;
  stagingManager: StagingManager;
  backupStore: BackupStore;
  journalStore: TransactionJournalStore;
  recordStore: InstallationRecordStore;
  registry: AdapterRegistry;
}

async function createTransactionFixture(): Promise<TransactionFixture> {
  const downloadsRoot = await makeTemporaryDirectory("phase6b3-download-");
  const gameRoot = await makeTemporaryDirectory("phase6b3-game-");
  const managerRoot = await makeTemporaryDirectory("phase6b3-manager-");
  await writeFile(path.join(gameRoot, "Stardew Valley.exe"), "");
  await writeFile(path.join(gameRoot, "StardewModdingAPI.exe"), "");
  await mkdir(path.join(gameRoot, "Content"));
  await mkdir(path.join(gameRoot, "Mods"));

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
      content: "test-dll-payload",
    },
  ]);
  const archiveInfo = await stat(archivePath);
  const receiptPath = `${archivePath}.nexus-receipt.json`;
  const receipt: DownloadReceipt = {
    schemaVersion: 1,
    backend: "persistent_chromium",
    canonicalModUrl: "https://www.nexusmods.com/stardewvalley/mods/2697",
    domainName: "stardewvalley",
    modId: 2697,
    fileId: 115145,
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
      detail: "ZIP end-of-central-directory record found.",
    },
    browser: { engine: "chromium", backend: "playwright" },
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const verifiedInput = await verifyInstallInput({
    archivePath,
    receiptPath,
    expectedSource: {
      domainName: "stardewvalley",
      modId: 2697,
      fileId: 115145,
    },
  });
  const inventory = await inspectZipArchive({
    archive: verifiedInput.archive,
  });
  const analysis = await analyzePackageInventory(inventory);
  const packageUnit = analysis.packages[0];
  if (!packageUnit) throw new Error("Test package analysis failed.");

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
  const stagedPackage = await stagingManager.stagePackage({
    inventory,
    packageRoot: packageUnit.packageRoot,
  });
  const planStore = await PlanStore.create({ managerRoot });
  const registry = new AdapterRegistry([new SmapiFolderModAdapter()]);
  const planned = await planModInstall({
    analysis,
    profile: STARDEW_VALLEY_PROFILE,
    instance,
    stagedPackage,
    registry,
    planStore,
  });
  return {
    gameRoot,
    managerRoot,
    targetRoot: path.join(gameRoot, "Mods", "SkipFishingMinigame"),
    instance,
    analysis,
    verifiedInput,
    packageUnitId: packageUnit.packageUnitId,
    planId: planned.plan.planId,
    planStore,
    stagingManager,
    backupStore: await BackupStore.create(managerRoot),
    journalStore: await TransactionJournalStore.create(managerRoot),
    recordStore: await InstallationRecordStore.create(managerRoot),
    registry,
  };
}

function createInstallEngine(
  fixture: TransactionFixture,
  faultInjector?: TransactionFaultInjector,
): TransactionEngine {
  return new TransactionEngine({
    managerRoot: fixture.managerRoot,
    planStore: fixture.planStore,
    stagingManager: fixture.stagingManager,
    backupStore: fixture.backupStore,
    journalStore: fixture.journalStore,
    recordStore: fixture.recordStore,
    adapterRegistry: fixture.registry,
    processGuard: async () => undefined,
    ...(faultInjector === undefined ? {} : { faultInjector }),
  });
}

async function applyFixture(
  fixture: TransactionFixture,
  faultInjector?: TransactionFaultInjector,
) {
  return await createInstallEngine(fixture, faultInjector).applyInstallPlan({
    planId: fixture.planId,
    profile: STARDEW_VALLEY_PROFILE,
    instance: fixture.instance,
    analysis: fixture.analysis,
    packageUnitId: fixture.packageUnitId,
    verifiedInput: fixture.verifiedInput,
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Phase 6B-3 install transaction", () => {
  it("commits files, a journal, and an uninstall-ready Installation Record", async () => {
    const fixture = await createTransactionFixture();
    const result = await applyFixture(fixture);

    expect(result.journal.state).toBe("committed");
    expect(result.record.state).toBe("runtime_unverified");
    expect(result.record.operationOutcomes[0]).toMatchObject({
      operationKind: "install_tree",
      outcome: "applied",
      ownershipMode: "installed_file_set",
    });
    expect(result.record.operationOutcomes[0]?.ownedFiles).toHaveLength(2);
    expect(
      await readFile(path.join(fixture.targetRoot, "manifest.json"), "utf8"),
    ).toContain("DewMods.SkipFishingMinigame");
    expect(
      await fixture.recordStore.get(result.record.installationId),
    ).toEqual(result.record);

    const inspection = await inspectInstallationState({
      record: result.record,
      profile: STARDEW_VALLEY_PROFILE,
      instance: fixture.instance,
    });
    expect(inspection.blocking).toBe(false);
    expect(inspection.paths[0]?.state).toBe("unchanged");
  });

  it.each<TransactionCheckpoint>([
    "before_target_write",
    "after_target_write",
    "before_static_verify",
    "after_static_verify",
    "before_record_commit",
  ])("rolls back an injected failure at %s", async (checkpoint) => {
    const fixture = await createTransactionFixture();
    const fault = new FailAtCheckpoint(checkpoint);

    await expect(applyFixture(fixture, fault)).rejects.toMatchObject({
      details: expect.objectContaining({ rolledBack: true }),
    });
    expect(await stat(fixture.targetRoot).catch(() => null)).toBeNull();
    expect(fault.transactionId).not.toBeNull();
    if (fault.transactionId) {
      expect((await fixture.journalStore.read(fault.transactionId)).state).toBe(
        "rolled_back",
      );
    }
  });

  it("recovers an interrupted post-write transaction after a simulated restart", async () => {
    const fixture = await createTransactionFixture();
    const fault = new FailAtCheckpoint("after_target_write", true);

    await expect(applyFixture(fixture, fault)).rejects.toBeInstanceOf(
      SimulatedTransactionInterruption,
    );
    expect(await stat(fixture.targetRoot)).toBeTruthy();
    expect(fault.transactionId).not.toBeNull();

    const recovery = new RecoveryManager({
      managerRoot: fixture.managerRoot,
      planStore: fixture.planStore,
      backupStore: fixture.backupStore,
      journalStore: fixture.journalStore,
      recordStore: fixture.recordStore,
    });
    const recovered = await recovery.recoverInstall({
      transactionId: fault.transactionId ?? "",
      profile: STARDEW_VALLEY_PROFILE,
      instance: fixture.instance,
    });

    expect(recovered.action).toBe("rolled_back");
    expect(await stat(fixture.targetRoot).catch(() => null)).toBeNull();
  });

  it("finalizes the journal when interruption happens after Record commit", async () => {
    const fixture = await createTransactionFixture();
    const fault = new FailAtCheckpoint("after_record_commit", true);

    await expect(applyFixture(fixture, fault)).rejects.toBeInstanceOf(
      SimulatedTransactionInterruption,
    );
    const transactionId = fault.transactionId ?? "";
    const committedRecord = await fixture.recordStore.findByTransaction(
      fixture.instance.instanceId,
      transactionId,
    );
    expect(committedRecord).not.toBeNull();

    const recovered = await new RecoveryManager({
      managerRoot: fixture.managerRoot,
      planStore: fixture.planStore,
      backupStore: fixture.backupStore,
      journalStore: fixture.journalStore,
      recordStore: fixture.recordStore,
    }).recoverInstall({
      transactionId,
      profile: STARDEW_VALLEY_PROFILE,
      instance: fixture.instance,
    });

    expect(recovered).toMatchObject({
      action: "completed_commit",
      installationId: committedRecord?.installationId,
    });
    expect((await fixture.journalStore.read(transactionId)).state).toBe(
      "committed",
    );
  });
});

describe("Phase 6B-3 uninstall derivation and round-trip", () => {
  it("restores the pre-install filesystem through a separate Uninstall Plan", async () => {
    const fixture = await createTransactionFixture();
    const installed = await applyFixture(fixture);
    const uninstallPlanStore = await UninstallPlanStore.create({
      managerRoot: fixture.managerRoot,
    });
    const planned = await planModUninstall({
      record: installed.record,
      profile: STARDEW_VALLEY_PROFILE,
      instance: fixture.instance,
      planStore: uninstallPlanStore,
    });
    const lifecycleService = await InstallService.create({
      managerRoot: fixture.managerRoot,
    });
    await expect(
      lifecycleService.getUninstallPlanLifecycle(
        planned.plan.uninstallPlanId,
      ),
    ).resolves.toMatchObject({
      lifecycle: {
        state: "planned",
        reason: "awaiting_approval",
        transactionId: null,
      },
    });
    await expect(
      lifecycleService.getUninstallPlanLifecycle(
        planned.plan.uninstallPlanId,
        {
          now: new Date(Date.parse(planned.plan.expiresAt) + 1),
        },
      ),
    ).resolves.toMatchObject({
      lifecycle: {
        state: "stale",
        reason: "expired",
        transactionId: null,
      },
    });
    const result = await new UninstallEngine({
      managerRoot: fixture.managerRoot,
      planStore: uninstallPlanStore,
      backupStore: fixture.backupStore,
      journalStore: fixture.journalStore,
      recordStore: fixture.recordStore,
      processGuard: async () => undefined,
    }).applyUninstallPlan({
      uninstallPlanId: planned.plan.uninstallPlanId,
      profile: STARDEW_VALLEY_PROFILE,
      instance: fixture.instance,
    });

    expect(result.record.state).toBe("uninstalled");
    expect(result.record.revision).toBe(2);
    expect(await stat(fixture.targetRoot).catch(() => null)).toBeNull();
    await expect(
      lifecycleService.getUninstallPlanLifecycle(
        planned.plan.uninstallPlanId,
      ),
    ).resolves.toMatchObject({
      lifecycle: {
        state: "committed",
        reason: "transaction_committed",
        transactionId: result.transactionId,
        journalState: "uninstalled",
      },
    });
  });

  it("preserves generated configuration while removing unchanged owned files", async () => {
    const fixture = await createTransactionFixture();
    const installed = await applyFixture(fixture);
    await writeFile(path.join(fixture.targetRoot, "config.json"), '{"x":1}');
    const inspection = await inspectInstallationState({
      record: installed.record,
      profile: STARDEW_VALLEY_PROFILE,
      instance: fixture.instance,
    });
    expect(inspection.paths[0]?.state).toBe("unmanaged_extra");
    expect(inspection.paths[0]?.unmanagedFilePaths).toEqual([
      "Mods/SkipFishingMinigame/config.json",
    ]);
    expect(inspection.blocking).toBe(false);

    const uninstallPlanStore = await UninstallPlanStore.create({
      managerRoot: fixture.managerRoot,
    });
    const planned = await planModUninstall({
      record: installed.record,
      profile: STARDEW_VALLEY_PROFILE,
      instance: fixture.instance,
      planStore: uninstallPlanStore,
    });
    expect(planned.plan.retainedFilePaths).toEqual([
      "Mods/SkipFishingMinigame/config.json",
    ]);
    const result = await new UninstallEngine({
      managerRoot: fixture.managerRoot,
      planStore: uninstallPlanStore,
      backupStore: fixture.backupStore,
      journalStore: fixture.journalStore,
      recordStore: fixture.recordStore,
      processGuard: async () => undefined,
    }).applyUninstallPlan({
      uninstallPlanId: planned.plan.uninstallPlanId,
      profile: STARDEW_VALLEY_PROFILE,
      instance: fixture.instance,
    });

    expect(result.record.state).toBe("uninstalled_with_retained_data");
    expect(result.retainedFilePaths).toEqual([
      "Mods/SkipFishingMinigame/config.json",
    ]);
    expect(await readFile(path.join(fixture.targetRoot, "config.json"), "utf8")).toBe(
      '{"x":1}',
    );
    expect(
      await stat(path.join(fixture.targetRoot, "manifest.json")).catch(
        () => null,
      ),
    ).toBeNull();
  });

  it("treats generated files beside an exclusive install_tree as retained unmanaged data", async () => {
    const fixture = await createTransactionFixture();
    const installed = await applyFixture(fixture);
    const exclusiveRecord = {
      ...installed.record,
      operationOutcomes: installed.record.operationOutcomes.map((outcome) => ({
        ...outcome,
        ownershipMode:
          outcome.operationKind === "install_tree"
            ? ("exclusive_tree" as const)
            : outcome.ownershipMode,
      })),
    };
    await writeFile(path.join(fixture.targetRoot, "config.json"), '{"x":1}');

    const inspection = await inspectInstallationState({
      record: exclusiveRecord,
      profile: STARDEW_VALLEY_PROFILE,
      instance: fixture.instance,
    });
    expect(inspection.blocking).toBe(false);
    expect(inspection.paths[0]?.state).toBe("unmanaged_extra");
    expect(inspection.paths[0]?.unmanagedFilePaths).toEqual([
      "Mods/SkipFishingMinigame/config.json",
    ]);

    const uninstallPlanStore = await UninstallPlanStore.create({
      managerRoot: fixture.managerRoot,
    });
    const planned = await planModUninstall({
      record: exclusiveRecord,
      profile: STARDEW_VALLEY_PROFILE,
      instance: fixture.instance,
      planStore: uninstallPlanStore,
    });
    expect(planned.plan.retainedPaths).toEqual([
      "Mods/SkipFishingMinigame",
    ]);
    expect(planned.plan.retainedFilePaths).toEqual([
      "Mods/SkipFishingMinigame/config.json",
    ]);
    expect(planned.plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "delete_owned_file",
          targetRelativePath:
            "Mods/SkipFishingMinigame/manifest.json",
        }),
        expect.objectContaining({
          kind: "delete_owned_file",
          targetRelativePath:
            "Mods/SkipFishingMinigame/SkipFishingMinigame.dll",
        }),
      ]),
    );
  });

  it("blocks dirty owned files without deleting them", async () => {
    const fixture = await createTransactionFixture();
    const installed = await applyFixture(fixture);
    const exclusiveRecord = {
      ...installed.record,
      operationOutcomes: installed.record.operationOutcomes.map((outcome) => ({
        ...outcome,
        ownershipMode:
          outcome.operationKind === "install_tree"
            ? ("exclusive_tree" as const)
            : outcome.ownershipMode,
      })),
    };
    const dllPath = path.join(
      fixture.targetRoot,
      "SkipFishingMinigame.dll",
    );
    await writeFile(dllPath, "user-modified");
    const uninstallPlanStore = await UninstallPlanStore.create({
      managerRoot: fixture.managerRoot,
    });

    await expect(
      planModUninstall({
        record: exclusiveRecord,
        profile: STARDEW_VALLEY_PROFILE,
        instance: fixture.instance,
        planStore: uninstallPlanStore,
      }),
    ).rejects.toMatchObject({
      code: "INSTALLATION_DIRTY",
    });
    expect(await readFile(dllPath, "utf8")).toBe("user-modified");
  });

  it("skips an already-missing owned file but removes the remaining owned set", async () => {
    const fixture = await createTransactionFixture();
    const installed = await applyFixture(fixture);
    await rm(path.join(fixture.targetRoot, "SkipFishingMinigame.dll"));
    const uninstallPlanStore = await UninstallPlanStore.create({
      managerRoot: fixture.managerRoot,
    });
    const planned = await planModUninstall({
      record: installed.record,
      profile: STARDEW_VALLEY_PROFILE,
      instance: fixture.instance,
      planStore: uninstallPlanStore,
    });
    const result = await new UninstallEngine({
      managerRoot: fixture.managerRoot,
      planStore: uninstallPlanStore,
      backupStore: fixture.backupStore,
      journalStore: fixture.journalStore,
      recordStore: fixture.recordStore,
      processGuard: async () => undefined,
    }).applyUninstallPlan({
      uninstallPlanId: planned.plan.uninstallPlanId,
      profile: STARDEW_VALLEY_PROFILE,
      instance: fixture.instance,
    });

    expect(result.record.state).toBe("uninstalled");
    expect(await stat(fixture.targetRoot).catch(() => null)).toBeNull();
  });

  it.each<TransactionCheckpoint>([
    "before_backup",
    "after_backup",
    "before_target_write",
    "after_target_write",
  ])(
    "rolls back a failed uninstall at %s and keeps the Installation Record installed",
    async (checkpoint) => {
    const fixture = await createTransactionFixture();
    const installed = await applyFixture(fixture);
    const uninstallPlanStore = await UninstallPlanStore.create({
      managerRoot: fixture.managerRoot,
    });
    const planned = await planModUninstall({
      record: installed.record,
      profile: STARDEW_VALLEY_PROFILE,
      instance: fixture.instance,
      planStore: uninstallPlanStore,
    });
    const fault = new FailAtCheckpoint(checkpoint);
    const engine = new UninstallEngine({
      managerRoot: fixture.managerRoot,
      planStore: uninstallPlanStore,
      backupStore: fixture.backupStore,
      journalStore: fixture.journalStore,
      recordStore: fixture.recordStore,
      processGuard: async () => undefined,
      faultInjector: fault,
    });

    await expect(
      engine.applyUninstallPlan({
        uninstallPlanId: planned.plan.uninstallPlanId,
        profile: STARDEW_VALLEY_PROFILE,
        instance: fixture.instance,
      }),
    ).rejects.toMatchObject({
      code: "UNINSTALL_BLOCKED",
      details: expect.objectContaining({ rolledBack: true }),
    });
    expect(await stat(path.join(fixture.targetRoot, "manifest.json"))).toBeTruthy();
    expect(
      (await fixture.recordStore.get(installed.record.installationId)).state,
    ).toBe("runtime_unverified");
    await expect(
      (
        await InstallService.create({
          managerRoot: fixture.managerRoot,
        })
      ).getUninstallPlanLifecycle(planned.plan.uninstallPlanId),
    ).resolves.toMatchObject({
      lifecycle: {
        state: "failed",
        reason: "transaction_rolled_back",
        journalState: "installed_restored",
      },
    });
    },
  );

  it("recovers an interrupted uninstall and restores the installed state", async () => {
    const fixture = await createTransactionFixture();
    const installed = await applyFixture(fixture);
    const uninstallPlanStore = await UninstallPlanStore.create({
      managerRoot: fixture.managerRoot,
    });
    const planned = await planModUninstall({
      record: installed.record,
      profile: STARDEW_VALLEY_PROFILE,
      instance: fixture.instance,
      planStore: uninstallPlanStore,
    });
    const fault = new FailAtCheckpoint("after_target_write", true);
    const engine = new UninstallEngine({
      managerRoot: fixture.managerRoot,
      planStore: uninstallPlanStore,
      backupStore: fixture.backupStore,
      journalStore: fixture.journalStore,
      recordStore: fixture.recordStore,
      processGuard: async () => undefined,
      faultInjector: fault,
    });

    await expect(
      engine.applyUninstallPlan({
        uninstallPlanId: planned.plan.uninstallPlanId,
        profile: STARDEW_VALLEY_PROFILE,
        instance: fixture.instance,
      }),
    ).rejects.toBeInstanceOf(SimulatedTransactionInterruption);
    const lifecycleService = await InstallService.create({
      managerRoot: fixture.managerRoot,
    });
    await expect(
      lifecycleService.getUninstallPlanLifecycle(
        planned.plan.uninstallPlanId,
      ),
    ).resolves.toMatchObject({
      lifecycle: {
        state: "applying",
        reason: "transaction_active",
      },
    });
    const recovered = await new RecoveryManager({
      managerRoot: fixture.managerRoot,
      planStore: fixture.planStore,
      uninstallPlanStore,
      backupStore: fixture.backupStore,
      journalStore: fixture.journalStore,
      recordStore: fixture.recordStore,
    }).recoverUninstall({
      transactionId: fault.transactionId ?? "",
      profile: STARDEW_VALLEY_PROFILE,
      instance: fixture.instance,
    });

    expect(recovered.action).toBe("rolled_back");
    expect(await stat(path.join(fixture.targetRoot, "manifest.json"))).toBeTruthy();
    expect(
      (await fixture.recordStore.get(installed.record.installationId)).state,
    ).toBe("runtime_unverified");
    await expect(
      lifecycleService.getUninstallPlanLifecycle(
        planned.plan.uninstallPlanId,
      ),
    ).resolves.toMatchObject({
      lifecycle: {
        state: "failed",
        reason: "transaction_rolled_back",
        journalState: "installed_restored",
      },
    });
  });
});

describe("Phase 6B-3 infrastructure", () => {
  it("enforces one transaction lock per game instance", async () => {
    const managerRoot = await makeTemporaryDirectory("phase6b3-lock-");
    const instanceId = "11111111-1111-4111-8111-111111111111";
    const first = new InstanceLock({
      locksRoot: path.join(managerRoot, "locks"),
      instanceId,
      transactionId: "22222222-2222-4222-8222-222222222222",
    });
    const second = new InstanceLock({
      locksRoot: path.join(managerRoot, "locks"),
      instanceId,
      transactionId: "33333333-3333-4333-8333-333333333333",
    });
    await first.acquire();
    await expect(second.acquire()).rejects.toMatchObject({
      code: "LOCK_BUSY",
    });
    await first.release();
    await expect(second.acquire()).resolves.toBeUndefined();
    await second.release();
  });

  it("deduplicates file backup content while keeping distinct backup references", async () => {
    const managerRoot = await makeTemporaryDirectory("phase6b3-backup-");
    const sourceRoot = await makeTemporaryDirectory("phase6b3-source-");
    const source = path.join(sourceRoot, "file.bin");
    await writeFile(source, "same-content");
    const store = await BackupStore.create(managerRoot);
    const first = await store.backupFile(source);
    const second = await store.backupFile(source);

    expect(first.backupId).not.toBe(second.backupId);
    expect(first.sha256).toBe(second.sha256);
    expect(first.absolutePath).toBe(second.absolutePath);
    await expect(store.verify(first)).resolves.toBeUndefined();
  });

  it("backs up and restores a verified directory tree", async () => {
    const managerRoot = await makeTemporaryDirectory("phase6b3-backup-");
    const sourceRoot = await makeTemporaryDirectory("phase6b3-tree-");
    await mkdir(path.join(sourceRoot, "nested"));
    await writeFile(path.join(sourceRoot, "manifest.json"), "{}");
    await writeFile(path.join(sourceRoot, "nested", "payload.dll"), "dll");
    const store = await BackupStore.create(managerRoot);
    const backup = await store.backupTree(sourceRoot);
    const restoreParent = await makeTemporaryDirectory("phase6b3-restore-");
    const restoredRoot = path.join(restoreParent, "restored");

    await store.restoreTree(backup.backupId, restoredRoot);

    expect((await inspectDirectoryTree(restoredRoot)).treeHash).toBe(
      backup.sha256,
    );
  });
});
