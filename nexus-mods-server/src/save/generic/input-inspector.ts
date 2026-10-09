import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { NexusError } from "../../errors.js";
import { inspectZipArchive } from "../../install/archive-inspector.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import { inspectDirectoryTree } from "../../install/core/tree-state.js";
import { sha256File } from "../../install/file-hash.js";
import type { ArchiveIdentity } from "../../install/contracts.js";
import type { SaveInputInspection } from "./input-contracts.js";
import { saveInputInspectionSchema } from "./input-contracts.js";
import { normalizeSaveRelativePath } from "../path-policy.js";

const execFile = promisify(execFileCallback);

const EXECUTABLE_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".com",
  ".bat",
  ".cmd",
  ".ps1",
  ".vbs",
  ".js",
  ".msi",
  ".scr",
]);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".rar", ".7z"]);

export interface SaveInputLimits {
  maxEntries: number;
  maxSingleEntryBytes: number;
  maxTotalUncompressedBytes: number;
  maxCompressionRatio: number;
}

export const DEFAULT_SAVE_INPUT_LIMITS: Readonly<SaveInputLimits> = Object.freeze({
  maxEntries: 10_000,
  maxSingleEntryBytes: 4 * 1024 ** 3,
  maxTotalUncompressedBytes: 20 * 1024 ** 3,
  maxCompressionRatio: 1_000,
});

export interface RarCommandResult {
  stdout: string;
  stderr: string;
}

export interface RarCommandRunner {
  run(executablePath: string, args: ReadonlyArray<string>): Promise<RarCommandResult>;
}

const defaultRarRunner: RarCommandRunner = {
  async run(executablePath, args) {
    try {
      const result = await execFile(executablePath, [...args], {
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 32 * 1024 * 1024,
        encoding: "utf8",
      });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      throw new NexusError(
        "SAVE_ARCHIVE_UNSAFE",
        "The RAR command failed or requested unsupported interaction.",
        {
          cause: error,
          details: {
            executablePath,
            exitCode:
              error instanceof Error && "code" in error ? error.code : null,
          },
        },
      );
    }
  },
};

export interface RarCapability {
  executablePath: string;
  version: string;
  runner: RarCommandRunner;
}

export interface SevenZipArchiveCapability {
  kind: "seven-zip" | "bsdtar";
  executablePath: string;
  version: string;
  runner: RarCommandRunner;
}

export interface SaveInputInspectorOptions {
  managerRoot: string;
  rarCapability?: RarCapability | null;
  sevenZipCapability?: SevenZipArchiveCapability | null;
  limits?: Partial<SaveInputLimits>;
}

export function parseBsdtarList(input: {
  names: string;
  verbose: string;
}, limits: SaveInputLimits = DEFAULT_SAVE_INPUT_LIMITS): SaveInputInspection["entries"] {
  const names = input.names.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const verbose = input.verbose.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (names.length !== verbose.length) {
    throw new NexusError("SAVE_ARCHIVE_UNSAFE", "7z list output was inconsistent.");
  }
  const entries = names.map((originalPath, index) => {
    const detail = verbose[index] ?? "";
    const type = detail[0];
    if (type !== "-" && type !== "d") {
      throw new NexusError(
        "SAVE_ARCHIVE_UNSAFE",
        "7z archive contains a link or unsupported entry type.",
        { details: { originalPath, type } },
      );
    }
    const sizeMatch = detail.match(/^\S+\s+\d+\s+\d+\s+\d+\s+(\d+)\s+/);
    if (!sizeMatch) {
      throw new NexusError("SAVE_ARCHIVE_UNSAFE", "7z verbose list output could not be parsed.");
    }
    const directory = type === "d" || originalPath.endsWith("/") || originalPath.endsWith("\\");
    const normalized = normalizeSaveRelativePath(originalPath.replace(/[\\/]+$/, ""), "win32");
    return {
      originalPath: originalPath.replaceAll("\\", "/").replace(/\/$/, ""),
      normalizedPath: normalized,
      kind: directory ? "directory" as const : "file" as const,
      bytes: directory ? 0 : Number(sizeMatch[1]),
      packedBytes: null,
      crc32: null,
    };
  });
  validateEntries(entries, limits);
  return entries;
}

