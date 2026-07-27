import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";

interface InstanceLockRecord {
  schemaVersion: 1;
  instanceId: string;
  transactionId: string;
  pid: number;
  token: string;
  acquiredAt: string;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readRecord(lockPath: string): Promise<InstanceLockRecord | null> {
  try {
    const value = JSON.parse(
      await readFile(lockPath, "utf8"),
    ) as Partial<InstanceLockRecord>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.instanceId !== "string" ||
      typeof value.transactionId !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.token !== "string" ||
      typeof value.acquiredAt !== "string"
    ) {
      return null;
    }
    return value as InstanceLockRecord;
  } catch {
    return null;
  }
}

export class InstanceLock {
  readonly #lockPath: string;
  readonly #record: InstanceLockRecord;
  #owned = false;

  constructor(input: {
    locksRoot: string;
    instanceId: string;
    transactionId: string;
  }) {
    if (!path.isAbsolute(input.locksRoot)) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Instance locksRoot must be absolute.",
      );
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.instanceId,
      )
    ) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "instanceId must be a UUID.",
      );
    }
    this.#lockPath = path.join(
      path.resolve(input.locksRoot),
      `${input.instanceId}.lock`,
    );
    this.#record = {
      schemaVersion: 1,
      instanceId: input.instanceId,
      transactionId: input.transactionId,
      pid: process.pid,
      token: randomUUID(),
      acquiredAt: new Date().toISOString(),
    };
  }

  get owned(): boolean {
    return this.#owned;
  }

  async acquire(): Promise<void> {
    if (this.#owned) return;
    await mkdir(path.dirname(this.#lockPath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.#lockPath, "wx");
        try {
          await handle.writeFile(`${JSON.stringify(this.#record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        this.#owned = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readRecord(this.#lockPath);
        if (existing && processIsAlive(existing.pid)) {
          throw new NexusError(
            "LOCK_BUSY",
            "Another transaction is already using this game instance.",
            {
              retryable: true,
              details: {
                instanceId: existing.instanceId,
                transactionId: existing.transactionId,
                pid: existing.pid,
                acquiredAt: existing.acquiredAt,
              },
            },
          );
        }
        await rm(this.#lockPath, { force: true });
      }
    }
    throw new NexusError(
      "LOCK_BUSY",
      "The game-instance lock could not be acquired.",
      { retryable: true },
    );
  }

  async release(): Promise<void> {
    if (!this.#owned) return;
    const current = await readRecord(this.#lockPath);
    this.#owned = false;
    if (current?.token === this.#record.token) {
      await rm(this.#lockPath, { force: true });
    }
  }
}
