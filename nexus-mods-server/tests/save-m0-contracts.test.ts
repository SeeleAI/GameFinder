import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  gameInstallContextSchema,
  saveBackupRecordSchema,
  saveContextSchema,
  saveOperationRecordSchema,
  saveReplacementPlanSchema,
  saveRestorePlanSchema,
  saveTransactionRecordSchema,
  standardSavePackageSchema,
  verifyHashedContract,
} from "../src/save/contracts.js";
import {
  assertNoSaveReparsePointTraversal,
  resolveSaveTarget,
} from "../src/save/path-policy.js";
import { SaveContextStore } from "../src/save/storage/context-store.js";
import {
  backupRecordFixture,
  gameInstallContextFixture,
  operationRecordFixture,
  replacementPlanFixture,
  restorePlanFixture,
  saveContextFixture,
  standardPackageFixture,
  transactionFixture,
} from "./fixtures/save-contract-fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(
        async (directory) =>
          await rm(directory, { recursive: true, force: true }),
      ),
  );
});

describe("save M0 contracts", () => {
  it("accepts the frozen context, package, backup, plan, transaction, and record fixtures", () => {
    const install = gameInstallContextSchema.parse(
      gameInstallContextFixture(),
    );
    const save = saveContextSchema.parse(
      saveContextFixture(install.installContextId),
    );
    const backup = saveBackupRecordSchema.parse(backupRecordFixture());
    const pkg = standardSavePackageSchema.parse(standardPackageFixture());
    const restore = saveRestorePlanSchema.parse(restorePlanFixture());
    const replacement = saveReplacementPlanSchema.parse(
      replacementPlanFixture(),
    );
    const transaction = saveTransactionRecordSchema.parse(
      transactionFixture(),
    );
    const record = saveOperationRecordSchema.parse(operationRecordFixture());

    expect(verifyHashedContract(install, "contextHash")).toBe(true);
    expect(verifyHashedContract(save, "contextHash")).toBe(true);
    expect(verifyHashedContract(backup, "backupRecordHash")).toBe(true);
    expect(verifyHashedContract(pkg, "manifestHash")).toBe(true);
    expect(verifyHashedContract(restore, "planHash")).toBe(true);
    expect(verifyHashedContract(replacement, "planHash")).toBe(true);
    expect(verifyHashedContract(transaction, "transactionHash")).toBe(true);
    expect(verifyHashedContract(record, "recordHash")).toBe(true);
  });

  it("rejects malformed hashes, non-UUID identities, and unmanaged absolute paths", () => {
    expect(() =>
      gameInstallContextSchema.parse({
        ...gameInstallContextFixture(),
        installContextId: "not-a-uuid",
      }),
    ).toThrow();
    expect(() =>
      saveBackupRecordSchema.parse({
        ...backupRecordFixture(),
        treeHash: "not-a-hash",
      }),
    ).toThrow();
    expect(() =>
      resolveSaveTarget({
        saveRoot:
          "C:\\Users\\fixture\\AppData\\Roaming\\EldenRing\\76561198127396738",
        targetRelativePath: "C:\\Windows\\System32\\drivers\\etc\\hosts",
        managedPaths: ["ER0000.sl2"],
        platform: "win32",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "SAVE_PATH_INVALID" }),
    );
  });
});

describe("SaveRootPolicy", () => {
  it("allows only declared managed paths under a non-broad frozen root", () => {
    const saveRoot =
      "C:\\Users\\fixture\\AppData\\Roaming\\EldenRing\\76561198127396738";
    expect(
      resolveSaveTarget({
        saveRoot,
        targetRelativePath: "ER0000.sl2",
        managedPaths: ["ER0000.sl2", "ER0000.sl2.bak"],
        forbiddenRoots: [
          "C:\\Users\\fixture",
          "C:\\Users\\fixture\\AppData\\Roaming",
        ],
        platform: "win32",
      }),
    ).toMatchObject({
      saveRoot,
      targetRelativePath: "ER0000.sl2",
      managedPath: "ER0000.sl2",
    });
    expect(() =>
      resolveSaveTarget({
        saveRoot,
        targetRelativePath: "..\\GraphicsConfig.xml",
        managedPaths: ["ER0000.sl2"],
        platform: "win32",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "SAVE_PATH_INVALID" }),
    );
    expect(() =>
      resolveSaveTarget({
        saveRoot,
        targetRelativePath: "unmanaged.txt",
        managedPaths: ["ER0000.sl2"],
        platform: "win32",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "SAVE_PATH_PROTECTED" }),
    );
    expect(() =>
      resolveSaveTarget({
        saveRoot: "C:\\Users\\fixture\\AppData\\Roaming",
        targetRelativePath: "EldenRing\\save.sl2",
        managedPaths: ["EldenRing"],
        forbiddenRoots: ["C:\\Users\\fixture\\AppData\\Roaming"],
        platform: "win32",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "SAVE_PATH_PROTECTED" }),
    );
  });

  it("rejects reparse-point traversal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "save-policy-"));
    temporaryDirectories.push(root);
    const outside = await mkdtemp(path.join(os.tmpdir(), "save-outside-"));
    temporaryDirectories.push(outside);
    const linked = path.join(root, "linked");
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(
      assertNoSaveReparsePointTraversal(
        root,
        path.join(linked, "ER0000.sl2"),
      ),
    ).rejects.toMatchObject({ code: "SAVE_PATH_PROTECTED" });
  });
});

describe("SaveContextStore", () => {
  it("persists immutable hashed contexts and detects stored tampering", async () => {
    const managerRoot = await mkdtemp(path.join(os.tmpdir(), "save-store-"));
    temporaryDirectories.push(managerRoot);
    const store = await SaveContextStore.create(managerRoot);
    const install = gameInstallContextFixture();
    await store.saveInstallContext(install);
    expect(await store.getInstallContext(install.installContextId)).toEqual(
      install,
    );

    const storedPath = path.join(
      managerRoot,
      "save-manager",
      "install-contexts",
      `${install.installContextId}.json`,
    );
    const tampered = JSON.parse(await readFile(storedPath, "utf8")) as {
      game: { displayName: string };
    };
    tampered.game.displayName = "TAMPERED";
    await writeFile(storedPath, `${JSON.stringify(tampered)}\n`);
    await expect(
      store.getInstallContext(install.installContextId),
    ).rejects.toMatchObject({ code: "SAVE_CONTEXT_STALE" });
  });

  it("rejects a filesystem root as managerRoot", async () => {
    await expect(
      SaveContextStore.create(path.parse(process.cwd()).root),
    ).rejects.toMatchObject({ code: "SAVE_PATH_PROTECTED" });
  });
});
