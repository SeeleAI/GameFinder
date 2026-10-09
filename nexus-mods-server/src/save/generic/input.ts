import { randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import { inspectDirectoryTree } from "../../install/core/tree-state.js";
import { sha256File } from "../../install/file-hash.js";
import { normalizeSaveRelativePath } from "../path-policy.js";
import { DEFAULT_SAVE_INPUT_LIMITS, SaveInputInspector } from "../package/input-inspector.js";

// Check ancestors as well as the final node: a real leaf below a junction is
// still an unsafe write boundary. Missing suffixes are allowed for new saves.
export async function assertRealPath(absolutePath: string): Promise<void> {
  if (!path.isAbsolute(absolutePath)) throw new NexusError("SAVE_PATH_INVALID", "An absolute path is required.");
  const resolved = path.resolve(absolutePath);
  const root = path.parse(resolved).root;
  let cursor = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) break;
    if (info.isSymbolicLink()) throw new NexusError("SAVE_PATH_PROTECTED", "Path traverses a link or junction.", { details: { path: cursor } });
    if (cursor !== resolved && !info.isDirectory()) throw new NexusError("SAVE_PATH_INVALID", "Path ancestor is not a directory.");
  }
}

export function relativeFile(value: string): string {
  return normalizeSaveRelativePath(value, "win32");
}

export async function stageSaveInput(inspector: SaveInputInspector, inputPath: string, stagingParent: string) {
  await assertRealPath(inputPath);
  await assertRealPath(stagingParent);
  const inspection = await inspector.inspect(inputPath);
  const root = path.join(stagingParent, randomUUID());
  await mkdir(root, { recursive: true });
  const entries = inspection.entries.filter((entry) => entry.kind === "file");
  if (entries.length === 0) throw new NexusError("SAVE_PACKAGE_INVALID", "No regular save files were found.");
  if (inspection.input.kind === "zip") {
    const zip = await yauzl.openPromise(inputPath, { autoClose: false, lazyEntries: true, validateEntrySizes: true });
    await new Promise<void>((resolve, reject) => {
      let failed = false;
      let total = 0;
      const seen = new Set<string>();
      const fail = (error: unknown) => { failed = true; zip.close(); reject(error); };
      zip.on("error", fail);
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          if (failed) return;
          if (entry.fileName.endsWith("/")) { zip.readEntry(); return; }
          const name = relativeFile(entry.fileName);
          const expected = entries.find((item) => item.normalizedPath === name);
          const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
          if (!expected || seen.has(name.toLowerCase()) || entry.isEncrypted() || (unixMode & 0o170000) === 0o120000) {
            throw new NexusError("SAVE_ARCHIVE_UNSAFE", "ZIP differs from its safe inventory.");
          }
          seen.add(name.toLowerCase());
          const target = path.join(root, ...name.split("/"));
          await mkdir(path.dirname(target), { recursive: true });
          let bytes = 0;
          const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            total += chunk.length;
            callback(bytes > expected.bytes || total > DEFAULT_SAVE_INPUT_LIMITS.maxTotalUncompressedBytes
              ? new NexusError("SAVE_ARCHIVE_UNSAFE", "ZIP stream exceeds its declared size.") : null, chunk);
          } });
          await pipeline(await zip.openReadStreamPromise(entry), limiter, createWriteStream(target, { flags: "wx" }));
          if (bytes !== expected.bytes) throw new NexusError("SAVE_ARCHIVE_UNSAFE", "ZIP stream size is inconsistent.");
          zip.readEntry();
        })().catch(fail);
      });
      zip.on("end", () => { zip.close(); if (!failed) resolve(); });
      zip.readEntry();
    });
  } else if (inspection.input.kind === "rar") {
    const capability = inspector.rarCapability;
    if (!capability) throw new NexusError("SAVE_INPUT_UNSUPPORTED", "RAR requires UnRAR.");
    await capability.runner.run(capability.executablePath, ["x", "-p-", "-o-", "-cfg-", "-c-", "-@-", "-ai", "-inul", inputPath, `${root}${path.sep}`]);
  } else if (inspection.input.kind === "7z") {
    const capability = inspector.sevenZipCapability;
    if (capability?.kind !== "bsdtar") throw new NexusError("SAVE_INPUT_UNSUPPORTED", "7z requires bsdtar.");
    await capability.runner.run(capability.executablePath, ["-xf", inputPath, "-C", root, "--no-same-owner", "--no-same-permissions"]);
  } else {
    for (const entry of entries) {
      const source = inspection.input.kind === "file" ? inputPath : path.join(inputPath, ...entry.normalizedPath.split("/"));
      await assertRealPath(source);
      const target = path.join(root, ...entry.normalizedPath.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target, constants.COPYFILE_EXCL);
    }
  }
  const staged = await inspectDirectoryTree(root, DEFAULT_SAVE_INPUT_LIMITS);
  const inventory = (files: ReadonlyArray<{ relativePath: string; bytes: number }>) => sha256CanonicalJson(
    files.map(({ relativePath, bytes }) => ({ relativePath, bytes })).sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
  );
  if (inventory(staged.files) !== inventory(entries.map((entry) => ({ relativePath: entry.normalizedPath, bytes: entry.bytes })))) {
    throw new NexusError("SAVE_ARCHIVE_UNSAFE", "Staged file set differs from the inspected inventory.");
  }
  await assertRealPath(inputPath);
  const currentHash = inspection.input.kind === "directory"
    ? (await inspectDirectoryTree(inputPath, DEFAULT_SAVE_INPUT_LIMITS)).treeHash
    : await sha256File(inputPath);
  if (currentHash !== inspection.input.sha256) throw new NexusError("SAVE_PACKAGE_INVALID", "Source changed while staging.");
  if (inspection.input.kind === "file" && staged.files[0]?.sha256 !== inspection.input.sha256) throw new NexusError("SAVE_PACKAGE_INVALID", "Staged file bytes differ from source.");
  if (inspection.input.kind === "directory") {
    // Empty wrapper directories are irrelevant to exact file imports.
    const original = await inspectDirectoryTree(inputPath, DEFAULT_SAVE_INPUT_LIMITS);
    if (sha256CanonicalJson(original.files.map(({ relativePath, sha256 }) => ({ relativePath, sha256 }))) !== sha256CanonicalJson(staged.files.map(({ relativePath, sha256 }) => ({ relativePath, sha256 })))) {
      throw new NexusError("SAVE_PACKAGE_INVALID", "Source bytes changed while staging.");
    }
  }
  return { inspection, stagedInput: { root, files: staged.files, treeHash: staged.treeHash } };
}
