import { randomUUID } from "node:crypto";
import {
  link,
  unlink,
  writeFile,
} from "node:fs/promises";

import { NexusError } from "../../errors.js";

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
