import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupStore } from "../src/install/storage/backup-store.js";
import { SaveInputInspector } from "../src/save/generic/input-inspector.js";
import { GenericSaveImportService, type SaveImportInput } from "../src/save/generic/import-service.js";
const exec = promisify(execFile);
const roots: string[] = [];
async function fixture(checkpoint?: (name: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "generic-save-")); roots.push(root);
  const managerRoot = path.join(root, "manager");
  const inputPath = path.join(root, "input"); const targetRoot = path.join(root, "saves"); const gameRoot = path.join(root, "game");
  await Promise.all([inputPath, targetRoot, gameRoot].map((p) => mkdir(p, { recursive: true })));
  await Promise.all([writeFile(path.join(inputPath, "one.bin"), "new-one"), writeFile(path.join(inputPath, "two.bin"), "new-two"),
    writeFile(path.join(targetRoot, "slot1.sav"), "old-one"), writeFile(path.join(targetRoot, "keep.sav"), "unrelated")]);
  const service = await GenericSaveImportService.create({ managerRoot, processGuard: async () => undefined, ...(checkpoint ? { checkpoint } : {}) });
  const input: SaveImportInput = { inputPath, targetRoot, mappings: [{ sourcePath: "one.bin", targetPath: "slot1.sav" }, { sourcePath: "two.bin", targetPath: "slots/slot2.sav" }],
    processNames: ["unknown-game.exe"], evidence: { gameName: "Unregistered Fixture", installationRoot: gameRoot,
      source: "https://example.test/game/save author says complete", target: "Observed current player files at this exact root", compatibility: "Same platform and version, author instructions corroborated", method: "Author documents copying the complete opaque save files", knownConversionRequired: false } };
  return { root, managerRoot, service, input, targetRoot };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

