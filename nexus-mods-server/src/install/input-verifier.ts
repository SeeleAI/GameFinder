import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";

import type { DownloadReceipt } from "../download-verifier.js";
import { NexusError } from "../errors.js";
import type { ArchiveIdentity } from "./contracts.js";
import { archiveIdentitySchema } from "./contracts.js";
import { sha256File } from "./file-hash.js";

const receiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    backend: z.enum(["native", "persistent_chromium"]),
    canonicalModUrl: z.url(),
    domainName: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
    modId: z.number().int().positive(),
    fileId: z.number().int().positive(),
    fileName: z.string().trim().min(1).max(260),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    completedAt: z.iso.datetime(),
    absolutePath: z.string().trim().min(3),
    targetPath: z.string().trim().min(3),
    receiptPath: z.string().trim().min(3),
    archiveValid: z.boolean().nullable(),
    archiveCheck: z.object({
      format: z.string().trim().min(1),
      valid: z.boolean().nullable(),
      detail: z.string(),
    }),
  })
  .passthrough();

export interface ExpectedNexusSource {
  domainName: string;
  modId: number;
  fileId: number;
}

export interface VerifiedInstallInput {
  archive: ArchiveIdentity;
  receipt: DownloadReceipt;
  source: {
    canonicalModUrl: string;
    domainName: string;
    modId: number;
    fileId: number;
    backend: DownloadReceipt["backend"];
    completedAt: string;
  };
}

function receiptMismatch(
  message: string,
  details: Record<string, unknown>,
): never {
  throw new NexusError("INPUT_RECEIPT_MISMATCH", message, { details });
}

function sameLocalPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function assertExpectedSource(
  receipt: DownloadReceipt,
  expected: ExpectedNexusSource | undefined,
): void {
  if (!expected) return;
  if (
    receipt.domainName !== expected.domainName ||
    receipt.modId !== expected.modId ||
    receipt.fileId !== expected.fileId
  ) {
    receiptMismatch(
      "The download receipt belongs to a different Nexus Mods file.",
      {
        expected,
        actual: {
          domainName: receipt.domainName,
          modId: receipt.modId,
          fileId: receipt.fileId,
        },
      },
    );
  }
}

export async function verifyInstallInput(input: {
  archivePath: string;
  receiptPath: string;
  expectedSource?: ExpectedNexusSource;
}): Promise<VerifiedInstallInput> {
  if (!path.isAbsolute(input.archivePath) || !path.isAbsolute(input.receiptPath)) {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      "archivePath and receiptPath must both be absolute.",
    );
  }

  const archivePath = path.resolve(input.archivePath);
  const receiptPath = path.resolve(input.receiptPath);
  const lowerArchivePath = archivePath.toLowerCase();
  if (
    lowerArchivePath.endsWith(".part") ||
    lowerArchivePath.endsWith(".crdownload")
  ) {
    throw new NexusError(
      "INPUT_RECEIPT_MISMATCH",
      "Incomplete browser download files cannot be installed.",
      { details: { archivePath } },
    );
  }

  let parsedReceipt: DownloadReceipt;
  try {
    const raw = JSON.parse(await readFile(receiptPath, "utf8")) as unknown;
    parsedReceipt = receiptSchema.parse(raw) as DownloadReceipt;
  } catch (error) {
    throw new NexusError(
      "INPUT_RECEIPT_MISMATCH",
      "The Nexus download receipt is missing, unreadable, or invalid.",
      { cause: error, details: { receiptPath } },
    );
  }

  const archiveInfo = await stat(archivePath).catch((error: unknown) => {
    throw new NexusError(
      "INPUT_RECEIPT_MISMATCH",
      "The archive referenced for installation does not exist.",
      { cause: error, details: { archivePath } },
    );
  });
  if (!archiveInfo.isFile()) {
    receiptMismatch("The installation input is not a regular archive file.", {
      archivePath,
    });
  }

  if (
    !sameLocalPath(parsedReceipt.absolutePath, archivePath) ||
    !sameLocalPath(parsedReceipt.targetPath, archivePath)
  ) {
    receiptMismatch(
      "The selected archive path does not match the download receipt.",
      {
        archivePath,
        receiptAbsolutePath: parsedReceipt.absolutePath,
        receiptTargetPath: parsedReceipt.targetPath,
      },
    );
  }
  if (!sameLocalPath(parsedReceipt.receiptPath, receiptPath)) {
    receiptMismatch(
      "The selected receipt path does not match its recorded location.",
      {
        receiptPath,
        recordedReceiptPath: parsedReceipt.receiptPath,
      },
    );
  }
  if (path.basename(archivePath) !== parsedReceipt.fileName) {
    receiptMismatch("The archive file name does not match the receipt.", {
      archiveFileName: path.basename(archivePath),
      receiptFileName: parsedReceipt.fileName,
    });
  }
  if (archiveInfo.size !== parsedReceipt.bytes) {
    receiptMismatch("The archive byte size does not match the receipt.", {
      archiveBytes: archiveInfo.size,
      receiptBytes: parsedReceipt.bytes,
    });
  }
  if (
    parsedReceipt.archiveValid === false ||
    parsedReceipt.archiveCheck.valid === false
  ) {
    receiptMismatch("The download receipt marks the archive as invalid.", {
      archiveCheck: parsedReceipt.archiveCheck,
    });
  }

  assertExpectedSource(parsedReceipt, input.expectedSource);

  const actualSha256 = await sha256File(archivePath);
  if (actualSha256 !== parsedReceipt.sha256) {
    receiptMismatch(
      "The archive SHA-256 does not match the verified download receipt.",
      {
        actualSha256,
        receiptSha256: parsedReceipt.sha256,
      },
    );
  }

  const archive = archiveIdentitySchema.parse({
    absolutePath: archivePath,
    fileName: parsedReceipt.fileName,
    bytes: archiveInfo.size,
    sha256: actualSha256,
  });

  return {
    archive,
    receipt: parsedReceipt,
    source: {
      canonicalModUrl: parsedReceipt.canonicalModUrl,
      domainName: parsedReceipt.domainName,
      modId: parsedReceipt.modId,
      fileId: parsedReceipt.fileId,
      backend: parsedReceipt.backend,
      completedAt: parsedReceipt.completedAt,
    },
  };
}
