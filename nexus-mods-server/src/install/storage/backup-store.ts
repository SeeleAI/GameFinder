import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import type { BackupObject } from "../contracts.js";
import { backupObjectSchema } from "../contracts.js";
import { sha256File } from "../file-hash.js";
import { inspectDirectoryTree } from "../core/tree-state.js";

async function publishJsonExclusive(
  filePath: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await link(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export class BackupStore {
  readonly #root: string;
  readonly #fileObjectsRoot: string;
  readonly #treeObjectsRoot: string;
  readonly #referencesRoot: string;

  private constructor(root: string) {
    this.#root = root;
    this.#fileObjectsRoot = path.join(root, "objects", "files");
    this.#treeObjectsRoot = path.join(root, "objects", "trees");
    this.#referencesRoot = path.join(root, "references");
  }

  static async create(managerRoot: string): Promise<BackupStore> {
    if (!path.isAbsolute(managerRoot)) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Backup Store managerRoot must be absolute.",
      );
    }
    const resolvedManagerRoot = path.resolve(managerRoot);
    if (resolvedManagerRoot === path.parse(resolvedManagerRoot).root) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "A filesystem root cannot be used for the Backup Store.",
      );
    }
    const root = path.join(resolvedManagerRoot, "backups");
    await mkdir(path.join(root, "objects", "files"), { recursive: true });
    await mkdir(path.join(root, "objects", "trees"), { recursive: true });
    await mkdir(path.join(root, "references"), { recursive: true });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new NexusError(
        "PROTECTED_PATH",
        "Backup Store root must be a real directory.",
        { details: { root } },
      );
    }
    return new BackupStore(root);
  }

  async backupFile(sourceAbsolutePath: string): Promise<BackupObject> {
    const info = await stat(sourceAbsolutePath);
    if (!info.isFile()) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Only regular files can be stored as file backups.",
        { details: { sourceAbsolutePath } },
      );
    }
    const sha256 = await sha256File(sourceAbsolutePath);
    const objectPath = path.join(
      this.#fileObjectsRoot,
      sha256.slice(0, 2),
      sha256,
    );
    await mkdir(path.dirname(objectPath), { recursive: true });
    try {
      await stat(objectPath);
      if (await sha256File(objectPath) !== sha256) {
        throw new NexusError(
          "BACKUP_MISSING",
          "An existing content-addressed backup file is corrupt.",
          { details: { objectPath, sha256 } },
        );
      }
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        throw error;
      }
      const temporaryPath = `${objectPath}.${randomUUID()}.tmp`;
      await copyFile(sourceAbsolutePath, temporaryPath, constants.COPYFILE_EXCL);
      try {
        if (await sha256File(temporaryPath) !== sha256) {
          throw new NexusError(
            "BACKUP_MISSING",
            "A backup file failed post-copy verification.",
          );
        }
        try {
          await link(temporaryPath, objectPath);
        } catch (publishError) {
          if (
            !(
              publishError instanceof Error &&
              "code" in publishError &&
              publishError.code === "EEXIST"
            )
          ) {
            throw publishError;
          }
        }
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }

    return await this.#createReference({
      objectKind: "file",
      sha256,
      bytes: info.size,
      absolutePath: objectPath,
    });
  }

  async backupTree(sourceAbsolutePath: string): Promise<BackupObject> {
    const tree = await inspectDirectoryTree(sourceAbsolutePath);
    const objectPath = path.join(
      this.#treeObjectsRoot,
      tree.treeHash.slice(0, 2),
      tree.treeHash,
    );
    await mkdir(path.dirname(objectPath), { recursive: true });
    let exists = false;
    try {
      const existing = await inspectDirectoryTree(objectPath);
      if (existing.treeHash !== tree.treeHash) {
        throw new NexusError(
          "BACKUP_MISSING",
          "An existing content-addressed tree backup is corrupt.",
          { details: { objectPath, expectedTreeHash: tree.treeHash } },
        );
      }
      exists = true;
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        throw error;
      }
    }
    if (!exists) {
      const temporaryPath = `${objectPath}.${randomUUID()}.tmp`;
      await mkdir(temporaryPath);
      try {
        await this.#copyTree(tree, temporaryPath);
        const copied = await inspectDirectoryTree(temporaryPath);
        if (copied.treeHash !== tree.treeHash) {
          throw new NexusError(
            "BACKUP_MISSING",
            "A tree backup failed post-copy verification.",
          );
        }
        try {
          await rename(temporaryPath, objectPath);
        } catch (publishError) {
          if (
            !(
              publishError instanceof Error &&
              "code" in publishError &&
              (publishError.code === "EEXIST" ||
                publishError.code === "ENOTEMPTY")
            )
          ) {
            throw publishError;
          }
        }
      } finally {
        await rm(temporaryPath, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }

    return await this.#createReference({
      objectKind: "directory-tree",
      sha256: tree.treeHash,
      bytes: tree.totalBytes,
      absolutePath: objectPath,
    });
  }

  async get(backupId: string): Promise<BackupObject> {
    const referencePath = this.#referencePath(backupId);
    let backup: BackupObject;
    try {
      backup = backupObjectSchema.parse(
        JSON.parse(await readFile(referencePath, "utf8")) as unknown,
      );
    } catch (error) {
      throw new NexusError(
        "BACKUP_MISSING",
        "Backup metadata is missing or invalid.",
        { cause: error, details: { backupId } },
      );
    }
    await this.verify(backup);
    return backup;
  }

  async verify(backup: BackupObject): Promise<void> {
    if (backup.objectKind === "file") {
      const info = await stat(backup.absolutePath).catch((error: unknown) => {
        throw new NexusError("BACKUP_MISSING", "Backup file is missing.", {
          cause: error,
          details: { backupId: backup.backupId },
        });
      });
      if (
        !info.isFile() ||
        info.size !== backup.bytes ||
        (await sha256File(backup.absolutePath)) !== backup.sha256
      ) {
        throw new NexusError(
          "BACKUP_MISSING",
          "Backup file failed integrity verification.",
          { details: { backupId: backup.backupId } },
        );
      }
      return;
    }
    const tree = await inspectDirectoryTree(backup.absolutePath).catch(
      (error: unknown) => {
        throw new NexusError("BACKUP_MISSING", "Backup tree is missing.", {
          cause: error,
          details: { backupId: backup.backupId },
        });
      },
    );
    if (tree.treeHash !== backup.sha256 || tree.totalBytes !== backup.bytes) {
      throw new NexusError(
        "BACKUP_MISSING",
        "Backup tree failed integrity verification.",
        { details: { backupId: backup.backupId } },
      );
    }
  }

  async restoreFile(backupId: string, targetAbsolutePath: string): Promise<void> {
    const backup = await this.get(backupId);
    if (backup.objectKind !== "file") {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "A directory-tree backup cannot be restored as a file.",
      );
    }
    await mkdir(path.dirname(targetAbsolutePath), { recursive: true });
    const temporaryPath = `${targetAbsolutePath}.${randomUUID()}.restore`;
    await copyFile(backup.absolutePath, temporaryPath, constants.COPYFILE_EXCL);
    try {
      if (await sha256File(temporaryPath) !== backup.sha256) {
        throw new NexusError(
          "BACKUP_MISSING",
          "Restored file failed integrity verification.",
        );
      }
      await rename(temporaryPath, targetAbsolutePath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async restoreTree(backupId: string, targetAbsolutePath: string): Promise<void> {
    const backup = await this.get(backupId);
    if (backup.objectKind !== "directory-tree") {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "A file backup cannot be restored as a directory tree.",
      );
    }
    const sourceTree = await inspectDirectoryTree(backup.absolutePath);
    const temporaryPath = `${targetAbsolutePath}.${randomUUID()}.restore`;
    await mkdir(temporaryPath, { recursive: false });
    try {
      await this.#copyTree(sourceTree, temporaryPath);
      const restored = await inspectDirectoryTree(temporaryPath);
      if (restored.treeHash !== backup.sha256) {
        throw new NexusError(
          "BACKUP_MISSING",
          "Restored tree failed integrity verification.",
        );
      }
      await rename(temporaryPath, targetAbsolutePath);
    } finally {
      await rm(temporaryPath, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  async #createReference(
    input: Omit<BackupObject, "schemaVersion" | "backupId" | "createdAt" | "referenceCount">,
  ): Promise<BackupObject> {
    const backup = backupObjectSchema.parse({
      schemaVersion: 1,
      backupId: randomUUID(),
      ...input,
      createdAt: new Date().toISOString(),
      referenceCount: 1,
    });
    await publishJsonExclusive(this.#referencePath(backup.backupId), backup);
    return backup;
  }

  #referencePath(backupId: string): string {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        backupId,
      )
    ) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "backupId must be a UUID.",
      );
    }
    return path.join(this.#referencesRoot, `${backupId}.json`);
  }

  async #copyTree(
    tree: Awaited<ReturnType<typeof inspectDirectoryTree>>,
    targetRoot: string,
  ): Promise<void> {
    for (const directory of tree.directories) {
      await mkdir(
        path.join(targetRoot, ...directory.relativePath.split("/")),
        { recursive: true },
      );
    }
    for (const file of tree.files) {
      const targetPath = path.join(
        targetRoot,
        ...file.relativePath.split("/"),
      );
      await mkdir(path.dirname(targetPath), { recursive: true });
      await copyFile(file.absolutePath, targetPath, constants.COPYFILE_EXCL);
    }
  }
}
