import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256CanonicalJson } from "../src/install/content-hash.js";
import { sha256File } from "../src/install/file-hash.js";
import {
  type SaveBackupFaultInjector,
  SaveBackupService,
} from "../src/save/backup/save-backup-service.js";
import type { SaveContext } from "../src/save/contracts.js";
import { saveContextSchema } from "../src/save/contracts.js";
import { GameSaveProfileRegistry } from "../src/save/profiles/registry.js";
import { SaveContextStore } from "../src/save/storage/context-store.js";
import {
  gameInstallContextFixture,
  saveContextFixture,
} from "./fixtures/save-contract-fixtures.js";

const temporaryDirectories: string[] = [];

async function createFixture(options: {
  includeCompanion?: boolean;
  includeAuxiliary?: boolean;
  processGuard?: (names: ReadonlyArray<string>) => Promise<void>;
  faultInjector?: SaveBackupFaultInjector;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "save-m2-backup-"));
  temporaryDirectories.push(root);
  const managerRoot = path.join(root, "manager");
  const saveRoot = path.join(root, "AppData", "EldenRing", "76561198127396738");
  await Promise.all([
    mkdir(managerRoot, { recursive: true }),
    mkdir(saveRoot, { recursive: true }),
  ]);
  await writeFile(path.join(saveRoot, "ER0000.sl2"), "primary-v1");
  if (options.includeCompanion ?? true) {
    await writeFile(path.join(saveRoot, "ER0000.sl2.bak"), "companion-v1");
  }
  if (options.includeAuxiliary ?? true) {
    await writeFile(path.join(saveRoot, "steam_autocloud.vdf"), "cloud-v1");
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
  const backup = await SaveBackupService.create({
    managerRoot,
    contexts,
    profiles,
    processGuard: options.processGuard ?? (async () => undefined),
    ...(options.faultInjector === undefined
      ? {}
      : { faultInjector: options.faultInjector }),
  });
  return { root, managerRoot, saveRoot, contexts, context, backup };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(
      async (directory) =>
        await rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("save M2 backup", () => {
  it("creates, lists, reloads, and fully verifies a multi-file Save Unit", async () => {
    const fixture = await createFixture();
    const before = await Promise.all(
      ["ER0000.sl2", "ER0000.sl2.bak", "steam_autocloud.vdf"].map(
        async (name) => await sha256File(path.join(fixture.saveRoot, name)),
      ),
    );
    const record = await fixture.backup.createBackup({
      saveContextId: fixture.context.saveContextId,
      unitId: "vanilla-main",
      reason: "acceptance_baseline",
    });
    expect(record.files.map((file) => [file.relativePath, file.role])).toEqual([
      ["ER0000.sl2", "essential"],
      ["ER0000.sl2.bak", "companion"],
      ["steam_autocloud.vdf", "auxiliary"],
    ]);
    expect(record.sourcePreStateHash).toBe(record.sourcePostStateHash);
    expect(await fixture.backup.getBackup(record.backupId)).toEqual(record);
    expect(await fixture.backup.verifyBackup(record.backupId)).toEqual(record);
    expect(
      await fixture.backup.listBackups(fixture.context.saveContextId),
    ).toEqual([record]);
    const after = await Promise.all(
      ["ER0000.sl2", "ER0000.sl2.bak", "steam_autocloud.vdf"].map(
        async (name) => await sha256File(path.join(fixture.saveRoot, name)),
      ),
    );
    expect(after).toEqual(before);
  });

  it("allows absent optional files but rejects an absent essential file", async () => {
    const fixture = await createFixture({
      includeCompanion: false,
      includeAuxiliary: false,
    });
    const record = await fixture.backup.createBackup({
      saveContextId: fixture.context.saveContextId,
      unitId: "vanilla-main",
      reason: "manual",
    });
    expect(record.files.map((file) => file.relativePath)).toEqual([
      "ER0000.sl2",
    ]);
    await unlink(path.join(fixture.saveRoot, "ER0000.sl2"));
    await expect(
      fixture.backup.createBackup({
        saveContextId: fixture.context.saveContextId,
        unitId: "vanilla-main",
        reason: "manual",
      }),
    ).rejects.toMatchObject({ code: "SAVE_BACKUP_INVALID" });
  });

  it("retries one source change and records only a consistent second snapshot", async () => {
    let changed = false;
    let saveRoot = "";
    const faultInjector: SaveBackupFaultInjector = {
      checkpoint: async (checkpoint, context) => {
        if (
          !changed &&
          checkpoint === "after_object_backup" &&
          context.relativePath === "ER0000.sl2"
        ) {
          changed = true;
          await writeFile(path.join(saveRoot, "ER0000.sl2"), "primary-v2");
        }
      },
    };
    const fixture = await createFixture({ faultInjector });
    saveRoot = fixture.saveRoot;
    const record = await fixture.backup.createBackup({
      saveContextId: fixture.context.saveContextId,
      unitId: "vanilla-main",
      reason: "manual",
    });
    expect(record.sourcePreStateHash).toBe(record.sourcePostStateHash);
    expect(record.files.find((file) => file.relativePath === "ER0000.sl2")?.sha256)
      .toBe(await sha256File(path.join(saveRoot, "ER0000.sl2")));
  });

  it("fails after two changing snapshots and publishes no Backup Record", async () => {
    let saveRoot = "";
    let mutation = 0;
    const fixture = await createFixture({
      faultInjector: {
        checkpoint: async (checkpoint, context) => {
          if (
            checkpoint === "after_object_backup" &&
            context.relativePath === "ER0000.sl2"
          ) {
            mutation += 1;
            await writeFile(
              path.join(saveRoot, "ER0000.sl2"),
              `mutation-${mutation}`,
            );
          }
        },
      },
    });
    saveRoot = fixture.saveRoot;
    await expect(
      fixture.backup.createBackup({
        saveContextId: fixture.context.saveContextId,
        unitId: "vanilla-main",
        reason: "manual",
      }),
    ).rejects.toMatchObject({ code: "SAVE_SOURCE_CHANGED_DURING_BACKUP" });
    expect(await fixture.backup.listBackups()).toEqual([]);
  });

  it("runs the profile process guard before publishing any backup", async () => {
    const guard = vi.fn(async () => {
      throw new Error("process guard blocked");
    });
    const fixture = await createFixture({ processGuard: guard });
    await expect(
      fixture.backup.createBackup({
        saveContextId: fixture.context.saveContextId,
        unitId: "vanilla-main",
        reason: "manual",
      }),
    ).rejects.toThrow("process guard blocked");
    expect(guard).toHaveBeenCalledWith([
      "eldenring.exe",
      "start_protected_game.exe",
      "steam.exe",
    ]);
    expect(await fixture.backup.listBackups()).toEqual([]);
  });

  it("detects a corrupt content-addressed object", async () => {
    const fixture = await createFixture();
    const record = await fixture.backup.createBackup({
      saveContextId: fixture.context.saveContextId,
      unitId: "vanilla-main",
      reason: "manual",
    });
    const first = record.files[0];
    expect(first).toBeDefined();
    if (!first) return;
    const object = await fixture.backup.objectStore.get(first.backupObjectId);
    await writeFile(object.absolutePath, "corrupt");
    await expect(
      fixture.backup.verifyBackup(record.backupId),
    ).rejects.toMatchObject({ code: "SAVE_BACKUP_INVALID" });
  });
});
