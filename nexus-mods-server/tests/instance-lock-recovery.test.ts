import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { InstanceLock } from "../src/install/core/instance-lock.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const locksRoot = await mkdtemp(path.join(os.tmpdir(), "instance-lock-recovery-")); roots.push(locksRoot);
  const instanceId = randomUUID();
  const lockPath = path.join(locksRoot, `${instanceId}.lock`);
  return { locksRoot, instanceId, lockPath };
}
it("does not interpret incomplete records as abandoned live locks", async () => {
  const f = await fixture(); await writeFile(f.lockPath, "");
  const lock = new InstanceLock({ ...f, transactionId: randomUUID() });
  await expect(lock.acquire()).rejects.toMatchObject({ code: "LOCK_BUSY" });
  expect(await readFile(f.lockPath, "utf8")).toBe("");
});
it("serializes simultaneous reclaimers of a dead generation", async () => {
  const f = await fixture();
  await writeFile(f.lockPath, JSON.stringify({ schemaVersion: 1, instanceId: f.instanceId, transactionId: randomUUID(), pid: 2147483647, token: randomUUID(), acquiredAt: new Date().toISOString() }));
  const locks = Array.from({ length: 12 }, () => new InstanceLock({ ...f, transactionId: randomUUID() }));
  const results = await Promise.allSettled(locks.map((lock) => lock.acquire()));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(locks.filter((lock) => lock.owned)).toHaveLength(1);
  await Promise.all(locks.map((lock) => lock.release()));
});
it("recovers a dead reclaimer's claim without removing another live owner's generation", async () => {
  const f = await fixture(); const token = randomUUID();
  const stale = { schemaVersion: 1, instanceId: f.instanceId, transactionId: randomUUID(), pid: 2147483647, token, acquiredAt: new Date().toISOString() };
  await writeFile(f.lockPath, JSON.stringify(stale));
  await writeFile(`${f.lockPath}.reclaim-${token}`, JSON.stringify({ ...stale, token: randomUUID() }));
  const lock = new InstanceLock({ ...f, transactionId: randomUUID() });
  await lock.acquire(); expect(lock.owned).toBe(true);
  const rival = new InstanceLock({ ...f, transactionId: randomUUID() });
  await expect(rival.acquire()).rejects.toMatchObject({ code: "LOCK_BUSY" });
  await lock.release();
});
