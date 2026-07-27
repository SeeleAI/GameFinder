import { createHash } from "node:crypto";
import type { Entry, ZipFile } from "yauzl";
import yauzl from "yauzl";

import { NexusError } from "../errors.js";
import type { ArchiveIdentity } from "./contracts.js";
import { normalizeManagedRelativePath } from "./path-policy.js";

export interface ArchiveInspectionLimits {
  maxEntries: number;
  maxSingleEntryBytes: number;
  maxTotalUncompressedBytes: number;
  maxCompressionRatio: number;
}

export const DEFAULT_ARCHIVE_INSPECTION_LIMITS: Readonly<ArchiveInspectionLimits> =
  Object.freeze({
    maxEntries: 100_000,
    maxSingleEntryBytes: 4 * 1024 ** 3,
    maxTotalUncompressedBytes: 20 * 1024 ** 3,
    maxCompressionRatio: 1_000,
  });

export interface ArchiveInventoryEntry {
  originalPath: string;
  normalizedPath: string;
  kind: "file" | "directory";
  uncompressedBytes: number;
  compressedBytes: number;
  compressionMethod: number;
  crc32: string;
  compressionRatio: number;
}

export interface ArchiveInventory {
  schemaVersion: 1;
  format: "zip";
  archive: ArchiveIdentity;
  entries: ReadonlyArray<ArchiveInventoryEntry>;
  totalUncompressedBytes: number;
  totalCompressedBytes: number;
  commonTopLevelDirectory: string | null;
  warnings: ReadonlyArray<string>;
}

function unsafeArchive(
  message: string,
  details: Record<string, unknown>,
): never {
  throw new NexusError("ARCHIVE_UNSAFE", message, { details });
}

function archiveLimit(
  message: string,
  details: Record<string, unknown>,
): never {
  throw new NexusError("ARCHIVE_LIMIT_EXCEEDED", message, { details });
}

