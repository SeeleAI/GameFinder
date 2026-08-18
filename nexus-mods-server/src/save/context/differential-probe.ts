import { readdir, lstat } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import { sha256File } from "../../install/file-hash.js";
import type {
  SaveProbeSnapshot,
} from "../contracts.js";
import { saveProbeSnapshotSchema } from "../contracts.js";

export interface SnapshotLimits {
  maxDepth: number;
  maxEntries: number;
  maxHashBytesPerFile: number;
  maxTotalHashBytes: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  maxDepth: 5,
  maxEntries: 5_000,
  maxHashBytesPerFile: 64 * 1024 * 1024,
  maxTotalHashBytes: 256 * 1024 * 1024,
};

export async function snapshotSaveRoot(
  root: string,
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): Promise<SaveProbeSnapshot> {
  if (!path.isAbsolute(root)) {
    throw new NexusError(
      "SAVE_CONTRACT_INVALID",
      "Differential probe roots must be absolute.",
      { details: { root } },
    );
  }
  const resolvedRoot = path.resolve(root);
  const rootInfo = await lstat(resolvedRoot).catch((error: unknown) => {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  });
  if (rootInfo?.isSymbolicLink()) {
    throw new NexusError(
      "SAVE_PATH_PROTECTED",
      "Differential probes do not traverse symbolic-link roots.",
      { details: { root: resolvedRoot } },
    );
  }
  if (rootInfo && !rootInfo.isDirectory()) {
    throw new NexusError(
      "SAVE_CONTRACT_INVALID",
      "Differential probe roots must be directories.",
      { details: { root: resolvedRoot } },
    );
  }
  const entries: SaveProbeSnapshot["entries"] = [];
  let truncated = false;
  let totalHashedBytes = 0;

  const walk = async (current: string, depth: number): Promise<void> => {
    if (truncated || depth > limits.maxDepth) {
      truncated = true;
      return;
    }
    const children = await readdir(current, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (entries.length >= limits.maxEntries) {
        truncated = true;
        return;
      }
      const absolutePath = path.join(current, child.name);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) continue;
      const relativePath = path
        .relative(resolvedRoot, absolutePath)
        .split(path.sep)
        .join("/");
      if (info.isDirectory()) {
        entries.push({
          relativePath,
          kind: "directory",
          bytes: 0,
          modifiedAtMs: Math.max(0, Math.trunc(info.mtimeMs)),
          sha256: null,
        });
        await walk(absolutePath, depth + 1);
      } else if (info.isFile()) {
        const canHash =
          info.size <= limits.maxHashBytesPerFile &&
          totalHashedBytes + info.size <= limits.maxTotalHashBytes;
        const hash = canHash ? await sha256File(absolutePath) : null;
        if (canHash) totalHashedBytes += info.size;
        entries.push({
          relativePath,
          kind: "file",
          bytes: info.size,
          modifiedAtMs: Math.max(0, Math.trunc(info.mtimeMs)),
          sha256: hash,
        });
      }
    }
  };

  if (rootInfo) await walk(resolvedRoot, 0);
  entries.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  const withoutHash = {
    root: resolvedRoot,
    exists: rootInfo !== null,
    entries,
    truncated,
  };
  return saveProbeSnapshotSchema.parse({
    ...withoutHash,
    snapshotHash: sha256CanonicalJson(withoutHash),
  });
}

export function diffSaveSnapshots(
  before: ReadonlyArray<SaveProbeSnapshot>,
  after: ReadonlyArray<SaveProbeSnapshot>,
): Array<{
  root: string;
  relativePath: string;
  kind: "created" | "modified" | "deleted";
  before: SaveProbeSnapshot["entries"][number] | null;
  after: SaveProbeSnapshot["entries"][number] | null;
}> {
  const beforeRoots = new Map(before.map((snapshot) => [snapshot.root, snapshot]));
  const changes: ReturnType<typeof diffSaveSnapshots> = [];
  for (const afterSnapshot of after) {
    const beforeSnapshot = beforeRoots.get(afterSnapshot.root);
    const left = new Map(
      (beforeSnapshot?.entries ?? []).map((entry) => [
        entry.relativePath,
        entry,
      ]),
    );
    const right = new Map(
      afterSnapshot.entries.map((entry) => [entry.relativePath, entry]),
    );
    const paths = new Set([...left.keys(), ...right.keys()]);
    for (const relativePath of [...paths].sort()) {
      const beforeEntry = left.get(relativePath) ?? null;
      const afterEntry = right.get(relativePath) ?? null;
      if (!beforeEntry && afterEntry) {
        changes.push({
          root: afterSnapshot.root,
          relativePath,
          kind: "created",
          before: null,
          after: afterEntry,
        });
      } else if (beforeEntry && !afterEntry) {
        changes.push({
          root: afterSnapshot.root,
          relativePath,
          kind: "deleted",
          before: beforeEntry,
          after: null,
        });
      } else if (
        beforeEntry &&
        afterEntry &&
        (beforeEntry.kind !== afterEntry.kind ||
          beforeEntry.bytes !== afterEntry.bytes ||
          beforeEntry.modifiedAtMs !== afterEntry.modifiedAtMs ||
          beforeEntry.sha256 !== afterEntry.sha256)
      ) {
        changes.push({
          root: afterSnapshot.root,
          relativePath,
          kind: "modified",
          before: beforeEntry,
          after: afterEntry,
        });
      }
    }
  }
  return changes;
}