function commonTopLevelDirectory(
  entries: ReadonlyArray<SaveInputInspection["entries"][number]>,
): string | null {
  const files = entries.filter((entry) => entry.kind === "file");
  if (files.length === 0 || files.some((entry) => !entry.normalizedPath.includes("/"))) {
    return null;
  }
  const roots = new Set(files.map((entry) => entry.normalizedPath.split("/")[0]));
  return roots.size === 1 ? ([...roots][0] ?? null) : null;
}

function validateEntries(
  entries: ReadonlyArray<SaveInputInspection["entries"][number]>,
  limits: SaveInputLimits,
): void {
  if (entries.length === 0) {
    throw new NexusError("SAVE_INPUT_INVALID", "The save input contains no entries.");
  }
  if (entries.length > limits.maxEntries) {
    throw new NexusError("SAVE_ARCHIVE_UNSAFE", "The save input contains too many entries.");
  }
  const seen = new Map<string, string>();
  let total = 0;
  for (const entry of entries) {
    const folded = entry.normalizedPath.toLowerCase();
    const existing = seen.get(folded);
    if (existing !== undefined) {
      throw new NexusError(
        "SAVE_ARCHIVE_UNSAFE",
        "The save input contains duplicate or case-colliding paths.",
        { details: { firstPath: existing, secondPath: entry.originalPath } },
      );
    }
    seen.set(folded, entry.originalPath);
    if (entry.bytes > limits.maxSingleEntryBytes) {
      throw new NexusError("SAVE_ARCHIVE_UNSAFE", "A save input entry is too large.", {
        details: { entryPath: entry.originalPath, bytes: entry.bytes },
      });
    }
    total += entry.bytes;
    if (total > limits.maxTotalUncompressedBytes) {
      throw new NexusError("SAVE_ARCHIVE_UNSAFE", "The expanded save input is too large.");
    }
    if (
      entry.kind === "file" &&
      entry.bytes > 0 &&
      entry.packedBytes !== null &&
      (entry.packedBytes === 0 || entry.bytes / entry.packedBytes > limits.maxCompressionRatio)
    ) {
      throw new NexusError(
        "SAVE_ARCHIVE_UNSAFE",
        "A save input entry exceeds the compression-ratio limit.",
        { details: { entryPath: entry.originalPath } },
      );
    }
  }
}

export function parseUnrarTechnicalList(
  output: string,
  limits: SaveInputLimits = DEFAULT_SAVE_INPUT_LIMITS,
): SaveInputInspection["entries"] {
  const blocks = output.split(/\r?\n(?=\s*Name:\s)/);
  const entries: SaveInputInspection["entries"] = [];
  for (const block of blocks) {
    const name = /^\s*Name:\s*(.+?)\s*$/m.exec(block)?.[1];
    if (!name) continue;
    const type = /^\s*Type:\s*(.+?)\s*$/m.exec(block)?.[1]?.toLowerCase();
    if (type !== "file" && type !== "directory") {
      throw new NexusError(
        "SAVE_ARCHIVE_UNSAFE",
        "RAR links and special entry types are not allowed.",
        { details: { entryPath: name, entryType: type ?? null } },
      );
    }
    let normalizedPath: string;
    try {
      normalizedPath = normalizeSaveRelativePath(name.replaceAll("\\", "/"), "win32");
    } catch (error) {
      throw new NexusError(
        "SAVE_ARCHIVE_UNSAFE",
        "The RAR contains an unsafe or non-portable entry path.",
        { cause: error, details: { entryPath: name } },
      );
    }
    const size = Number(/^\s*Size:\s*(\d+)\s*$/m.exec(block)?.[1] ?? "0");
    const packedMatch = /^\s*Packed size:\s*(\d+)\s*$/m.exec(block)?.[1];
    const crc = /^\s*CRC32:\s*([A-Fa-f0-9]{8})\s*$/m.exec(block)?.[1] ?? null;
    entries.push({
      originalPath: name.replaceAll("\\", "/"),
      normalizedPath,
      kind: type,
      bytes: size,
      packedBytes: packedMatch === undefined ? null : Number(packedMatch),
      crc32: crc,
    });
  }
  validateEntries(entries, limits);
  return entries;
}

