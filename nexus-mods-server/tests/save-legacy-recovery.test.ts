import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256CanonicalJson } from "../src/install/content-hash.js";
import { BackupStore } from "../src/install/storage/backup-store.js";
import { GenericSaveImportService } from "../src/save/generic/import-service.js";
import { LegacySaveRecoveryService } from "../src/save/legacy/recovery-service.js";
const roots: string[] = [];
const signed = (body: Record<string, unknown>, key: string) => ({ ...body, [key]: sha256CanonicalJson(body) });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(version = "v1") {
  const root = await mkdtemp(path.join(os.tmpdir(), "legacy-recovery-")); roots.push(root);
  const managerRoot = path.join(root, "manager"); const saveRoot = path.join(managerRoot, "save-manager"); const target = path.join(root, "player");
  await mkdir(target); await writeFile(path.join(target, "old.sav"), "old-original"); await writeFile(path.join(target, "deleted.sav"), "deleted-original");
  const objects = await BackupStore.create(saveRoot); const contextId = randomUUID(); const backupId = randomUUID();
  const files = [];
  for (const relativePath of ["old.sav", "deleted.sav"]) {
    const object = await objects.backupFile(path.join(target, relativePath));
    files.push({ relativePath, role: "essential", backupObjectId: object.backupId, bytes: object.bytes, sha256: object.sha256, modifiedAt: new Date().toISOString(), attributes: [] });
  }
  const backup = signed({ schemaVersion: 1, backupId, saveContextId: contextId, unitId: "main", reason: "pre_replacement_rescue", sourceRoot: target, files,
    treeHash: sha256CanonicalJson(files.map(({ relativePath, bytes, sha256 }) => ({ relativePath, bytes, sha256 }))), sourcePreStateHash: "a".repeat(64), sourcePostStateHash: "a".repeat(64),
    profileId: version === "v2" ? "recipe-generated-legacy-profile" : "old-built-in-profile", profileVersion: "1", adapterId: null, createdAt: new Date().toISOString(), integrity: "verified" }, "backupRecordHash");
  async function store(segments: string[], value: unknown) { const file = path.join(saveRoot, ...segments); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); return file; }
  await store(["backups", "records", `${backupId}.json`], backup);
  const service = await LegacySaveRecoveryService.create({ managerRoot });
  return { root, managerRoot, saveRoot, target, service, backupId, backup, files, store, contextId };
}
async function operation(f: Awaited<ReturnType<typeof fixture>>, state = "committed", allNew = false, kind = "replacement") {
  const planId = randomUUID(); const transactionId = randomUUID(); const recordId = randomUUID();
  const absent = { kind: "absent" };
  const imported = { kind: "file", bytes: Buffer.byteLength("imported-new"), sha256: createHash("sha256").update("imported-new").digest("hex") };
  const created = { operationId: randomUUID(), kind: "create-file", rootId: "primary", targetRelativePath: "created.sav", sourceObjectId: randomUUID(), expectedPreState: absent, expectedPostState: imported };
  const operations = [...(allNew ? [] : f.files.map((file) => ({ operationId: randomUUID(), kind: file.relativePath === "old.sav" ? "replace-file" : "delete-file", rootId: "primary", targetRelativePath: file.relativePath,
    sourceObjectId: file.relativePath === "old.sav" ? randomUUID() : null, expectedPreState: { kind: "file", bytes: file.bytes, sha256: file.sha256 }, expectedPostState: file.relativePath === "old.sav" ? imported : absent }))), created];
  const plan = signed({ schemaVersion: 1, [kind === "restore" ? "restorePlanId" : "replacementPlanId"]: planId, target: { rootId: "primary", absolutePath: f.target }, operations }, "planHash");
  await f.store([`${kind}-plans`, `${planId}.json`], plan);
  const transaction = signed({ schemaVersion: 1, transactionId, planKind: kind, planId, planHash: plan.planHash,
    rescueBackupId: allNew ? null : f.backupId, state, events: [{ sequence: 0, phase: "applying", message: "Applying replacement", observedAt: new Date().toISOString() }],
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString() }, "transactionHash");
  await f.store(["transactions", "records", `${transactionId}.json`], transaction);
  const record = signed({ schemaVersion: 1, recordId, kind, planId, transactionId, saveContextId: f.contextId, sourceId: "package-id",
    staticVerification: "passed", runtimeVerification: "not-run", completedAt: new Date().toISOString() }, "recordHash");
  await f.store(["records", `${recordId}.json`], record);
  return { recordId, transactionId, plan, planId, transaction };
}
async function apply(f: Awaited<ReturnType<typeof fixture>>, prepared: Awaited<ReturnType<LegacySaveRecoveryService["prepare"]>>) {
  const service = await GenericSaveImportService.create({ managerRoot: f.managerRoot, processGuard: async () => undefined });
  const plan = await service.plan({ ...prepared, processNames: ["unknown.exe"], evidence: { gameName: "Unknown", installationRoot: f.root,
    source: "Verified historical backup files", target: "Frozen historical target directory", compatibility: "Original exact file bytes", method: "Restore original file state", knownConversionRequired: false } });
  return { service, done: await service.apply(plan.planId), plan };
}
describe("read-only historical recovery export", () => {
  it.each(["v1", "v2"])("exports actual %s backup shape without reading a registry/context", async (version) => {
    const f = await fixture(version); const prepared = await f.service.prepare({ kind: "backup", recordId: f.backupId });
    expect(prepared.deletePaths).toEqual([]); expect(prepared.oldPlanResumable).toBe(false);
    await writeFile(path.join(f.target, "old.sav"), "later-progress"); await writeFile(path.join(f.target, "unrelated.sav"), "keep");
    await apply(f, prepared);
    expect(await readFile(path.join(f.target, "old.sav"), "utf8")).toBe("old-original");
    expect(await readFile(path.join(f.target, "unrelated.sav"), "utf8")).toBe("keep");
  });
  it.each(["restore", "replacement"])("recovers frozen pre-%s files and explicitly removes original absence with reversible rescue", async (kind) => {
    const f = await fixture(); const op = await operation(f, "committed", false, kind);
    await rm(path.join(f.target, "deleted.sav")); await writeFile(path.join(f.target, "created.sav"), "imported-new"); await writeFile(path.join(f.target, "old.sav"), "later-progress");
    const prepared = await f.service.prepare({ kind: "operation", recordId: op.recordId }); expect(prepared.deletePaths).toEqual(["created.sav"]);
    const { service, plan } = await apply(f, prepared);
    expect(await readFile(path.join(f.target, "deleted.sav"), "utf8")).toBe("deleted-original");
    await expect(readFile(path.join(f.target, "created.sav"))).rejects.toMatchObject({ code: "ENOENT" });
    await service.restore(plan.planId); expect(await readFile(path.join(f.target, "old.sav"), "utf8")).toBe("later-progress");
    expect(await readFile(path.join(f.target, "created.sav"), "utf8")).toBe("imported-new");
  });
  it("recovers only touched paths of a finalized interrupted transaction and blocks unknown bytes", async () => {
    const f = await fixture(); const op = await operation(f, "recovery-required"); await rm(path.join(f.target, "deleted.sav"));
    await writeFile(path.join(f.target, "created.sav"), "imported-new");
    const prepared = await f.service.prepare({ kind: "transaction", recordId: op.transactionId });
    expect(prepared.mappings).toEqual([{ sourcePath: "deleted.sav", targetPath: "deleted.sav" }]); expect(prepared.deletePaths).toEqual(["created.sav"]);
    await writeFile(path.join(f.target, "old.sav"), "unrecognized-later-progress");
    await expect(f.service.prepare({ kind: "transaction", recordId: op.transactionId })).rejects.toThrow("unrecognized bytes");
  });
  it("supports a pure-delete recovery when all original paths were absent", async () => {
    const f = await fixture(); const op = await operation(f, "committed", true); await writeFile(path.join(f.target, "created.sav"), "imported-new");
    const prepared = await f.service.prepare({ kind: "operation", recordId: op.recordId }); expect(prepared.mappings).toEqual([]);
    await apply(f, prepared); await expect(readFile(path.join(f.target, "created.sav"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("fails closed for hard-crash journals without the rescue record and for missing frozen scope", async () => {
    const f = await fixture(); const transactionId = randomUUID(); await f.store(["transactions", "journals", `${transactionId}.ndjson`], { kind: "header", schemaVersion: 1, transactionId });
    await expect(f.service.prepare({ kind: "transaction", recordId: transactionId })).rejects.toThrow("Required historical record is missing");
    const op = await operation(f); await rm(path.join(f.saveRoot, "replacement-plans", `${op.planId}.json`));
    await expect(f.service.prepare({ kind: "operation", recordId: op.recordId })).rejects.toThrow("Required historical record is missing");
  });
  it("rejects hash tampering, traversal, missing blobs and junction substitution", async () => {
    const f = await fixture(); const file = f.files[0]!;
    const badBody = { ...f.backup, files: [{ ...file, relativePath: "../escape.sav" }] }; delete (badBody as Record<string, unknown>).backupRecordHash;
    await f.store(["backups", "records", `${f.backupId}.json`], signed(badBody, "backupRecordHash"));
    await expect(f.service.prepare({ kind: "backup", recordId: f.backupId })).rejects.toThrow();
    await f.store(["backups", "records", `${f.backupId}.json`], { ...f.backup, sourceRoot: f.root });
    await expect(f.service.prepare({ kind: "backup", recordId: f.backupId })).rejects.toThrow("integrity");
    await f.store(["backups", "records", `${f.backupId}.json`], f.backup);
    const object = path.join(f.saveRoot, "backups", "objects", "files", file.sha256.slice(0, 2), file.sha256); await rm(object);
    await expect(f.service.prepare({ kind: "backup", recordId: f.backupId })).rejects.toThrow();
    const outside = path.join(f.root, "outside"); await mkdir(outside); await writeFile(path.join(outside, file.sha256), "old-original");
    const objectDir = path.dirname(object); const saved = `${objectDir}-original`; const { rename } = await import("node:fs/promises"); await rename(objectDir, saved); await symlink(outside, objectDir, "junction");
    await expect(f.service.prepare({ kind: "backup", recordId: f.backupId })).rejects.toMatchObject({ code: "SAVE_PATH_PROTECTED" });
  });
});

it("exposes verified historical recovery mappings through MCP", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createNexusMcpServer } = await import("../src/server.js");
  const { NexusClient } = await import("../src/nexus-client.js");
  const f = await fixture("v2"); const op = await operation(f);
  const server = createNexusMcpServer(new NexusClient("fixture-key"), undefined, { managerRoot: f.managerRoot, saveProcessGuard: async () => undefined });
  const client = new Client({ name: "legacy-mcp-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.server.connect(remote), client.connect(local)]);
  try {
    const result = await client.callTool({ name: "prepare_legacy_save_recovery", arguments: { recordId: op.recordId, kind: "operation" } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: true, restoreInput: {
      recordId: op.recordId, kind: "operation", targetRoot: f.target, deletePaths: ["created.sav"], oldPlanResumable: false,
      mappings: [{ sourcePath: "old.sav", targetPath: "old.sav" }, { sourcePath: "deleted.sav", targetPath: "deleted.sav" }]
    } });
    expect(await readFile(path.join(f.target, "old.sav"), "utf8")).toBe("old-original");
  } finally { await client.close(); await server.close(); }
});