describe("generic save import recovery and boundaries", () => {
  it("retains untouched files, returns verified backups, and rescues later gameplay on explicit restore", async () => {
    const f = await fixture(); const plan = await f.service.plan(f.input);
    const done = await f.service.apply(plan.planId);
    expect(done.operation?.state).toBe("applied");
    expect(done.backupFiles[0]).toMatchObject({ kind: "original", targetPath: "slot1.sav", absolutePath: expect.any(String) });
    await writeFile(path.join(f.targetRoot, "slot1.sav"), "later-gameplay");
    await writeFile(path.join(f.targetRoot, "later.sav"), "new-slot");
    expect((await f.service.apply(plan.planId)).operation?.state).toBe("applied");
    expect(await readFile(path.join(f.targetRoot, "slot1.sav"), "utf8")).toBe("later-gameplay");
    const restored = await f.service.restore(plan.planId);
    expect(restored.operation?.state).toBe("restored");
    const rescue = restored.backupFiles.find((file) => file.kind === "before_restore" && file.targetPath === "slot1.sav");
    expect(rescue && "absolutePath" in rescue && await readFile(rescue.absolutePath, "utf8")).toBe("later-gameplay");
    expect(await readFile(path.join(f.targetRoot, "slot1.sav"), "utf8")).toBe("old-one");
    expect(await readFile(path.join(f.targetRoot, "later.sav"), "utf8")).toBe("new-slot");
    expect(await readFile(path.join(f.targetRoot, "keep.sav"), "utf8")).toBe("unrelated");
    await expect(readFile(path.join(f.targetRoot, "slots/slot2.sav"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path.join(f.targetRoot, "slot1.sav"), "after-restore");
    await f.service.restore(plan.planId);
    expect(await readFile(path.join(f.targetRoot, "slot1.sav"), "utf8")).toBe("after-restore");
  });

  it("freezes source and target bytes and rejects drift before any write", async () => {
    const f = await fixture(); const plan = await f.service.plan(f.input);
    await writeFile(path.join(plan.stagedRoot, "one.bin"), "changed-source");
    await expect(f.service.apply(plan.planId)).rejects.toMatchObject({ code: "SAVE_INPUT_INVALID" });
    expect((await f.service.get(plan.planId)).operation).toBeNull();
    const second = await f.service.plan(f.input);
    await writeFile(path.join(f.targetRoot, "slot1.sav"), "changed-target");
    await expect(f.service.apply(second.planId)).rejects.toMatchObject({ code: "SAVE_TARGET_DRIFTED" });
    expect((await f.service.get(second.planId)).operation).toBeNull();
  });

  it("rolls back a mid-write failure without touching unrelated files", async () => {
    const f = await fixture(async (name) => { if (name === "after_write:slot1.sav") throw new Error("injected failure"); });
    const plan = await f.service.plan(f.input);
    await expect(f.service.apply(plan.planId)).rejects.toMatchObject({ code: "APPLY_FAILED" });
    expect((await f.service.get(plan.planId)).operation?.state).toBe("rolled_back");
    expect(await readFile(path.join(f.targetRoot, "slot1.sav"), "utf8")).toBe("old-one");
    expect(await readFile(path.join(f.targetRoot, "keep.sav"), "utf8")).toBe("unrelated");
  });

  it("quarantines partially copied staging files before reporting rollback complete", async () => {
    let temp = "";
    const f = await fixture(async (name) => { if (name === "before_write:slot1.sav") { await writeFile(temp, "partial bytes"); throw new Error("copy interrupted"); } });
    const plan = await f.service.plan(f.input);
    temp = `${path.join(f.targetRoot, "slot1.sav")}.${plan.planId}.save-import-tmp`;
    await expect(f.service.apply(plan.planId)).rejects.toMatchObject({ code: "APPLY_FAILED" });
    const result = await f.service.get(plan.planId);
    expect(result.operation?.state).toBe("rolled_back");
    await expect(readFile(temp)).rejects.toMatchObject({ code: "ENOENT" });
    const artifact = result.recoveryFiles[0];
    expect(artifact && "absolutePath" in artifact && await readFile(artifact.absolutePath, "utf8")).toBe("partial bytes");
    expect(await readFile(path.join(f.targetRoot, "slot1.sav"), "utf8")).toBe("old-one");
  });

  it("does not mutate targets when backup fails or the game process is active", async () => {
    const f = await fixture(); const plan = await f.service.plan(f.input);
    vi.spyOn(BackupStore.prototype, "backupFile").mockRejectedValueOnce(new Error("disk full"));
    await expect(f.service.apply(plan.planId)).rejects.toMatchObject({ code: "APPLY_FAILED" });
    expect(await readFile(path.join(f.targetRoot, "slot1.sav"), "utf8")).toBe("old-one");
    const active = await GenericSaveImportService.create({ managerRoot: f.managerRoot, processGuard: async () => { throw new Error("game still running"); } });
    const second = await active.plan(f.input);
    await expect(active.apply(second.planId)).rejects.toThrow("game still running");
    expect((await active.get(second.planId)).operation).toBeNull();
  });

  it("rejects broad roots, traversal, duplicate paths, missing deletion rationale and linked ancestors", async () => {
    const f = await fixture();
    await expect(f.service.plan({ ...f.input, targetRoot: path.parse(f.targetRoot).root })).rejects.toMatchObject({ code: "SAVE_PATH_PROTECTED" });
    await expect(f.service.plan({ ...f.input, mappings: [{ sourcePath: "one.bin", targetPath: "../escape" }] })).rejects.toMatchObject({ code: "SAVE_PATH_INVALID" });
    await expect(f.service.plan({ ...f.input, mappings: [{ sourcePath: "one.bin", targetPath: "A.sav" }, { sourcePath: "two.bin", targetPath: "a.sav" }] })).rejects.toMatchObject({ code: "SAVE_PATH_INVALID" });
    await expect(f.service.plan({ ...f.input, deletePaths: ["keep.sav"] })).rejects.toMatchObject({ code: "EVIDENCE_INSUFFICIENT" });
    const link = path.join(f.root, "alias"); await symlink(f.targetRoot, link, process.platform === "win32" ? "junction" : "dir");
    await expect(f.service.plan({ ...f.input, targetRoot: path.join(link, "child") })).rejects.toMatchObject({ code: "SAVE_PATH_PROTECTED" });
  });

  it("executes explicit deletions and restores their originals", async () => {
    const f = await fixture(); const plan = await f.service.plan({ ...f.input, deletePaths: ["keep.sav"], deletionReason: "Fixture explicit full set replacement removes this companion" });
    await f.service.apply(plan.planId);
    await expect(readFile(path.join(f.targetRoot, "keep.sav"))).rejects.toMatchObject({ code: "ENOENT" });
    await f.service.restore(plan.planId);
    expect(await readFile(path.join(f.targetRoot, "keep.sav"), "utf8")).toBe("unrelated");
  });

  it.each(["backups_complete", "before_write:slot1.sav", "import_staged:slot1.sav", "after_write:slot1.sav"])("recovers real process exit at %s", async (checkpoint) => {
    const f = await fixture(); const plan = await f.service.plan(f.input);
    await expect(exec(process.execPath, ["--import", "tsx", "tests/fixtures/save-import-crash-runner.ts", f.managerRoot, plan.planId, checkpoint, "apply"], { cwd: process.cwd(), windowsHide: true })).rejects.toMatchObject({ code: 86 });
    const resumed = await GenericSaveImportService.create({ managerRoot: f.managerRoot, processGuard: async () => undefined });
    await expect(resumed.apply(plan.planId)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    const other = await resumed.plan(f.input);
    await expect(resumed.apply(other.planId)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect((await resumed.restore(plan.planId)).operation?.state).toBe("restored");
    expect(await readFile(path.join(f.targetRoot, "slot1.sav"), "utf8")).toBe("old-one");
    expect(await readFile(path.join(f.targetRoot, "keep.sav"), "utf8")).toBe("unrelated");
  });

  it("resumes restore after process exit between publishing and journal acknowledgement", async () => {
    const f = await fixture(); const plan = await f.service.plan(f.input); await f.service.apply(plan.planId);
    await expect(exec(process.execPath, ["--import", "tsx", "tests/fixtures/save-import-crash-runner.ts", f.managerRoot, plan.planId, "restore_written:slots/slot2.sav", "restore"], { cwd: process.cwd(), windowsHide: true })).rejects.toMatchObject({ code: 86 });
    const resumed = await GenericSaveImportService.create({ managerRoot: f.managerRoot, processGuard: async () => undefined });
    expect((await resumed.restore(plan.planId)).operation?.state).toBe("restored");
    expect(await readFile(path.join(f.targetRoot, "slot1.sav"), "utf8")).toBe("old-one");
  });

  it("can query and restore independent saves after the installation directory is removed", async () => {
    const f = await fixture(); const plan = await f.service.plan(f.input); await f.service.apply(plan.planId);
    await rm(f.input.evidence.installationRoot!, { recursive: true });
    expect((await f.service.get(plan.planId)).operation?.state).toBe("applied");
    expect((await f.service.restore(plan.planId)).operation?.state).toBe("restored");
    expect(await readFile(path.join(f.targetRoot, "slot1.sav"), "utf8")).toBe("old-one");
  });

  it("enforces input entry and byte bounds on directory and single-file inspection", async () => {
    const f = await fixture();
    const inspector = await SaveInputInspector.create({ managerRoot: f.managerRoot, limits: { maxEntries: 1, maxSingleEntryBytes: 2 } });
    await expect(inspector.inspect(f.input.inputPath!)).rejects.toMatchObject({ code: "SAVE_ARCHIVE_UNSAFE" });
    await expect(inspector.inspect(path.join(f.input.inputPath!, "one.bin"))).rejects.toMatchObject({ code: "SAVE_ARCHIVE_UNSAFE" });
  });

  it("serializes concurrent managers even when target roots overlap", async () => {
    let release!: () => void; let reached!: () => void;
    const ready = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture(async (name) => { if (name === "backups_complete") { reached(); await gate; } });
    const first = await f.service.plan(f.input);
    const secondService = await GenericSaveImportService.create({ managerRoot: f.managerRoot, processGuard: async () => undefined });
    const second = await secondService.plan({ ...f.input, targetRoot: path.join(f.targetRoot, "slots") });
    const running = f.service.apply(first.planId);
    await ready;
    try { await expect(secondService.apply(second.planId)).rejects.toMatchObject({ code: "LOCK_BUSY" }); }
    finally { release(); }
    expect((await running).operation?.state).toBe("applied");
  });
});
