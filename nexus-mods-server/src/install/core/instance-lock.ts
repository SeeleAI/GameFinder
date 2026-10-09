import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
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
      !/^[0-9a-f-]{36}$/i.test(value.token) ||
      typeof value.acquiredAt !== "string"
    ) {
      return null;
    }
    return value as InstanceLockRecord;
  } catch {
    return null;
  }
}

// Publish a complete record atomically: an observer must never mistake the
// create/write gap of a live owner for a malformed abandoned lock.
async function publishRecord(lockPath: string, record: InstanceLockRecord): Promise<void> {
  const temporary = `${lockPath}.${record.token}.tmp`;
  const handle = await open(temporary, "wx");
  try { await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  try { await link(temporary, lockPath); }
  finally { await rm(temporary, { force: true }); }
}

async function reclaimDeadRecord(lockPath: string, stale: InstanceLockRecord, owner: InstanceLockRecord, depth = 0): Promise<void> {
  if (depth > 8) throw new NexusError("LOCK_BUSY", "Repeatedly interrupted lock recovery needs inspection.");
  // A generation-specific claim serializes competing stale-lock reclaimers.
  // If a reclaimer itself dies, its complete claim can be recovered likewise.
  const claimPath = `${lockPath}.reclaim-${stale.token}`;
  const claim = { ...owner, token: randomUUID() };
  try { await publishRecord(claimPath, claim); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const competing = await readRecord(claimPath);
    if (!competing || processIsAlive(competing.pid)) throw new NexusError("LOCK_BUSY", "Another process is reclaiming the stale lock.", { retryable: true });
    await reclaimDeadRecord(claimPath, competing, owner, depth + 1);
    await publishRecord(claimPath, claim);
  }
  try {
    const current = await readRecord(lockPath);
    if (current?.token === stale.token && !processIsAlive(current.pid)) await rm(lockPath, { force: true });
  } finally {
    if ((await readRecord(claimPath))?.token === claim.token) await rm(claimPath, { force: true });
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
        await publishRecord(this.#lockPath, this.#record);
        this.#owned = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readRecord(this.#lockPath);
        if (!existing) throw new NexusError("LOCK_BUSY", "An unreadable lock is preserved for inspection; it cannot be treated as abandoned.");
        if (processIsAlive(existing.pid)) {
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
        await reclaimDeadRecord(this.#lockPath, existing, this.#record);
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
