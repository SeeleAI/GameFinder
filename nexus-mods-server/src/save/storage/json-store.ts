import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { z } from "zod/v4";

import { NexusError } from "../../errors.js";

export async function ensureRealStoreDirectory(
  managerRoot: string,
  ...segments: string[]
): Promise<string> {
  if (!path.isAbsolute(managerRoot)) {
    throw new NexusError(
      "SAVE_CONTRACT_INVALID",
      "Save managerRoot must be absolute.",
      { details: { managerRoot } },
    );
  }
  const resolvedManagerRoot = path.resolve(managerRoot);
  if (resolvedManagerRoot === path.parse(resolvedManagerRoot).root) {
    throw new NexusError(
      "SAVE_PATH_PROTECTED",
      "A filesystem root cannot be the save manager root.",
      { details: { managerRoot: resolvedManagerRoot } },
    );
  }
  const directory = path.join(
    resolvedManagerRoot,
    "save-manager",
    ...segments,
  );
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new NexusError(
      "SAVE_PATH_PROTECTED",
      "Save state stores must be real directories.",
      { details: { directory } },
    );
  }
  return directory;
}

export function assertUuid(value: string, fieldName: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new NexusError(
      "SAVE_CONTRACT_INVALID",
      `${fieldName} must be a UUID.`,
      { details: { [fieldName]: value } },
    );
  }
}

export async function publishJsonExclusive(
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
  } catch (error) {
    throw new NexusError(
      "SAVE_CONTRACT_INVALID",
      "An immutable save state object could not be published.",
      { cause: error, details: { filePath } },
    );
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function readStoredJson<T>(
  filePath: string,
  schema: z.ZodType<T>,
  notFoundMessage: string,
): Promise<T> {
  try {
    return schema.parse(
      JSON.parse(await readFile(filePath, "utf8")) as unknown,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new NexusError("NOT_FOUND", notFoundMessage, {
        details: { filePath },
      });
    }
    throw new NexusError(
      "SAVE_CONTEXT_STALE",
      "Stored save state is unreadable or invalid.",
      { cause: error, details: { filePath } },
    );
  }
}
