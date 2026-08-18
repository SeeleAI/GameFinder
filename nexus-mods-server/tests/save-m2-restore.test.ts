import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sha256CanonicalJson } from "../src/install/content-hash.js";
import { sha256File } from "../src/install/file-hash.js";
import { SaveBackupService } from "../src/save/backup/save-backup-service.js";
import type { SaveContext } from "../src/save/contracts.js";
import { saveContextSchema } from "../src/save/contracts.js";
import { GameSaveProfileRegistry } from "../src/save/profiles/registry.js";
import {
  type SaveRestoreCheckpoint,
  type SaveRestoreFaultInjector,
  SaveRestoreService,
} from "../src/save/restore/save-restore-service.js";
import { SaveContextStore } from "../src/save/storage/context-store.js";
import {
  gameInstallContextFixture,
  saveContextFixture,
} from "./fixtures/save-contract-fixtures.js";

const temporaryDirectories: string[] = [];

async function createFixture(options: {
  restoreFaultInjector?: SaveRestoreFaultInjector;
  processGuard?: (names: ReadonlyArray<string>) => Promise<void>;
  companion?: boolean;
  auxiliary?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "save-m2-restore-"));
  temporaryDirectories.push(root);
  const managerRoot = path.join(root, "manager");
  const saveRoot = path.join(root, "user", "EldenRing", "account");
  await Promise.all([
    mkdir(managerRoot, { recursive: true }),
    mkdir(saveRoot, { recursive: true }),
  ]);
  await writeFile(path.join(saveRoot, "ER0000.sl2"), "original-primary");
  if (options.companion ?? true) {
    await writeFile(path.join(saveRoot, "ER0000.sl2.bak"), "original-companion");
  }
  if (options.auxiliary ?? true) {
    await writeFile(path.join(saveRoot, "steam_autocloud.vdf"), "original-cloud");
  }
  const contexts = await SaveContextStore.create(managerRoot);
  const install = gameInstallContextFixture();
  await contexts.saveInstallContext(install);
  const base = saveContextFixture(install.installContextId);
  const { contextHash: _oldHash, ...withoutOldHash } = base;
  const withoutHash = {
    ...withoutOldHash,
    saveRoots: [
      {
        rootId: "primary",
        absolutePath: saveRoot,
        role: "primary" as const,
      },
    ],
  };
  const context: SaveContext = saveContextSchema.parse({
    ...withoutHash,
    contextHash: sha256CanonicalJson(withoutHash),
  });
  await contexts.saveSaveContext(context);
  const profiles = new GameSaveProfileRegistry();
  const backups = await SaveBackupService.create({
    managerRoot,
    contexts,
    profiles,
    processGuard: options.processGuard ?? (async () => undefined),
  });
  const restores = await SaveRestoreService.create({
    managerRoot,
    contexts,
    backups,
    ...(options.restoreFaultInjector === undefined
      ? {}
      : { faultInjector: options.restoreFaultInjector }),
  });
  return { root, managerRoot, saveRoot, context, backups, restores };
}

