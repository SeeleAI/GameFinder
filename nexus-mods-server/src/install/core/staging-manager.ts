import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Entry, ZipFile } from "yauzl";
import yauzl from "yauzl";

import { NexusError } from "../../errors.js";
import type {
  ArchiveInventory,
  ArchiveInventoryEntry,
} from "../archive-inspector.js";
import type { ArchiveIdentity } from "../contracts.js";
import { sha256File } from "../file-hash.js";
import { normalizeManagedRelativePath } from "../path-policy.js";
import {
  inspectDirectoryTree,
  type TreeDirectory,
  type TreeFile,
} from "./tree-state.js";

export interface StagedPackage {
  schemaVersion: 1;
  stagingId: string;
  stagingRoot: string;
  packageRoot: string;
  packageAbsolutePath: string;
  archive: ArchiveIdentity;
  treeHash: string;
  totalBytes: number;
  files: ReadonlyArray<TreeFile>;
  directories: ReadonlyArray<TreeDirectory>;
  createdAt: string;
}

export interface StagingManagerOptions {
  managerRoot: string;
  gameRoot: string;
  liveModRoots: ReadonlyArray<string>;
}

function isWithin(basePath: string, targetPath: string): boolean {
  const relative = path.relative(basePath, targetPath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function selectedByPackageRoot(
  entry: ArchiveInventoryEntry,
  packageRoot: string,
): boolean {
  return (
    packageRoot === "." ||
    entry.normalizedPath === packageRoot ||
    entry.normalizedPath.startsWith(`${packageRoot}/`)
  );
}

function stagingError(
  code: "ARCHIVE_UNSAFE" | "INSTALL_CONTRACT_INVALID",
  message: string,
  details: Record<string, unknown>,
  cause?: unknown,
): NexusError {
  return new NexusError(code, message, {
    details,
    ...(cause === undefined ? {} : { cause }),
  });
}

export class StagingManager {
  readonly #managerRoot: string;
  readonly #stagingRoot: string;
  readonly #gameRoot: string;
  readonly #liveModRoots: ReadonlyArray<string>;

  private constructor(options: {
    managerRoot: string;
    stagingRoot: string;
    gameRoot: string;
    liveModRoots: ReadonlyArray<string>;
  }) {
    this.#managerRoot = options.managerRoot;
    this.#stagingRoot = options.stagingRoot;
    this.#gameRoot = options.gameRoot;
    this.#liveModRoots = options.liveModRoots;
  }

  static async create(options: StagingManagerOptions): Promise<StagingManager> {
    if (!path.isAbsolute(options.managerRoot) || !path.isAbsolute(options.gameRoot)) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "managerRoot and gameRoot must be absolute paths.",
      );
    }
    const managerRoot = path.resolve(options.managerRoot);
    const gameRoot = path.resolve(options.gameRoot);
    if (
      managerRoot === path.parse(managerRoot).root ||
      gameRoot === path.parse(gameRoot).root
    ) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Filesystem roots cannot be used as managerRoot or gameRoot.",
      );
    }
    if (isWithin(gameRoot, managerRoot)) {
      throw new NexusError(
        "PROTECTED_PATH",
        "The Manager staging root must not be inside the game directory.",
        { details: { managerRoot, gameRoot } },
      );
    }
    const liveModRoots = options.liveModRoots.map((root) => {
      const absoluteRoot = path.isAbsolute(root)
        ? path.resolve(root)
        : path.resolve(gameRoot, root);
      if (isWithin(absoluteRoot, managerRoot)) {
        throw new NexusError(
          "PROTECTED_PATH",
          "The Manager staging root must not be inside a live Mod directory.",
          { details: { managerRoot, liveModRoot: absoluteRoot } },
        );
      }
      return absoluteRoot;
    });

    await mkdir(managerRoot, { recursive: true });
    const managerInfo = await lstat(managerRoot);
    if (!managerInfo.isDirectory() || managerInfo.isSymbolicLink()) {
      throw new NexusError(
        "PROTECTED_PATH",
        "managerRoot must be a real directory, not a symbolic link or junction.",
        { details: { managerRoot } },
      );
    }
    const stagingRoot = path.join(managerRoot, "staging");
    await mkdir(stagingRoot, { recursive: true });
    const stagingInfo = await lstat(stagingRoot);
    if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink()) {
      throw new NexusError(
        "PROTECTED_PATH",
        "The staging container must be a real directory.",
        { details: { stagingRoot } },
      );
    }
    return new StagingManager({
      managerRoot,
      stagingRoot,
      gameRoot,
      liveModRoots,
    });
  }

  get managerRoot(): string {
    return this.#managerRoot;
  }

  get gameRoot(): string {
    return this.#gameRoot;
  }

  get liveModRoots(): ReadonlyArray<string> {
    return this.#liveModRoots;
  }

  resolveStagingRoot(stagingId: string): string {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        stagingId,
      )
    ) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "stagingId must be a UUID.",
      );
    }
    const resolved = path.resolve(this.#stagingRoot, stagingId);
    if (!isWithin(this.#stagingRoot, resolved) || resolved === this.#stagingRoot) {
      throw new NexusError(
        "PROTECTED_PATH",
        "The staging ID escapes the Manager staging root.",
      );
    }
    return resolved;
  }

  async stagePackage(input: {
    inventory: ArchiveInventory;
    packageRoot: string;
  }): Promise<StagedPackage> {
    const packageRoot =
      input.packageRoot === "."
        ? "."
        : normalizeManagedRelativePath(input.packageRoot, "win32");
    if (await sha256File(input.inventory.archive.absolutePath) !== input.inventory.archive.sha256) {
      throw new NexusError(
        "INPUT_RECEIPT_MISMATCH",
        "The archive changed after Package Analysis.",
        { details: { archivePath: input.inventory.archive.absolutePath } },
      );
    }
    const selectedEntries = input.inventory.entries.filter((entry) =>
      selectedByPackageRoot(entry, packageRoot),
    );
    const selectedFiles = selectedEntries.filter((entry) => entry.kind === "file");
    if (selectedFiles.length === 0) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "The selected package root contains no files.",
        { details: { packageRoot } },
      );
    }

    const stagingId = randomUUID();
    const stagingRoot = this.resolveStagingRoot(stagingId);
    await mkdir(stagingRoot, { recursive: false });
    try {
      await this.#extractSelectedEntries(
        input.inventory,
        stagingRoot,
        selectedEntries,
      );
      const packageAbsolutePath =
        packageRoot === "."
          ? stagingRoot
          : path.resolve(stagingRoot, ...packageRoot.split("/"));
      if (!isWithin(stagingRoot, packageAbsolutePath)) {
        throw stagingError(
          "ARCHIVE_UNSAFE",
          "The selected package root escapes its staging directory.",
          { packageRoot },
        );
      }
      const tree = await inspectDirectoryTree(packageAbsolutePath);
      if (tree.files.length !== selectedFiles.length) {
        throw stagingError(
          "ARCHIVE_UNSAFE",
          "The extracted file count differs from the inspected ZIP inventory.",
          {
            expectedFiles: selectedFiles.length,
            extractedFiles: tree.files.length,
          },
        );
      }
      const expectedBytes = selectedFiles.reduce(
        (sum, entry) => sum + entry.uncompressedBytes,
        0,
      );
      if (tree.totalBytes !== expectedBytes) {
        throw stagingError(
          "ARCHIVE_UNSAFE",
          "The extracted byte count differs from the inspected ZIP inventory.",
          { expectedBytes, extractedBytes: tree.totalBytes },
        );
      }
      return {
        schemaVersion: 1,
        stagingId,
        stagingRoot,
        packageRoot,
        packageAbsolutePath,
        archive: input.inventory.archive,
        treeHash: tree.treeHash,
        totalBytes: tree.totalBytes,
        files: tree.files,
        directories: tree.directories,
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async cleanup(stagingId: string): Promise<void> {
    const stagingRoot = this.resolveStagingRoot(stagingId);
    await rm(stagingRoot, { recursive: true, force: true });
  }

  async #extractSelectedEntries(
    inventory: ArchiveInventory,
    stagingRoot: string,
    selectedEntries: ReadonlyArray<ArchiveInventoryEntry>,
  ): Promise<void> {
    const selectedByOriginalPath = new Map(
      selectedEntries.map((entry) => [entry.originalPath, entry]),
    );
    let zipFile: ZipFile;
    try {
      zipFile = await yauzl.openPromise(inventory.archive.absolutePath, {
        autoClose: false,
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: false,
      });
    } catch (error) {
      throw new NexusError(
        "ARCHIVE_UNSUPPORTED",
        "The ZIP could not be reopened for staging.",
        { cause: error },
      );
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let extractedEntries = 0;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        if (zipFile.isOpen) zipFile.close();
        reject(error);
      };

      zipFile.on("error", fail);
      zipFile.on("entry", (entry: Entry) => {
        const inventoryEntry = selectedByOriginalPath.get(entry.fileName);
        if (!inventoryEntry) {
          zipFile.readEntry();
          return;
        }
        void (async () => {
          const targetPath = path.resolve(
            stagingRoot,
            ...inventoryEntry.normalizedPath.split("/"),
          );
          if (!isWithin(stagingRoot, targetPath) || targetPath === stagingRoot) {
            throw stagingError(
              "ARCHIVE_UNSAFE",
              "A staged ZIP entry escapes the staging root.",
              { entryPath: entry.fileName },
            );
          }
          if (inventoryEntry.kind === "directory") {
            await mkdir(targetPath, { recursive: true });
          } else {
            await mkdir(path.dirname(targetPath), { recursive: true });
            const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
            try {
              const source = await zipFile.openReadStreamPromise(entry);
              await pipeline(
                source,
                createWriteStream(temporaryPath, { flags: "wx" }),
              );
              const extractedInfo = await stat(temporaryPath);
              if (
                !extractedInfo.isFile() ||
                extractedInfo.size !== inventoryEntry.uncompressedBytes
              ) {
                throw stagingError(
                  "ARCHIVE_UNSAFE",
                  "A staged file does not match its inspected ZIP size.",
                  {
                    entryPath: entry.fileName,
                    expectedBytes: inventoryEntry.uncompressedBytes,
                    actualBytes: extractedInfo.size,
                  },
                );
              }
              await rename(temporaryPath, targetPath);
            } catch (error) {
              await unlink(temporaryPath).catch(() => undefined);
              throw error;
            }
          }
          extractedEntries += 1;
          zipFile.readEntry();
        })().catch(fail);
      });
      zipFile.on("end", () => {
        if (settled) return;
        settled = true;
        if (zipFile.isOpen) zipFile.close();
        if (extractedEntries !== selectedEntries.length) {
          reject(
            stagingError(
              "ARCHIVE_UNSAFE",
              "The ZIP changed after inventory inspection.",
              {
                selectedEntries: selectedEntries.length,
                extractedEntries,
              },
            ),
          );
          return;
        }
        resolve();
      });
      zipFile.readEntry();
    });
  }
}
