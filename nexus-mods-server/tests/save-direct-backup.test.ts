import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DirectSaveBackupService } from "../src/save/generic/backup-service.js";
import { GenericSaveImportService } from "../src/save/generic/import-service.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(checkpoint?: (name: string) => Promise<void>, processGuard: (names: ReadonlyArray<string>) => Promise<void> = async () => undefined) {
  const root = await mkdtemp(path.join(os.tmpdir(), "direct-backup-")); roots.push(root);
  const sourceRoot = path.join(root, "player"); const managerRoot = path.join(root, "manager");
  await mkdir(path.join(sourceRoot, "slots"), { recursive: true });
  await writeFile(path.join(sourceRoot, "slots", "one.sav"), "original"); await writeFile(path.join(sourceRoot, "keep.sav"), "unrelated");
  const service = await DirectSaveBackupService.create({ managerRoot, processGuard, ...(checkpoint ? { checkpoint } : {}) });
  const input = { sourceRoot, paths: ["slots/one.sav"], processNames: ["unknown.exe"], description: "Before importing an unknown game save" };
  return { root, sourceRoot, managerRoot, service, input };
}
describe("direct exact-file backups", () => {
  it("persists verified snapshots and restores through generic transactions with rescue backup", async () => {
    const f = await fixture(); const backup = await f.service.createBackup(f.input);
    expect(backup.files).toHaveLength(1); expect(backup.integrity).toBe("verified");
    await writeFile(path.join(f.sourceRoot, "slots", "one.sav"), "later-progress");
    const reopened = await DirectSaveBackupService.create({ managerRoot: f.managerRoot, processGuard: async () => undefined });
    expect((await reopened.get(backup.backupId)).recordHash).toBe(backup.recordHash);
    const restore = await reopened.prepareRestore({ backupId: backup.backupId });
    const imports = await GenericSaveImportService.create({ managerRoot: f.managerRoot, processGuard: async () => undefined });
    // Standalone restore remains usable after the installation is removed.
    const removedInstallation = path.join(f.root, "uninstalled-game"); await mkdir(removedInstallation); await rm(removedInstallation, { recursive: true });
    const plan = await imports.plan({ ...restore, evidence: { gameName: "Unknown",
      source: "Verified local backup bytes", target: "Original player save directory", compatibility: "Exact original game save bytes", method: "Restore original file bytes", knownConversionRequired: false } });
    const done = await imports.apply(plan.planId);
    expect(await readFile(path.join(f.sourceRoot, "slots", "one.sav"), "utf8")).toBe("original");
    expect(await readFile(path.join(f.sourceRoot, "keep.sav"), "utf8")).toBe("unrelated");
    const rescue = done.backupFiles.find((file) => file.targetPath === "slots/one.sav");
    expect(rescue && "absolutePath" in rescue && await readFile(rescue.absolutePath, "utf8")).toBe("later-progress");
    await imports.restore(plan.planId);
    expect(await readFile(path.join(f.sourceRoot, "slots", "one.sav"), "utf8")).toBe("later-progress");
  });
  it("does not publish a mixed snapshot when the source changes", async () => {
    let source = ""; const f = await fixture(async () => { await writeFile(source, "changed"); }); source = path.join(f.sourceRoot, "slots", "one.sav");
    await expect(f.service.createBackup(f.input)).rejects.toMatchObject({ code: "SAVE_SOURCE_CHANGED_DURING_BACKUP" });
    expect(await readdir(path.join(f.service.root, "records"))).toEqual([]);
  });
  it("checks process state before copying", async () => {
    const f = await fixture(undefined, async () => { throw new Error("game is running"); });
    await expect(f.service.createBackup(f.input)).rejects.toThrow("game is running");
    expect(await readdir(path.join(f.service.root, "files"))).toEqual([]);
  });
  it("rejects escaped, duplicate, directory and junction paths", async () => {
    const f = await fixture();
    for (const paths of [["../outside.sav"], ["slots/one.sav", "slots/ONE.sav"], ["slots"]]) await expect(f.service.createBackup({ ...f.input, paths })).rejects.toThrow();
    const outside = path.join(f.root, "outside"); await mkdir(outside); await writeFile(path.join(outside, "secret.sav"), "outside");
    await symlink(outside, path.join(f.sourceRoot, "linked"), "junction");
    await expect(f.service.createBackup({ ...f.input, paths: ["linked/secret.sav"] })).rejects.toMatchObject({ code: "SAVE_PATH_PROTECTED" });
  });
  it("rejects corrupted stored bytes and immutable record tampering", async () => {
    const f = await fixture(); const backup = await f.service.createBackup(f.input);
    await writeFile(backup.files[0]!.absolutePath, "corrupted");
    await expect(f.service.get(backup.backupId)).rejects.toMatchObject({ code: "SAVE_BACKUP_INVALID" });
    const second = await f.service.createBackup(f.input); const file = path.join(f.service.root, "records", `${second.backupId}.json`);
    const record = JSON.parse(await readFile(file, "utf8")); record.sourceRoot = f.root; await writeFile(file, JSON.stringify(record));
    await expect(f.service.get(second.backupId)).rejects.toMatchObject({ code: "SAVE_BACKUP_INVALID" });
  });
});

it("runs backup and reversible restore through actual MCP responses", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createNexusMcpServer } = await import("../src/server.js");
  const { NexusClient } = await import("../src/nexus-client.js");
  const f = await fixture();
  const server = createNexusMcpServer(new NexusClient("fixture-key"), undefined, { managerRoot: f.managerRoot, saveProcessGuard: async () => undefined });
  const client = new Client({ name: "backup-mcp-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.server.connect(remote), client.connect(local)]);
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(JSON.stringify(result)).structuredContent).toEqual(result.structuredContent);
    return result.structuredContent as Record<string, unknown>;
  }
  try {
    const created = await call("create_save_backup", f.input);
    const backup = created.backup as Awaited<ReturnType<DirectSaveBackupService["createBackup"]>>;
    expect(backup.backupId).toMatch(/^[a-f0-9-]{36}$/);
    const got = await call("get_save_backup", { backupId: backup.backupId });
    expect(got.backup).toMatchObject({ backupId: backup.backupId, integrity: "verified" });
    await writeFile(path.join(f.sourceRoot, "slots", "one.sav"), "later-progress");
    const prepared = await call("prepare_save_backup_restore", { backupId: backup.backupId });
    const restoreInput = prepared.restoreInput as Awaited<ReturnType<DirectSaveBackupService["prepareRestore"]>>;
    const planned = await call("plan_save_import", { ...restoreInput, evidence: { gameName: "Unknown", installationRoot: f.root,
      source: "Verified original backup files", target: "Local specific player directory", compatibility: "Exact original backup bytes", method: "Restore whole file bytes", knownConversionRequired: false } });
    const plan = planned.plan as { planId: string };
    const applied = await call("apply_save_import", { planId: plan.planId });
    expect(applied.operation).toMatchObject({ state: "applied" });
    expect(await readFile(path.join(f.sourceRoot, "slots", "one.sav"), "utf8")).toBe("original");
    expect((await call("get_save_import", { planId: plan.planId })).backupFiles).toHaveLength(1);
    await call("restore_save_import", { planId: plan.planId });
    expect(await readFile(path.join(f.sourceRoot, "slots", "one.sav"), "utf8")).toBe("later-progress");
    expect(await readFile(path.join(f.sourceRoot, "keep.sav"), "utf8")).toBe("unrelated");
  } finally { await client.close(); await server.close(); }
});