async function snapshotFiles(root: string, names: ReadonlyArray<string>) {
  return await Promise.all(
    names.map(async (name) => ({
      name,
      content: await readFile(path.join(root, name), "utf8").catch(() => null),
      hash: await sha256File(path.join(root, name)).catch(() => null),
    })),
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(
      async (directory) => await rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("save M2 restore planning", () => {
  it("plans overlay without deleting optional or unmanaged files", async () => {
    const fixture = await createFixture({ companion: false, auxiliary: false });
    const backup = await fixture.backups.createBackup({
      saveContextId: fixture.context.saveContextId,
      unitId: "vanilla-main",
      reason: "manual",
    });
    await writeFile(path.join(fixture.saveRoot, "ER0000.sl2"), "later-primary");
    await writeFile(path.join(fixture.saveRoot, "ER0000.sl2.bak"), "later-companion");
    await writeFile(path.join(fixture.saveRoot, "GraphicsConfig.xml"), "unmanaged");
    const plan = await fixture.restores.planRestore({
      backupId: backup.backupId,
      saveContextId: fixture.context.saveContextId,
      mode: "overlay",
    });
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]?.kind).toBe("replace-file");
    expect(plan.operations[0]?.targetRelativePath).toBe("ER0000.sl2");
  });

  it("exact mode deletes only declared managed files absent from the backup", async () => {
    const fixture = await createFixture({ companion: false, auxiliary: false });
    const backup = await fixture.backups.createBackup({
      saveContextId: fixture.context.saveContextId,
      unitId: "vanilla-main",
      reason: "manual",
    });
    await writeFile(path.join(fixture.saveRoot, "ER0000.sl2.bak"), "later-companion");
    await writeFile(path.join(fixture.saveRoot, "steam_autocloud.vdf"), "later-cloud");
    await writeFile(path.join(fixture.saveRoot, "GraphicsConfig.xml"), "unmanaged");
    const plan = await fixture.restores.planRestore({
      backupId: backup.backupId,
      saveContextId: fixture.context.saveContextId,
      mode: "exact_managed_snapshot",
    });
    expect(
      plan.operations
        .filter((operation) => operation.kind === "delete-file")
        .map((operation) => operation.targetRelativePath),
    ).toEqual(["ER0000.sl2.bak", "steam_autocloud.vdf"]);
    expect(JSON.stringify(plan)).not.toContain("GraphicsConfig.xml");
  });

  it("invalidates a sandbox plan when its target drifts before approval", async () => {
    const fixture = await createFixture();
    const backup = await fixture.backups.createBackup({
      saveContextId: fixture.context.saveContextId,
      unitId: "vanilla-main",
      reason: "manual",
    });
    const plan = await fixture.restores.planRestore({
      backupId: backup.backupId,
      saveContextId: fixture.context.saveContextId,
      mode: "overlay",
      targetKind: "sandbox",
    });
    await mkdir(plan.target.absolutePath, { recursive: true });
    await writeFile(path.join(plan.target.absolutePath, "ER0000.sl2"), "drifted");
    await expect(fixture.restores.applyRestore(plan.restorePlanId)).rejects.toMatchObject({
      code: "SAVE_TARGET_DRIFTED",
    });
  });
});

describe("save M2 restore execution", () => {
  it("restores a verified backup into a controlled sandbox and replays idempotently", async () => {
    const fixture = await createFixture();
    const backup = await fixture.backups.createBackup({
      saveContextId: fixture.context.saveContextId,
      unitId: "vanilla-main",
      reason: "acceptance_baseline",
    });
    const plan = await fixture.restores.planRestore({
      backupId: backup.backupId,
      saveContextId: fixture.context.saveContextId,
      mode: "exact_managed_snapshot",
      targetKind: "sandbox",
    });
    const first = await fixture.restores.applyRestore(plan.restorePlanId);
    expect(first.idempotentReplay).toBe(false);
    for (const file of backup.files) {
      expect(await sha256File(path.join(plan.target.absolutePath, file.relativePath)))
        .toBe(file.sha256);
    }
    expect(await fixture.restores.verifyRestore(first.record.recordId)).toEqual(first.record);
    const beforeReplay = await snapshotFiles(
      plan.target.absolutePath,
      backup.files.map((file) => file.relativePath),
    );
    const replay = await fixture.restores.applyRestore(plan.restorePlanId);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.record).toEqual(first.record);
    expect(
      await snapshotFiles(
        plan.target.absolutePath,
        backup.files.map((file) => file.relativePath),
      ),
    ).toEqual(beforeReplay);
  });

  it("creates and verifies a live rescue backup before the first target write", async () => {
    const fixture = await createFixture();
    const source = await fixture.backups.createBackup({
      saveContextId: fixture.context.saveContextId,
      unitId: "vanilla-main",
      reason: "manual",
    });
    await writeFile(path.join(fixture.saveRoot, "ER0000.sl2"), "newer-live-state");
    const plan = await fixture.restores.planRestore({
      backupId: source.backupId,
      saveContextId: fixture.context.saveContextId,
      mode: "overlay",
    });
    await fixture.restores.applyRestore(plan.restorePlanId);
    const rescues = (await fixture.backups.listBackups(fixture.context.saveContextId))
      .filter((backup) => backup.reason === "pre_restore_rescue");
    expect(rescues).toHaveLength(1);
    await expect(fixture.backups.verifyBackup(rescues[0]!.backupId)).resolves.toEqual(rescues[0]);
    expect(
      (await readFile(path.join(fixture.saveRoot, "ER0000.sl2"), "utf8")),
    ).toBe("original-primary");
  });

  it("performs zero writes when the mandatory rescue backup fails", async () => {
    let guardCalls = 0;
    const fixture = await createFixture({
      processGuard: async () => {
        guardCalls += 1;
        if (guardCalls === 2) throw new Error("simulated rescue failure");
      },
    });
    const source = await fixture.backups.createBackup({
      saveContextId: fixture.context.saveContextId,
      unitId: "vanilla-main",
      reason: "manual",
    });
    await writeFile(path.join(fixture.saveRoot, "ER0000.sl2"), "current-live-state");
    const before = await snapshotFiles(fixture.saveRoot, [
      "ER0000.sl2",
      "ER0000.sl2.bak",
      "steam_autocloud.vdf",
    ]);
    const plan = await fixture.restores.planRestore({
      backupId: source.backupId,
      saveContextId: fixture.context.saveContextId,
      mode: "overlay",
    });
    await expect(fixture.restores.applyRestore(plan.restorePlanId)).rejects.toMatchObject({
      code: "SAVE_RESCUE_BACKUP_FAILED",
    });
    expect(
      await snapshotFiles(fixture.saveRoot, [
        "ER0000.sl2",
        "ER0000.sl2.bak",
        "steam_autocloud.vdf",
      ]),
    ).toEqual(before);
  });

  for (const checkpoint of [
    "after_target_write",
    "before_static_verify",
    "before_record_commit",
  ] satisfies SaveRestoreCheckpoint[]) {
    it(`rolls the live Save Unit back exactly after a ${checkpoint} fault`, async () => {
      let injected = false;
      const fixture = await createFixture({
        restoreFaultInjector: {
          checkpoint: async (actual) => {
            if (!injected && actual === checkpoint) {
              injected = true;
              throw new Error(`fault:${checkpoint}`);
            }
          },
        },
      });
      const source = await fixture.backups.createBackup({
        saveContextId: fixture.context.saveContextId,
        unitId: "vanilla-main",
        reason: "manual",
      });
      await Promise.all([
        writeFile(path.join(fixture.saveRoot, "ER0000.sl2"), "current-primary"),
        writeFile(path.join(fixture.saveRoot, "ER0000.sl2.bak"), "current-companion"),
        writeFile(path.join(fixture.saveRoot, "steam_autocloud.vdf"), "current-cloud"),
      ]);
      const before = await snapshotFiles(fixture.saveRoot, [
        "ER0000.sl2",
        "ER0000.sl2.bak",
        "steam_autocloud.vdf",
      ]);
      const plan = await fixture.restores.planRestore({
        backupId: source.backupId,
        saveContextId: fixture.context.saveContextId,
        mode: "overlay",
      });
      await expect(fixture.restores.applyRestore(plan.restorePlanId)).rejects.toThrow(
        `fault:${checkpoint}`,
      );
      expect(
        await snapshotFiles(fixture.saveRoot, [
          "ER0000.sl2",
          "ER0000.sl2.bak",
          "steam_autocloud.vdf",
        ]),
      ).toEqual(before);
      expect((await readdir(fixture.saveRoot)).some((name) => name.includes("gamefinder-")))
        .toBe(false);
    });
  }
});