function isUnixSymlink(entry: Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

function normalizeArchiveEntryPath(
  originalPath: string,
  isDirectory: boolean,
): string {
  const withoutDirectorySlash = isDirectory
    ? originalPath.replace(/[\\/]+$/, "")
    : originalPath;
  if (!withoutDirectorySlash) {
    unsafeArchive("The ZIP contains an empty entry path.", { originalPath });
  }
  try {
    return normalizeManagedRelativePath(
      withoutDirectorySlash.replaceAll("\\", "/"),
      "win32",
    );
  } catch (error) {
    throw new NexusError(
      "ARCHIVE_UNSAFE",
      "The ZIP contains an unsafe or non-portable entry path.",
      { cause: error, details: { originalPath } },
    );
  }
}

function commonTopLevelDirectory(
  entries: ReadonlyArray<ArchiveInventoryEntry>,
): string | null {
  const fileEntries = entries.filter((entry) => entry.kind === "file");
  if (fileEntries.length === 0) return null;
  const firstSegments = new Set(
    fileEntries.map((entry) => entry.normalizedPath.split("/")[0]),
  );
  if (firstSegments.size !== 1) return null;
  if (fileEntries.some((entry) => !entry.normalizedPath.includes("/"))) {
    return null;
  }
  return firstSegments.values().next().value ?? null;
}

function closeQuietly(zipFile: ZipFile): void {
  if (zipFile.isOpen) zipFile.close();
}

export async function inspectZipArchive(input: {
  archive: ArchiveIdentity;
  limits?: Partial<ArchiveInspectionLimits>;
}): Promise<ArchiveInventory> {
  const limits: ArchiveInspectionLimits = {
    ...DEFAULT_ARCHIVE_INSPECTION_LIMITS,
    ...input.limits,
  };
  if (!input.archive.fileName.toLowerCase().endsWith(".zip")) {
    throw new NexusError(
      "ARCHIVE_UNSUPPORTED",
      "Phase 6B currently supports ZIP archives only.",
      { details: { fileName: input.archive.fileName } },
    );
  }

  let zipFile: ZipFile;
  try {
    zipFile = await yauzl.openPromise(input.archive.absolutePath, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: false,
    });
  } catch (error) {
    throw new NexusError("ARCHIVE_UNSUPPORTED", "The ZIP central directory could not be read.", {
      cause: error,
      details: { archivePath: input.archive.absolutePath },
    });
  }

  return await new Promise<ArchiveInventory>((resolve, reject) => {
    const entries: ArchiveInventoryEntry[] = [];
    const seenCaseFoldedPaths = new Map<string, string>();
    const warnings: string[] = [];
    let totalUncompressedBytes = 0;
    let totalCompressedBytes = 0;
    let settled = false;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      closeQuietly(zipFile);
      reject(
        error instanceof NexusError
          ? error
          : new NexusError(
              "ARCHIVE_UNSUPPORTED",
              "The ZIP inventory could not be enumerated.",
              { cause: error },
            ),
      );
    };

    zipFile.on("error", fail);
    zipFile.on("entry", (entry: Entry) => {
      try {
        if (entries.length >= limits.maxEntries) {
          archiveLimit("The ZIP contains too many entries.", {
            maxEntries: limits.maxEntries,
          });
        }
        if (entry.isEncrypted()) {
          unsafeArchive("Encrypted ZIP entries are not supported.", {
            entryPath: entry.fileName,
          });
        }
        if (!entry.canDecodeFileData()) {
          throw new NexusError(
            "ARCHIVE_UNSUPPORTED",
            "The ZIP uses an unsupported compression or encryption method.",
            {
              details: {
                entryPath: entry.fileName,
                compressionMethod: entry.compressionMethod,
              },
            },
          );
        }
        if (isUnixSymlink(entry)) {
          unsafeArchive("ZIP symbolic-link entries are not allowed.", {
            entryPath: entry.fileName,
          });
        }

        const isDirectory = /[\\/]$/.test(entry.fileName);
        const normalizedPath = normalizeArchiveEntryPath(
          entry.fileName,
          isDirectory,
        );
        const foldedPath = normalizedPath.toLowerCase();
        const existingPath = seenCaseFoldedPaths.get(foldedPath);
        if (existingPath !== undefined) {
          unsafeArchive(
            "The ZIP contains duplicate or case-colliding entry paths.",
            {
              firstPath: existingPath,
              secondPath: entry.fileName,
            },
          );
        }
        seenCaseFoldedPaths.set(foldedPath, entry.fileName);

        if (entry.uncompressedSize > limits.maxSingleEntryBytes) {
          archiveLimit("A ZIP entry exceeds the single-entry size limit.", {
            entryPath: entry.fileName,
            uncompressedBytes: entry.uncompressedSize,
            maxSingleEntryBytes: limits.maxSingleEntryBytes,
          });
        }
        const ratio =
          entry.uncompressedSize === 0
            ? 0
            : entry.compressedSize === 0
              ? Number.POSITIVE_INFINITY
              : entry.uncompressedSize / entry.compressedSize;
        if (ratio > limits.maxCompressionRatio) {
          archiveLimit("A ZIP entry exceeds the compression-ratio limit.", {
            entryPath: entry.fileName,
            compressionRatio: ratio,
            maxCompressionRatio: limits.maxCompressionRatio,
          });
        }

        totalUncompressedBytes += entry.uncompressedSize;
        totalCompressedBytes += entry.compressedSize;
        if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
          archiveLimit(
            "The ZIP exceeds the total uncompressed-size limit.",
            {
              totalUncompressedBytes,
              maxTotalUncompressedBytes: limits.maxTotalUncompressedBytes,
            },
          );
        }

        entries.push({
          originalPath: entry.fileName,
          normalizedPath,
          kind: isDirectory ? "directory" : "file",
          uncompressedBytes: entry.uncompressedSize,
          compressedBytes: entry.compressedSize,
          compressionMethod: entry.compressionMethod,
          crc32: entry.crc32.toString(16).padStart(8, "0"),
          compressionRatio: Number.isFinite(ratio) ? ratio : limits.maxCompressionRatio,
        });
        zipFile.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zipFile.on("end", () => {
      if (settled) return;
      settled = true;
      closeQuietly(zipFile);
      if (entries.length === 0) {
        warnings.push("The ZIP contains no entries.");
      }
      resolve({
        schemaVersion: 1,
        format: "zip",
        archive: input.archive,
        entries,
        totalUncompressedBytes,
        totalCompressedBytes,
        commonTopLevelDirectory: commonTopLevelDirectory(entries),
        warnings,
      });
    });

    zipFile.readEntry();
  });
}

export async function readZipTextEntry(input: {
  archive: ArchiveIdentity;
  entry: ArchiveInventoryEntry;
  maxBytes?: number;
}): Promise<string> {
  const maxBytes = input.maxBytes ?? 1024 * 1024;
  if (input.entry.kind !== "file") {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      "Only file entries can be read as text.",
      { details: { entryPath: input.entry.normalizedPath } },
    );
  }
  if (input.entry.uncompressedBytes > maxBytes) {
    archiveLimit("The requested ZIP text entry exceeds its read limit.", {
      entryPath: input.entry.normalizedPath,
      uncompressedBytes: input.entry.uncompressedBytes,
      maxBytes,
    });
  }

  const zipFile = await yauzl.openPromise(input.archive.absolutePath, {
    autoClose: false,
    lazyEntries: true,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: false,
  });

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      closeQuietly(zipFile);
      reject(
        error instanceof NexusError
          ? error
          : new NexusError(
              "ARCHIVE_UNSUPPORTED",
              "The ZIP entry could not be read.",
              { cause: error, details: { entryPath: input.entry.normalizedPath } },
            ),
      );
    };

    zipFile.on("error", fail);
    zipFile.on("entry", (entry: Entry) => {
      try {
        const isDirectory = /[\\/]$/.test(entry.fileName);
        const normalizedPath = normalizeArchiveEntryPath(
          entry.fileName,
          isDirectory,
        );
        if (normalizedPath !== input.entry.normalizedPath) {
          zipFile.readEntry();
          return;
        }
        if (isDirectory || entry.isEncrypted() || isUnixSymlink(entry)) {
          unsafeArchive("The selected ZIP text entry is not a safe regular file.", {
            entryPath: entry.fileName,
          });
        }
        void zipFile
          .openReadStreamPromise(entry)
          .then(async (stream) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            for await (const chunk of stream) {
              const buffer = Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk as Uint8Array);
              bytes += buffer.length;
              if (bytes > maxBytes) {
                archiveLimit(
                  "The ZIP text entry exceeded its read limit while streaming.",
                  {
                    entryPath: entry.fileName,
                    bytes,
                    maxBytes,
                  },
                );
              }
              chunks.push(buffer);
            }
            if (settled) return;
            settled = true;
            closeQuietly(zipFile);
            resolve(Buffer.concat(chunks).toString("utf8"));
          })
          .catch(fail);
      } catch (error) {
        fail(error);
      }
    });
    zipFile.on("end", () => {
      fail(
        new NexusError(
          "ARCHIVE_UNSUPPORTED",
          "The selected ZIP inventory entry no longer exists.",
          { details: { entryPath: input.entry.normalizedPath } },
        ),
      );
    });
    zipFile.readEntry();
  });
}

