import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import type { InstallationRecord } from "../contracts.js";
import { installationRecordSchema } from "../contracts.js";

function assertInstallationId(installationId: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      installationId,
    )
  ) {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      "installationId must be a UUID.",
    );
  }
}

async function publishRevision(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await link(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export class InstallationRecordStore {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  static async create(managerRoot: string): Promise<InstallationRecordStore> {
    if (!path.isAbsolute(managerRoot)) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Installation Record managerRoot must be absolute.",
      );
    }
    const root = path.join(path.resolve(managerRoot), "installations");
    await mkdir(root, { recursive: true });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new NexusError(
        "PROTECTED_PATH",
        "Installation Record Store must be a real directory.",
        { details: { root } },
      );
    }
    return new InstallationRecordStore(root);
  }

  async saveNew(record: InstallationRecord): Promise<InstallationRecord> {
    const parsed = installationRecordSchema.parse(record);
    if (parsed.revision !== 1) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "A new Installation Record must begin at revision 1.",
      );
    }
    const installationRoot = this.#installationRoot(parsed.installationId);
    await mkdir(installationRoot, { recursive: false });
    await mkdir(path.join(installationRoot, "revisions"), { recursive: false });
    await publishRevision(this.#revisionPath(parsed.installationId, 1), parsed);
    await this.#writeCurrentPointer(parsed.installationId, 1);
    return parsed;
  }

  async update(record: InstallationRecord): Promise<InstallationRecord> {
    const parsed = installationRecordSchema.parse(record);
    const current = await this.get(parsed.installationId);
    if (parsed.revision !== current.revision + 1) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Installation Record updates must increment revision by exactly one.",
        {
          details: {
            installationId: parsed.installationId,
            currentRevision: current.revision,
            proposedRevision: parsed.revision,
          },
        },
      );
    }
    await publishRevision(
      this.#revisionPath(parsed.installationId, parsed.revision),
      parsed,
    );
    await this.#writeCurrentPointer(parsed.installationId, parsed.revision);
    return parsed;
  }

  async get(installationId: string): Promise<InstallationRecord> {
    assertInstallationId(installationId);
    let revision: number;
    try {
      const pointer = JSON.parse(
        await readFile(
          path.join(this.#installationRoot(installationId), "current.json"),
          "utf8",
        ),
      ) as { revision?: unknown };
      if (
        typeof pointer.revision !== "number" ||
        !Number.isSafeInteger(pointer.revision) ||
        pointer.revision <= 0
      ) {
        throw new Error("Invalid current revision pointer.");
      }
      revision = pointer.revision;
    } catch (error) {
      throw new NexusError(
        "NOT_FOUND",
        "Installation Record was not found.",
        { cause: error, details: { installationId } },
      );
    }
    try {
      return installationRecordSchema.parse(
        JSON.parse(
          await readFile(this.#revisionPath(installationId, revision), "utf8"),
        ) as unknown,
      );
    } catch (error) {
      throw new NexusError(
        "RECOVERY_REQUIRED",
        "The current Installation Record revision is missing or corrupt.",
        { cause: error, details: { installationId, revision } },
      );
    }
  }

  async listByInstance(
    gameInstanceId: string,
  ): Promise<ReadonlyArray<InstallationRecord>> {
    const names = await readdir(this.#root);
    const records: InstallationRecord[] = [];
    for (const name of names) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          name,
        )
      ) {
        continue;
      }
      const record = await this.get(name);
      if (record.gameInstanceId === gameInstanceId) records.push(record);
    }
    return records.sort((left, right) =>
      left.installedAt.localeCompare(right.installedAt),
    );
  }

  async findByTransaction(
    gameInstanceId: string,
    transactionId: string,
  ): Promise<InstallationRecord | null> {
    const records = await this.listByInstance(gameInstanceId);
    return (
      records.find(
        (record) =>
          record.transactionId === transactionId ||
          record.uninstallTransactionId === transactionId,
      ) ?? null
    );
  }

  #installationRoot(installationId: string): string {
    assertInstallationId(installationId);
    return path.join(this.#root, installationId);
  }

  #revisionPath(installationId: string, revision: number): string {
    return path.join(
      this.#installationRoot(installationId),
      "revisions",
      `${String(revision).padStart(8, "0")}.json`,
    );
  }

  async #writeCurrentPointer(
    installationId: string,
    revision: number,
  ): Promise<void> {
    const currentPath = path.join(
      this.#installationRoot(installationId),
      "current.json",
    );
    const temporaryPath = `${currentPath}.${randomUUID()}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ revision, updatedAt: new Date().toISOString() })}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await rename(temporaryPath, currentPath);
  }
}
