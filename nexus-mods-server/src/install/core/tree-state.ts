import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../content-hash.js";
import type { PathState } from "../contracts.js";
import { sha256File } from "../file-hash.js";

export interface TreeFile {
  relativePath: string;
  absolutePath: string;
  bytes: number;
  sha256: string;
}

export interface TreeDirectory {
  relativePath: string;
  absolutePath: string;
}

export interface DirectoryTreeState {
  treeHash: string;
  files: ReadonlyArray<TreeFile>;
  directories: ReadonlyArray<TreeDirectory>;
  totalBytes: number;
}

function unsafeFilesystemEntry(
  message: string,
  details: Record<string, unknown>,
): never {
  throw new NexusError("PROTECTED_PATH", message, { details });
}

function normalizedTreePath(value: string): string {
  return value.split(path.sep).join("/").normalize("NFC");
}

export async function inspectDirectoryTree(
  rootAbsolutePath: string,
  limits?: { maxEntries: number; maxSingleEntryBytes: number; maxTotalUncompressedBytes: number },
): Promise<DirectoryTreeState> {
  const root = path.resolve(rootAbsolutePath);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      "A directory tree root must be a real directory.",
      { details: { rootAbsolutePath: root } },
    );
  }

  const files: TreeFile[] = [];
  const directories: TreeDirectory[] = [];
  const caseFoldedPaths = new Map<string, string>();
  let totalSeenBytes = 0;

  async function walk(currentAbsolutePath: string, currentRelativePath: string): Promise<void> {
    const children = await readdir(currentAbsolutePath, { withFileTypes: true });
    children.sort((left, right) =>
      left.name.localeCompare(right.name, "en", { sensitivity: "variant" }),
    );
    for (const child of children) {
      if (limits && files.length + directories.length >= limits.maxEntries) {
        throw new NexusError("SAVE_ARCHIVE_UNSAFE", "Directory exceeds the entry limit.");
      }
      const absolutePath = path.join(currentAbsolutePath, child.name);
      const relativePath = normalizedTreePath(
        currentRelativePath
          ? path.join(currentRelativePath, child.name)
          : child.name,
      );
      const folded = relativePath.toLowerCase();
      const collision = caseFoldedPaths.get(folded);
      if (collision !== undefined) {
        unsafeFilesystemEntry(
          "The directory tree contains paths that collide on Windows.",
          { firstPath: collision, secondPath: relativePath },
        );
      }
      caseFoldedPaths.set(folded, relativePath);

      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        unsafeFilesystemEntry(
          "Staged and managed directory trees must not contain symbolic links or junctions.",
          { path: absolutePath },
        );
      }
      if (info.isDirectory()) {
        directories.push({ relativePath, absolutePath });
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!info.isFile()) {
        unsafeFilesystemEntry(
          "Staged and managed directory trees may contain only regular files and directories.",
          { path: absolutePath },
        );
      }
      totalSeenBytes += info.size;
      if (limits && (info.size > limits.maxSingleEntryBytes || totalSeenBytes > limits.maxTotalUncompressedBytes)) {
        throw new NexusError("SAVE_ARCHIVE_UNSAFE", "Directory exceeds the input byte limits.");
      }
      files.push({
        relativePath,
        absolutePath,
        bytes: info.size,
        sha256: await sha256File(absolutePath),
      });
    }
  }

  await walk(root, "");
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const treeHash = sha256CanonicalJson({
    files: files.map((file) => ({
      relativePath: file.relativePath,
      bytes: file.bytes,
      sha256: file.sha256,
    })),
    directories: directories.map((directory) => directory.relativePath),
  });
  return { treeHash, files, directories, totalBytes };
}

export async function inspectPathState(
  absolutePath: string,
): Promise<PathState> {
  let info;
  try {
    info = await lstat(absolutePath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { kind: "absent" };
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    unsafeFilesystemEntry(
      "Managed target state must not traverse a symbolic link or junction.",
      { absolutePath },
    );
  }
  if (info.isFile()) {
    return {
      kind: "file",
      bytes: info.size,
      sha256: await sha256File(absolutePath),
    };
  }
  if (info.isDirectory()) {
    const tree = await inspectDirectoryTree(absolutePath);
    return {
      kind: "directory",
      treeHash: tree.treeHash,
      entries: tree.files.length + tree.directories.length,
    };
  }
  unsafeFilesystemEntry(
    "Managed target state must be absent, a regular file, or a real directory.",
    { absolutePath },
  );
}