export async function hashZipFileEntry(input: {
  archive: ArchiveIdentity;
  entry: ArchiveInventoryEntry;
  maxBytes?: number;
}): Promise<string> {
  const maxBytes = input.maxBytes ?? DEFAULT_ARCHIVE_INSPECTION_LIMITS.maxSingleEntryBytes;
  if (input.entry.kind !== "file") {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      "Only file entries can be hashed.",
      { details: { entryPath: input.entry.normalizedPath } },
    );
  }
  if (input.entry.uncompressedBytes > maxBytes) {
    archiveLimit("The requested ZIP entry exceeds its hash limit.", {
      entryPath: input.entry.normalizedPath,
      uncompressedBytes: input.entry.uncompressedBytes,
      maxBytes,
    });
  }

  const zipFile = await yauzl.openPromise(input.archive.absolutePath, {
    autoClose: false,
    lazyEntries: true,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: false,
  });
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      closeQuietly(zipFile);
      reject(
        error instanceof NexusError
          ? error
          : new NexusError(
              "ARCHIVE_UNSUPPORTED",
              "The ZIP entry could not be hashed.",
              { cause: error, details: { entryPath: input.entry.normalizedPath } },
            ),
      );
    };
    zipFile.on("error", fail);
    zipFile.on("entry", (entry: Entry) => {
      try {
        const isDirectory = /[\\/]$/.test(entry.fileName);
        const normalizedPath = normalizeArchiveEntryPath(entry.fileName, isDirectory);
        if (normalizedPath !== input.entry.normalizedPath) {
          zipFile.readEntry();
          return;
        }
        if (isDirectory || entry.isEncrypted() || isUnixSymlink(entry)) {
          unsafeArchive("The selected ZIP hash entry is not a safe regular file.", {
            entryPath: entry.fileName,
          });
        }
        void zipFile.openReadStreamPromise(entry).then(async (stream) => {
          const hash = createHash("sha256");
          let bytes = 0;
          for await (const chunk of stream) {
            const buffer = Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk as Uint8Array);
            bytes += buffer.length;
            if (bytes > maxBytes) {
              archiveLimit("The ZIP entry exceeded its hash limit while streaming.", {
                entryPath: entry.fileName,
                bytes,
                maxBytes,
              });
            }
            hash.update(buffer);
          }
          if (bytes !== input.entry.uncompressedBytes) {
            unsafeArchive("The ZIP entry size changed while hashing.", {
              entryPath: entry.fileName,
              expectedBytes: input.entry.uncompressedBytes,
              actualBytes: bytes,
            });
          }
          if (settled) return;
          settled = true;
          closeQuietly(zipFile);
          resolve(hash.digest("hex"));
        }).catch(fail);
      } catch (error) {
        fail(error);
      }
    });
    zipFile.on("end", () => {
      fail(
        new NexusError(
          "ARCHIVE_UNSUPPORTED",
          "The selected ZIP inventory entry no longer exists.",
          { details: { entryPath: input.entry.normalizedPath } },
        ),
      );
    });
    zipFile.readEntry();
  });
}