async function discoverRarCapability(): Promise<RarCapability | null> {
  const candidates = [
    process.env.UNRAR_PATH?.trim(),
    "C:\\Program Files\\WinRAR\\UnRAR.exe",
    "C:\\Program Files (x86)\\WinRAR\\UnRAR.exe",
  ].filter((value): value is string => Boolean(value));
  for (const executablePath of candidates) {
    const info = await stat(executablePath).catch(() => null);
    if (!info?.isFile()) continue;
    try {
      const result = await defaultRarRunner.run(executablePath, []);
      const version = /UNRAR\s+([0-9.]+)/i.exec(`${result.stdout}\n${result.stderr}`)?.[1];
      if (version) return { executablePath, version, runner: defaultRarRunner };
    } catch {
      // Try the next conventional path.
    }
  }
  return null;
}

async function discoverSevenZipCapability(): Promise<SevenZipArchiveCapability | null> {
  const candidates: Array<{ kind: SevenZipArchiveCapability["kind"]; executablePath: string | undefined }> = [
    { kind: "seven-zip", executablePath: process.env.SEVEN_ZIP_PATH?.trim() },
    { kind: "seven-zip", executablePath: "C:\\Program Files\\7-Zip\\7z.exe" },
    { kind: "seven-zip", executablePath: "C:\\Program Files (x86)\\7-Zip\\7z.exe" },
    { kind: "bsdtar", executablePath: process.env.BSDTAR_PATH?.trim() },
    { kind: "bsdtar", executablePath: "C:\\Windows\\System32\\tar.exe" },
  ];
  for (const candidate of candidates) {
    if (!candidate.executablePath) continue;
    const info = await stat(candidate.executablePath).catch(() => null);
    if (!info?.isFile()) continue;
    try {
      const result = await defaultRarRunner.run(candidate.executablePath, ["--version"]);
      const text = `${result.stdout}\n${result.stderr}`;
      const version = candidate.kind === "bsdtar"
        ? /bsdtar\s+([0-9.]+)/i.exec(text)?.[1]
        : /7-Zip[^0-9]*([0-9.]+)/i.exec(text)?.[1];
      if (version) {
        return { kind: candidate.kind, executablePath: candidate.executablePath, version, runner: defaultRarRunner };
      }
    } catch {
      // Try the next conventional extractor path.
    }
  }
  return null;
}

export class SaveInputInspector {
  readonly #rarCapability: RarCapability | null;
  readonly #sevenZipCapability: SevenZipArchiveCapability | null;
  readonly #limits: SaveInputLimits;

  private constructor(input: {
    rarCapability: RarCapability | null;
    sevenZipCapability: SevenZipArchiveCapability | null;
    limits: SaveInputLimits;
  }) {
    this.#rarCapability = input.rarCapability;
    this.#sevenZipCapability = input.sevenZipCapability;
    this.#limits = input.limits;
  }

  static async create(options: SaveInputInspectorOptions): Promise<SaveInputInspector> {
    return new SaveInputInspector({
      rarCapability:
        options.rarCapability === undefined
          ? await discoverRarCapability()
          : options.rarCapability,
      sevenZipCapability:
        options.sevenZipCapability === undefined
          ? await discoverSevenZipCapability()
          : options.sevenZipCapability,
      limits: { ...DEFAULT_SAVE_INPUT_LIMITS, ...options.limits },
    });
  }

