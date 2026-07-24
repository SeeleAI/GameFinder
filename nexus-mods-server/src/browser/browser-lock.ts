import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { NexusError } from "../errors.js";

interface LockRecord {
  pid: number;
  startedAt: string;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function readLockRecord(lockPath: string): Promise<LockRecord | null> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockRecord>;
    if (typeof value.pid !== "number" || typeof value.startedAt !== "string") return null;
    return { pid: value.pid, startedAt: value.startedAt };
  } catch {
    return null;
  }
}

export class BrowserProfileLock {
  readonly lockPath: string;
  #owned = false;

  constructor(profileDir: string) {
    this.lockPath = `${profileDir}.lock`;
  }

  get owned(): boolean {
    return this.#owned;
  }

  async isBusy(): Promise<boolean> {
    if (this.#owned) return false;
    const record = await readLockRecord(this.lockPath);
    return record !== null && processIsAlive(record.pid);
  }

  async acquire(): Promise<void> {
    if (this.#owned) return;
    await mkdir(path.dirname(this.lockPath), { recursive: true });
    const record: LockRecord = { pid: process.pid, startedAt: new Date().toISOString() };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.lockPath, "wx");
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        } finally {
          await handle.close();
        }
        this.#owned = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readLockRecord(this.lockPath);
        if (existing && processIsAlive(existing.pid)) {
          throw new NexusError(
            "BROWSER_PROFILE_BUSY",
            "The dedicated Nexus Chromium profile is already in use by another process.",
            { retryable: true }
          );
        }
        await rm(this.lockPath, { force: true });
      }
    }

    throw new NexusError("BROWSER_PROFILE_BUSY", "Could not acquire the dedicated Nexus Chromium profile lock.", {
      retryable: true
    });
  }

  async release(): Promise<void> {
    if (!this.#owned) return;
    this.#owned = false;
    await rm(this.lockPath, { force: true });
  }
}
