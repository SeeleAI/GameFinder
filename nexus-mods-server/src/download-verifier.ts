import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, link, mkdir, open, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { NexusError } from "./errors.js";

export type DownloadBackend = "native" | "persistent_chromium";

export interface ArchiveCheck {
  format: string;
  valid: boolean | null;
  detail: string;
}

export interface DownloadReceipt {
  schemaVersion: 1;
  backend: DownloadBackend;
  canonicalModUrl: string;
  domainName: string;
  modId: number;
  fileId: number;
  fileName: string;
  bytes: number;
  sha256: string;
  completedAt: string;
  absolutePath: string;
  targetPath: string;
  receiptPath: string;
  archiveValid: boolean | null;
  archiveCheck: ArchiveCheck;
  browser?: {
    engine: "chromium";
    backend: "playwright";
  };
}

export interface FinalizeDownloadInput {
  backend: DownloadBackend;
  canonicalModUrl: string;
  domainName: string;
  modId: number;
  fileId: number;
  expectedSizeInBytes: number | null;
  outputDirectory: string;
  stagingPath: string;
  suggestedFileName?: string;
  apiFileName: string;
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function sanitizeDownloadFileName(value: string, fallback = "nexus-mod-file"): string {
  const cleaned = value
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  let safe = !cleaned || cleaned === "." || cleaned === ".." ? fallback : cleaned;
  if (WINDOWS_RESERVED_NAME.test(safe)) safe = `_${safe}`;
  safe = safe.slice(0, 180).replace(/[. ]+$/g, "");
  return safe || fallback;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveOutputDirectory(outputDirectory: string): Promise<string> {
  if (!path.isAbsolute(outputDirectory)) {
    throw new NexusError("OUTPUT_PATH_INVALID", "outputDirectory must be an absolute path.");
  }
  const resolved = path.resolve(outputDirectory);
  if (path.parse(resolved).root === resolved) {
    throw new NexusError("OUTPUT_PATH_INVALID", "Refusing to use a filesystem root as outputDirectory.");
  }
  await mkdir(resolved, { recursive: true });
  return resolved;
}

export async function createStagingPath(input: {
  outputDirectory: string;
  sessionId: string;
  preferredFileName: string;
}): Promise<{ outputDirectory: string; stagingDirectory: string; stagingPath: string }> {
  const outputDirectory = await resolveOutputDirectory(input.outputDirectory);
  const stagingDirectory = path.join(outputDirectory, ".nexus-download-staging");
  await mkdir(stagingDirectory, { recursive: true });
  const safeName = sanitizeDownloadFileName(input.preferredFileName);
  const stagingPath = path.join(stagingDirectory, `${input.sessionId}-${safeName}-${randomUUID()}.part`);
  if (await fileExists(stagingPath)) {
    throw new NexusError("OUTPUT_FILE_EXISTS", "The generated browser staging path already exists.");
  }
  return { outputDirectory, stagingDirectory, stagingPath };
}

export async function inspectArchive(
  filePath: string,
  fileName: string,
  bytes: number
): Promise<ArchiveCheck> {
  const extension = path.extname(fileName).toLowerCase();
  const handle = await open(filePath, "r");
  try {
    const magic = Buffer.alloc(Math.min(8, bytes));
    await handle.read(magic, 0, magic.length, 0);
    if (extension === ".zip" || magic.subarray(0, 2).equals(Buffer.from([0x50, 0x4b]))) {
      const tailLength = Math.min(bytes, 65_557);
      const tail = Buffer.alloc(tailLength);
      await handle.read(tail, 0, tailLength, bytes - tailLength);
      const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
      return tail.lastIndexOf(eocd) >= 0
        ? { format: "zip", valid: true, detail: "ZIP end-of-central-directory record found." }
        : { format: "zip", valid: false, detail: "ZIP end-of-central-directory record was not found." };
    }
    if (extension === ".7z" && magic.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) {
      return { format: "7z", valid: null, detail: "7z magic matched; deep archive validation is not enabled." };
    }
    if (extension === ".rar" && magic.subarray(0, 4).equals(Buffer.from([0x52, 0x61, 0x72, 0x21]))) {
      return { format: "rar", valid: null, detail: "RAR magic matched; deep archive validation is not enabled." };
    }
    return {
      format: extension.replace(/^\./, "") || "unknown",
      valid: null,
      detail: `Archive parser unavailable; leading magic is ${magic.toString("hex")}.`
    };
  } finally {
    await handle.close();
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function finalizeDownloadedFile(input: FinalizeDownloadInput): Promise<DownloadReceipt> {
  const outputDirectory = await resolveOutputDirectory(input.outputDirectory);
  const resolvedStagingPath = path.resolve(input.stagingPath);
  const relativeStagingPath = path.relative(outputDirectory, resolvedStagingPath);
  if (
    relativeStagingPath.startsWith("..") ||
    path.isAbsolute(relativeStagingPath) ||
    path.dirname(resolvedStagingPath) !== path.join(outputDirectory, ".nexus-download-staging")
  ) {
    throw new NexusError("OUTPUT_PATH_INVALID", "The staging file must be inside the output staging directory.");
  }

  const fileInfo = await stat(resolvedStagingPath);
  if (!fileInfo.isFile()) {
    throw new NexusError("DOWNLOAD_FAILED", "The browser staging result is not a regular file.");
  }
  const bytes = fileInfo.size;
  if (
    input.expectedSizeInBytes !== null &&
    input.expectedSizeInBytes > 0 &&
    bytes !== input.expectedSizeInBytes
  ) {
    throw new NexusError(
      "DOWNLOAD_SIZE_MISMATCH",
      `Downloaded ${bytes} bytes but Nexus file metadata declares ${input.expectedSizeInBytes}.`
    );
  }

  const fallback = `${input.domainName}-mod-${input.modId}-file-${input.fileId}.archive`;
  const fileName = sanitizeDownloadFileName(
    input.suggestedFileName?.trim() || input.apiFileName.trim() || fallback,
    fallback
  );
  const finalPath = path.join(outputDirectory, fileName);
  const receiptPath = `${finalPath}.nexus-receipt.json`;
  if ((await fileExists(finalPath)) || (await fileExists(receiptPath))) {
    throw new NexusError("OUTPUT_FILE_EXISTS", `Output file or receipt already exists: ${finalPath}`);
  }

  const [sha256, archiveCheck] = await Promise.all([
    hashFile(resolvedStagingPath),
    inspectArchive(resolvedStagingPath, fileName, bytes)
  ]);
  if (archiveCheck.valid === false) {
    throw new NexusError("ARCHIVE_INVALID", archiveCheck.detail);
  }

  let finalExposed = false;
  try {
    await link(resolvedStagingPath, finalPath);
    finalExposed = true;
    await unlink(resolvedStagingPath);
    const completedAt = new Date().toISOString();
    const receipt: DownloadReceipt = {
      schemaVersion: 1,
      backend: input.backend,
      canonicalModUrl: input.canonicalModUrl,
      domainName: input.domainName,
      modId: input.modId,
      fileId: input.fileId,
      fileName,
      bytes,
      sha256,
      completedAt,
      absolutePath: finalPath,
      targetPath: finalPath,
      receiptPath,
      archiveValid: archiveCheck.valid,
      archiveCheck,
      ...(input.backend === "persistent_chromium"
        ? { browser: { engine: "chromium" as const, backend: "playwright" as const } }
        : {})
    };
    try {
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx"
      });
    } catch (error) {
      await rm(finalPath, { force: true });
      finalExposed = false;
      throw new NexusError("DOWNLOAD_FAILED", "Downloaded archive was removed because its receipt could not be written.", {
        cause: error
      });
    }
    return receipt;
  } catch (error) {
    if (finalExposed) await rm(finalPath, { force: true }).catch(() => undefined);
    if (error instanceof NexusError) throw error;
    throw new NexusError("DOWNLOAD_FAILED", "The verified download could not be exposed atomically.", {
      cause: error
    });
  }
}

export async function removeConfirmedInvalidStaging(stagingPath: string): Promise<void> {
  await rm(stagingPath, { force: true }).catch(() => undefined);
}