  async inspect(
    inputPath: string,
  ): Promise<Readonly<SaveInputInspection>> {
    if (!path.isAbsolute(inputPath)) {
      throw new NexusError("SAVE_INPUT_UNSUPPORTED", "Save inputPath must be absolute.");
    }
    const absolutePath = path.resolve(inputPath);
    const info = await lstat(absolutePath).catch((error: unknown) => {
      throw new NexusError("SAVE_INPUT_UNSUPPORTED", "Save input does not exist.", {
        cause: error,
        details: { inputPath: absolutePath },
      });
    });
    if (info.isSymbolicLink()) {
      throw new NexusError("SAVE_ARCHIVE_UNSAFE", "Save input must not be a symbolic link or junction.");
    }

    let kind: SaveInputInspection["input"]["kind"];
    let inputSha256: string;
    let inputBytes: number;
    let entries: SaveInputInspection["entries"];
    let archive: SaveInputInspection["archive"] = null;
    if (info.isDirectory()) {
      kind = "directory";
      const tree = await inspectDirectoryTree(absolutePath, this.#limits);
      inputSha256 = tree.treeHash;
      inputBytes = tree.totalBytes;
      entries = [
        ...tree.directories.map((entry) => ({
          originalPath: entry.relativePath,
          normalizedPath: normalizeSaveRelativePath(entry.relativePath, "win32"),
          kind: "directory" as const,
          bytes: 0,
          packedBytes: null,
          crc32: null,
        })),
        ...tree.files.map((entry) => ({
          originalPath: entry.relativePath,
          normalizedPath: normalizeSaveRelativePath(entry.relativePath, "win32"),
          kind: "file" as const,
          bytes: entry.bytes,
          packedBytes: null,
          crc32: null,
        })),
      ];
      validateEntries(entries, this.#limits);
    } else if (info.isFile()) {
      inputSha256 = await sha256File(absolutePath);
      inputBytes = info.size;
      const extension = path.extname(absolutePath).toLowerCase();
      if (extension === ".rar") {
        kind = "rar";
        if (!this.#rarCapability) {
          throw new NexusError(
            "SAVE_INPUT_UNSUPPORTED",
            "RAR input requires a discovered UnRAR capability.",
          );
        }
        await this.#rarCapability.runner.run(this.#rarCapability.executablePath, [
          "t", "-p-", "-cfg-", "-c-", "-@-", "-inul", absolutePath,
        ]);
        const listed = await this.#rarCapability.runner.run(
          this.#rarCapability.executablePath,
          ["lt", "-p-", "-cfg-", "-c-", "-@-", absolutePath],
        );
        entries = parseUnrarTechnicalList(`${listed.stdout}\n${listed.stderr}`, this.#limits);
        archive = {
          format: "rar",
          extractor: {
            kind: "unrar",
            executablePath: this.#rarCapability.executablePath,
            version: this.#rarCapability.version,
          },
          entries,
          totalUncompressedBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
          totalPackedBytes: entries.reduce((sum, entry) => sum + (entry.packedBytes ?? 0), 0),
          commonTopLevelDirectory: commonTopLevelDirectory(entries),
        };
      } else if (extension === ".zip") {
        kind = "zip";
        const identity: ArchiveIdentity = {
          absolutePath,
          fileName: path.basename(absolutePath),
          bytes: info.size,
          sha256: inputSha256,
        };
        const inventory = await inspectZipArchive({
          archive: identity,
          limits: this.#limits,
        }).catch((error: unknown) => {
          throw new NexusError("SAVE_ARCHIVE_UNSAFE", "ZIP inspection failed.", { cause: error });
        });
        entries = inventory.entries.map((entry) => ({
          originalPath: entry.originalPath.replaceAll("\\", "/"),
          normalizedPath: entry.normalizedPath,
          kind: entry.kind,
          bytes: entry.uncompressedBytes,
          packedBytes: entry.compressedBytes,
          crc32: entry.crc32,
        }));
        validateEntries(entries, this.#limits);
        archive = {
          format: "zip",
          extractor: {
            kind: "builtin-zip",
            executablePath: null,
            version: "yauzl-3",
          },
          entries,
          totalUncompressedBytes: inventory.totalUncompressedBytes,
          totalPackedBytes: inventory.totalCompressedBytes,
          commonTopLevelDirectory: inventory.commonTopLevelDirectory,
        };
      } else if (extension === ".7z") {
        kind = "7z";
        if (!this.#sevenZipCapability) {
          throw new NexusError(
            "SAVE_INPUT_UNSUPPORTED",
            "7z input requires a discovered 7-Zip or bsdtar capability.",
          );
        }
        let listedNames: RarCommandResult;
        let listedVerbose: RarCommandResult;
        if (this.#sevenZipCapability.kind === "bsdtar") {
          [listedNames, listedVerbose] = await Promise.all([
            this.#sevenZipCapability.runner.run(this.#sevenZipCapability.executablePath, ["-tf", absolutePath]),
            this.#sevenZipCapability.runner.run(this.#sevenZipCapability.executablePath, ["-tvf", absolutePath]),
          ]);
          entries = parseBsdtarList({ names: listedNames.stdout, verbose: listedVerbose.stdout }, this.#limits);
        } else {
          throw new NexusError(
            "SAVE_INPUT_UNSUPPORTED",
            "Native 7-Zip listing is not enabled; use the discovered bsdtar capability.",
          );
        }
        archive = {
          format: "7z",
          extractor: {
            kind: this.#sevenZipCapability.kind,
            executablePath: this.#sevenZipCapability.executablePath,
            version: this.#sevenZipCapability.version,
          },
          entries,
          totalUncompressedBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
          totalPackedBytes: null,
          commonTopLevelDirectory: commonTopLevelDirectory(entries),
        };
      } else {
        kind = "file";
        const fileName = normalizeSaveRelativePath(path.basename(absolutePath), "win32");
        entries = [{
          originalPath: fileName,
          normalizedPath: fileName,
          kind: "file",
          bytes: info.size,
          packedBytes: null,
          crc32: null,
        }];
      }
    } else {
      throw new NexusError("SAVE_INPUT_UNSUPPORTED", "Save input must be a regular file or directory.");
    }
    validateEntries(entries, this.#limits);
    const containsExecutable = entries.some(
      (entry) => entry.kind === "file" && EXECUTABLE_EXTENSIONS.has(path.extname(entry.normalizedPath).toLowerCase()),
    );
    const nestedArchives = entries.filter(
      (entry) => entry.kind === "file" && ARCHIVE_EXTENSIONS.has(path.extname(entry.normalizedPath).toLowerCase()),
    );
    const warnings = [
      ...(containsExecutable ? ["The input contains executable or script files outside the selected save payload."] : []),
      ...(nestedArchives.length > 0 ? [`The input contains ${nestedArchives.length} nested archive(s); they are not expanded.`] : []),
    ];
    const withoutHash = {
      schemaVersion: 1 as const,
      inspectionId: randomUUID(),
      input: {
        kind,
        absolutePath,
        bytes: inputBytes,
        sha256: inputSha256,
        modifiedAt: info.mtime.toISOString(),
      },
      archive,
      entries: [...entries].sort((left, right) => left.normalizedPath.localeCompare(right.normalizedPath)),
      containsExecutable,
      warnings,
      createdAt: new Date().toISOString(),
    };
    return Object.freeze(
      saveInputInspectionSchema.parse({
        ...withoutHash,
        inspectionHash: sha256CanonicalJson(withoutHash),
      }),
    );
  }

  get rarCapability(): RarCapability | null {
    return this.#rarCapability;
  }

  get sevenZipCapability(): SevenZipArchiveCapability | null {
    return this.#sevenZipCapability;
  }
}
