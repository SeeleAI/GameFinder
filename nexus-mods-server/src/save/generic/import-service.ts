import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod/v4";
import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import { InstanceLock } from "../../install/core/instance-lock.js";
import { assertSensitiveProcessesStopped } from "../../install/core/process-guard.js";
import { sha256File } from "../../install/file-hash.js";
import { BackupStore } from "../../install/storage/backup-store.js";
import { SaveInputInspector } from "./input-inspector.js";
import { assertUuid, publishJsonExclusive } from "../storage/json-store.js";
import { assertRealPath, relativeFile, stageSaveInput } from "./input.js";
import { EldenRingFileService } from "../formats/elden-ring.js";

const evidenceText = z.string().trim().min(12).max(8000);
export const saveImportInputSchema = z.object({
  inputPath: z.string().min(3).optional(),
  preparationId: z.string().uuid().optional(),
  targetRoot: z.string().min(3),
  mappings: z.array(z.object({ sourcePath: z.string().min(1), targetPath: z.string().min(1) })).max(10000),
  deletePaths: z.array(z.string().min(1)).max(10000).default([]),
  deletionReason: evidenceText.optional(),
  processNames: z.array(z.string().regex(/^[^\\/:*?"<>|\x00-\x1f]+$/)).min(1).max(64),
  evidence: z.object({
    gameName: z.string().trim().min(1),
    installationRoot: z.string().min(3).optional(),
    source: evidenceText.describe("Source URL/local provenance and selected completion claims."),
    target: evidenceText.describe("Why this precise directory belongs to the intended game and player."),
    compatibility: evidenceText.describe("Concrete version/platform/DLC applicability evidence and remaining uncertainty."),
    method: evidenceText.describe("Evidence for importing whole files without internal conversion."),
    knownConversionRequired: z.boolean(),
  }),
});
export type SaveImportInput = z.input<typeof saveImportInputSchema>;
const stateSchema = z.object({ sha256: z.string(), bytes: z.number() }).nullable();
type FileState = z.infer<typeof stateSchema>;
const changeSchema = z.object({ targetPath: z.string(), sourcePath: z.string().nullable(), source: stateSchema, before: stateSchema });
const planSchema = z.object({
  schemaVersion: z.literal(1), planId: z.string().uuid(), createdAt: z.string(),
  targetRoot: z.string(), stagedRoot: z.string(),
  processNames: z.array(z.string()), evidence: saveImportInputSchema.shape.evidence,
  preparationId: z.string().uuid().optional(),
  deletionReason: z.string().nullable(), changes: z.array(changeSchema), planHash: z.string(),
});
type Plan = z.infer<typeof planSchema>;
const recordSchema = z.object({
  planId: z.string().uuid(), state: z.enum(["backing_up", "applying", "applied", "restoring", "restored", "rolled_back", "recovery_required"]),
  backups: z.record(z.string(), z.string().nullable()),
  touched: z.array(z.string()), restored: z.array(z.string()),
  rescue: z.record(z.string(), z.string().nullable()),
  rescueHistory: z.array(z.object({ targetPath: z.string(), backupId: z.string().nullable(), state: stateSchema })).default([]),
  artifacts: z.array(z.object({ path: z.string(), backupId: z.string() })).default([]),
  restoreExpected: z.record(z.string(), stateSchema),
  updatedAt: z.string(), error: z.string().nullable(),
});
type RecordState = z.infer<typeof recordSchema>;
const ACTIVE = new Set(["backing_up", "applying", "restoring", "recovery_required"]);
const EXECUTABLE = /\.(exe|dll|com|bat|cmd|ps1|vbs|js|msi|scr)$/i;
const LOCK_ID = "9067b2dd-a884-4d0a-bef1-aea38b6ed333";

function equal(a: FileState, b: FileState): boolean { return sha256CanonicalJson(a) === sha256CanonicalJson(b); }
function within(root: string, child: string): boolean {
  const relative = path.relative(root.toLowerCase(), child.toLowerCase());
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
async function fileState(file: string): Promise<FileState> {
  await assertRealPath(file);
  const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!stat) return null;
  if (!stat.isFile()) throw new NexusError("SAVE_PATH_PROTECTED", "Only exact regular-file targets are supported.", { details: { file } });
  return { bytes: stat.size, sha256: await sha256File(file) };
}

export class GenericSaveImportService {
  private constructor(
    readonly root: string,
    readonly inspector: SaveInputInspector,
    private readonly backups: BackupStore,
    private readonly processGuard: (names: ReadonlyArray<string>) => Promise<void>,
    private readonly checkpoint?: (name: string) => Promise<void>,
  ) {}

  static async create(options: {
    managerRoot: string;
    processGuard?: (names: ReadonlyArray<string>) => Promise<void>;
    /** Fault/crash injection for isolated tests only; never exposed by MCP. */
    checkpoint?: (name: string) => Promise<void>;
  }) {
    const root = path.resolve(options.managerRoot, "save-manager", "generic-imports");
    await assertRealPath(root);
    for (const name of ["plans", "records", "staging", "locks"]) await mkdir(path.join(root, name), { recursive: true });
    return new GenericSaveImportService(root,
      await SaveInputInspector.create({ managerRoot: options.managerRoot }),
      await BackupStore.create(path.join(root, "data")),
      options.processGuard ?? assertSensitiveProcessesStopped, options.checkpoint);
  }

  private get conversionStagingRoot() { return path.resolve(this.root, "../formats/elden-ring/staging"); }

  async inspect(inputPath: string) {
    if (within(this.conversionStagingRoot, path.resolve(inputPath))) throw new NexusError("SAVE_STAGING_INVALID", "Use the conversion preparationId directly in plan_save_import; do not detach converted bytes from their destination prestate.");
    return await stageSaveInput(this.inspector, inputPath, path.join(this.root, "staging"));
  }

  private target(plan: Plan, name: string): string { return path.join(plan.targetRoot, ...relativeFile(name).split("/")); }

  private async checkRoot(targetRoot: string, installationRoot: string | undefined, requireInstallation = false) {
    if (!path.isAbsolute(targetRoot) || (installationRoot !== undefined && !path.isAbsolute(installationRoot))) throw new NexusError("SAVE_PATH_INVALID", "Target and installation roots must be absolute.");
    await assertRealPath(targetRoot);
    if (requireInstallation && installationRoot !== undefined) {
      await assertRealPath(installationRoot);
      const installation = await lstat(installationRoot);
      if (!installation.isDirectory()) throw new NexusError("SAVE_PATH_INVALID", "Installation root must be a real directory.");
    }
    const home = process.env.USERPROFILE || os.homedir();
    const broad = [path.parse(targetRoot).root, home, path.dirname(home), os.tmpdir(),
      path.join(home, "Documents"), path.join(home, "Saved Games"), path.join(home, "AppData"),
      process.env.APPDATA, process.env.LOCALAPPDATA, process.env.ProgramData, process.env.ProgramFiles, process.env["ProgramFiles(x86)"],
      process.env.SystemRoot].filter((value): value is string => Boolean(value));
    if (broad.some((item) => path.resolve(item).toLowerCase() === targetRoot.toLowerCase()) || within(targetRoot, this.root) || within(this.root, targetRoot)
      || (process.env.SystemRoot && within(process.env.SystemRoot, targetRoot))) {
      throw new NexusError("SAVE_PATH_PROTECTED", "Choose the specific player save directory, outside protected or manager roots.");
    }
    const stat = await lstat(targetRoot).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (stat && !stat.isDirectory()) throw new NexusError("SAVE_PATH_INVALID", "Target root is not a directory.");
  }

  async plan(raw: SaveImportInput) {
    const input = saveImportInputSchema.parse(raw);
    if (input.evidence.knownConversionRequired) throw new NexusError("SAVE_CONVERSION_REQUIRED", "Complete the known conversion with a suitable tool before planning a byte-preserving import.");
    if (input.deletePaths.length && !input.deletionReason) throw new NexusError("EVIDENCE_INSUFFICIENT", "Explicit deletion requires its task or format rationale.");
    if (!input.mappings.length && !input.deletePaths.length) throw new NexusError("INVALID_INPUT", "Select at least one import or deletion.");
    const targetRoot = path.resolve(input.targetRoot);
    await this.checkRoot(input.targetRoot, input.evidence.installationRoot, true);
    if (input.mappings.length && !input.inputPath) throw new NexusError("INVALID_INPUT", "Import mappings require inputPath.");
    const conversion = input.preparationId ? await (await EldenRingFileService.create({ managerRoot: path.resolve(this.root, "../..") })).get(input.preparationId) : null;
    if (input.inputPath && within(this.conversionStagingRoot, path.resolve(input.inputPath)) && !conversion) throw new NexusError("SAVE_STAGING_INVALID", "Converted input requires its preparationId.");
    if (conversion && (!input.inputPath || path.resolve(input.inputPath) !== conversion.inputPath || targetRoot !== conversion.targetRoot
      || sha256CanonicalJson(input.mappings) !== sha256CanonicalJson(conversion.mappings) || input.deletePaths.length)) {
      throw new NexusError("SAVE_STAGING_INVALID", "Import must use the exact converted input, destination and mappings from its receipt.");
    }
    const staged = input.mappings.length ? await stageSaveInput(this.inspector, input.inputPath!, path.join(this.root, "staging")) : { stagedInput: { root: path.join(this.root, "staging", randomUUID()), files: [] } };
    if (!input.mappings.length) await mkdir(staged.stagedInput.root, { recursive: true });
    const paths: string[] = [];
    const changes: Plan["changes"] = [];
    for (const mapping of [...input.mappings, ...input.deletePaths.map((targetPath) => ({ targetPath, sourcePath: null }))]) {
      const targetPath = relativeFile(mapping.targetPath);
      if (EXECUTABLE.test(targetPath)) throw new NexusError("SAVE_PATH_PROTECTED", "Executable targets are outside save import scope.");
      const key = targetPath.toLowerCase();
      if (paths.some((other) => other === key || other.startsWith(`${key}/`) || key.startsWith(`${other}/`))) throw new NexusError("SAVE_PATH_INVALID", "Mappings contain duplicate or overlapping target paths.");
      paths.push(key);
      const sourcePath = mapping.sourcePath === null ? null : relativeFile(mapping.sourcePath);
      const sourceFile = sourcePath === null ? null : staged.stagedInput.files.find((file) => file.relativePath === sourcePath);
      if (sourcePath && (!sourceFile || EXECUTABLE.test(sourcePath))) throw new NexusError("SAVE_INPUT_INVALID", "Selected source must be an inspected non-executable file.");
      const before = await fileState(path.join(targetRoot, ...targetPath.split("/")));
      if (conversion) {
        const expected = conversion.expectedTargets.find((item) => item.targetPath === targetPath);
        if (!expected || !equal(before, { sha256: expected.sha256, bytes: expected.bytes })) throw new NexusError("SAVE_TARGET_DRIFTED", "Destination changed after conversion; analyze and prepare again to preserve new progress.");
        if (sourceFile?.sha256 !== conversion.stagedSha256) throw new NexusError("SAVE_STAGING_INVALID", "Conversion source changed while freezing.");
      }
      changes.push({ targetPath, sourcePath, source: sourceFile ? { sha256: sourceFile.sha256, bytes: sourceFile.bytes } : null, before });
    }
    const body = { schemaVersion: 1 as const, planId: randomUUID(), createdAt: new Date().toISOString(), targetRoot,
      stagedRoot: staged.stagedInput.root, processNames: input.processNames, evidence: input.evidence,
      ...(input.preparationId ? { preparationId: input.preparationId } : {}),
      deletionReason: input.deletionReason ?? null, changes };
    const plan = planSchema.parse({ ...body, planHash: sha256CanonicalJson(body) });
    await publishJsonExclusive(path.join(this.root, "plans", `${plan.planId}.json`), plan);
    return plan;
  }

  private async readPlan(planId: string): Promise<Plan> {
    assertUuid(planId, "planId");
    await assertRealPath(this.root);
    const plan = planSchema.parse(JSON.parse(await readFile(path.join(this.root, "plans", `${planId}.json`), "utf8")));
    const { planHash, ...body } = plan;
    if (planId !== plan.planId || planHash !== sha256CanonicalJson(body) || !within(path.join(this.root, "staging"), plan.stagedRoot)) throw new NexusError("SAVE_CONTRACT_INVALID", "Stored import plan failed integrity checks.");
    return plan;
  }
  private async readRecord(planId: string): Promise<RecordState | null> {
    try { return recordSchema.parse(JSON.parse(await readFile(path.join(this.root, "records", `${planId}.json`), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private async writeRecord(record: RecordState) {
    record.updatedAt = new Date().toISOString();
    const final = path.join(this.root, "records", `${record.planId}.json`);
    await assertRealPath(final);
    const temporary = `${final}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx");
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, final);
  }
  async get(planId: string) {
    const plan = await this.readPlan(planId);
    const operation = await this.readRecord(planId);
    const backupFiles = [];
    for (const [kind, entries] of [["original", operation?.backups ?? {}], ["before_restore", operation?.rescue ?? {}]] as const) {
      for (const [targetPath, backupId] of Object.entries(entries)) {
        if (!backupId) continue;
        try { const backup = await this.backups.get(backupId); backupFiles.push({ kind, targetPath, ...backup }); }
        catch (error) { backupFiles.push({ kind, targetPath, backupId, error: error instanceof Error ? error.message : String(error) }); }
      }
    }
    for (const prior of operation?.rescueHistory ?? []) {
      if (!prior.backupId) continue;
      try { backupFiles.push({ kind: "before_restore" as const, targetPath: prior.targetPath, ...await this.backups.get(prior.backupId) }); }
      catch (error) { backupFiles.push({ kind: "before_restore" as const, targetPath: prior.targetPath, backupId: prior.backupId, error: error instanceof Error ? error.message : String(error) }); }
    }
    const recoveryFiles = [];
    for (const artifact of operation?.artifacts ?? []) {
      try { recoveryFiles.push({ originalPath: artifact.path, ...await this.backups.get(artifact.backupId) }); }
      catch (error) { recoveryFiles.push({ originalPath: artifact.path, backupId: artifact.backupId, error: error instanceof Error ? error.message : String(error) }); }
    }
    return { plan, operation, backupFiles, recoveryFiles,
      recordPath: path.join(this.root, "records", `${planId}.json`), backupRoot: path.join(this.root, "data", "backups"),
      runtimeVerification: "not_performed" as const };
  }

  private async locked<T>(planId: string, action: () => Promise<T>): Promise<T> {
    const lock = new InstanceLock({ locksRoot: path.join(this.root, "locks"), instanceId: LOCK_ID, transactionId: planId });
    await assertRealPath(this.root);
    await lock.acquire();
    try {
      for (const file of await readdir(path.join(this.root, "records"))) {
        if (!file.endsWith(".json") || file === `${planId}.json`) continue;
        const record = await this.readRecord(file.slice(0, -5));
        if (record && ACTIVE.has(record.state)) throw new NexusError("RECOVERY_REQUIRED", "Recover the interrupted import before another save write.", { details: { planId: record.planId } });
      }
      return await action();
    } finally { await lock.release(); }
  }

  private async verifyState(plan: Plan, change: Plan["changes"][number], expected: FileState) {
    if (!equal(await fileState(this.target(plan, change.targetPath)), expected)) throw new NexusError("SAVE_TARGET_DRIFTED", "A selected target changed; preserve it and prepare a fresh import.", { details: { targetPath: change.targetPath } });
  }
  private async guard(plan: Plan) { await this.checkRoot(plan.targetRoot, plan.evidence.installationRoot); await this.processGuard(plan.processNames); }

  // Each individual rename is atomic; the journal, not an atomicity claim,
  // makes the entire multi-file operation recoverable after process exit.
  private async publish(plan: Plan, change: Plan["changes"][number], source: string | null, expected: FileState, restoring = false) {
    const target = this.target(plan, change.targetPath);
    await assertRealPath(target);
    if (!source) { await this.verifyState(plan, change, expected); await unlink(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); return; }
    await assertRealPath(source);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${plan.planId}.save-${restoring ? "restore" : "import"}-tmp`;
    await assertRealPath(temporary);
    // A previous interrupted publish may have left this exact owned temporary
    // file. Preserve unexpected contents; never blindly overwrite them.
    const temporaryState = await fileState(temporary);
    const sourceState = await fileState(source);
    if (temporaryState && !equal(temporaryState, sourceState)) throw new NexusError("RECOVERY_REQUIRED", "An interrupted staging file has unexpected contents.", { details: { temporary } });
    if (!temporaryState) await copyFile(source, temporary, constants.COPYFILE_EXCL);
    if (!equal(await fileState(temporary), sourceState)) throw new NexusError("SAVE_STATIC_VERIFICATION_FAILED", "Publish staging bytes did not verify.");
    const handle = await open(temporary, "r+"); try { await handle.sync(); } finally { await handle.close(); }
    await this.verifyState(plan, change, expected);
    await assertRealPath(target);
    await this.checkpoint?.(`${restoring ? "restore" : "import"}_staged:${change.targetPath}`);
    await rename(temporary, target);
  }

  async apply(planId: string) {
    return await this.locked(planId, async () => {
      const plan = await this.readPlan(planId);
      const existing = await this.readRecord(planId);
      if (existing?.state === "applied") return await this.get(planId);
      if (existing) throw new NexusError("RECOVERY_REQUIRED", "This plan was already attempted. Recover it or create a new plan; apply never replays writes.", { details: { planId, state: existing.state } });
      await this.guard(plan);
      for (const change of plan.changes) {
        await this.verifyState(plan, change, change.before);
        for (const phase of ["import", "restore"]) {
          if (await fileState(`${this.target(plan, change.targetPath)}.${plan.planId}.save-${phase}-tmp`)) throw new NexusError("SAVE_TARGET_DRIFTED", "An operation staging path already exists before apply.");
        }
        if (change.sourcePath && !equal(await fileState(path.join(plan.stagedRoot, ...change.sourcePath.split("/"))), change.source)) throw new NexusError("SAVE_INPUT_INVALID", "Frozen source bytes changed.");
      }
      const record: RecordState = { planId, state: "backing_up", backups: {}, touched: [], restored: [], rescue: {}, rescueHistory: [], artifacts: [], restoreExpected: {}, updatedAt: new Date().toISOString(), error: null };
      await this.writeRecord(record);
      try {
        for (const change of plan.changes) {
          await this.verifyState(plan, change, change.before);
          const backup = change.before ? await this.backups.backupFile(this.target(plan, change.targetPath)) : null;
          if (backup && !equal({ sha256: backup.sha256, bytes: backup.bytes }, change.before)) throw new NexusError("SAVE_RESCUE_BACKUP_FAILED", "Backup did not match frozen target.");
          record.backups[change.targetPath] = backup?.backupId ?? null;
        }
        // Backups for the whole affected set are durable before any live write.
        record.state = "applying";
        await this.writeRecord(record);
        await this.checkpoint?.("backups_complete");
        for (const change of plan.changes) {
          await this.guard(plan);
          await this.verifyState(plan, change, change.before);
          record.touched.push(change.targetPath);
          await this.writeRecord(record); // write-ahead intent before mutation
          await this.checkpoint?.(`before_write:${change.targetPath}`);
          const source = change.sourcePath ? path.join(plan.stagedRoot, ...change.sourcePath.split("/")) : null;
          if (source && !equal(await fileState(source), change.source)) throw new NexusError("SAVE_INPUT_INVALID", "Frozen source bytes changed before publish.");
          await this.publish(plan, change, source, change.before);
          await this.checkpoint?.(`after_write:${change.targetPath}`);
          await this.verifyState(plan, change, change.source);
        }
        record.state = "applied";
        await this.writeRecord(record);
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
        record.state = "recovery_required";
        await this.writeRecord(record);
        try { await this.restoreInternal(plan, record, true); }
        catch (recoveryError) {
          record.state = "recovery_required";
          await this.writeRecord(record);
          throw new NexusError("SAVE_ROLLBACK_FAILED", "Import failed and recovery needs attention; use restore_save_import with this planId.", { cause: recoveryError, details: { planId, error: record.error } });
        }
        throw new NexusError("APPLY_FAILED", "Import failed; affected files were rolled back.", { cause: error, details: { planId, reason: record.error } });
      }
      return await this.get(planId);
    });
  }

  async restore(planId: string) {
    return await this.locked(planId, async () => {
      const plan = await this.readPlan(planId);
      const record = await this.readRecord(planId);
      if (!record) throw new NexusError("NOT_FOUND", "This plan has no import operation to restore.");
      if (record.state === "restored" || record.state === "rolled_back") return await this.get(planId);
      await this.restoreInternal(plan, record, false);
      return await this.get(planId);
    });
  }

  private async restoreInternal(plan: Plan, record: RecordState, automatic: boolean) {
    await this.guard(plan);
    const changes = plan.changes.filter((change) => record.touched.includes(change.targetPath));
    // Capture changed post-import files before restoring, including game-created
    // changes. Later files outside the exact original mapping remain untouched.
    for (const change of changes) {
      if (record.restored.includes(change.targetPath)) continue;
      const current = await fileState(this.target(plan, change.targetPath));
      if (Object.hasOwn(record.restoreExpected, change.targetPath)) {
        if (equal(current, change.before) || equal(current, record.restoreExpected[change.targetPath] ?? null)) continue;
        if (automatic) throw new NexusError("SAVE_TARGET_DRIFTED", "Automatic recovery snapshot changed.");
        record.rescueHistory.push({ targetPath: change.targetPath, backupId: record.rescue[change.targetPath] ?? null, state: record.restoreExpected[change.targetPath] ?? null });
      }
      if (automatic && !equal(current, change.before) && !equal(current, change.source)) throw new NexusError("SAVE_TARGET_DRIFTED", "Automatic rollback will not overwrite a concurrent external change.");
      if (change.before) {
        const backupId = record.backups[change.targetPath];
        if (!backupId) throw new NexusError("SAVE_BACKUP_INVALID", "Original backup is missing.");
        const backup = await this.backups.get(backupId);
        if (!equal({ bytes: backup.bytes, sha256: backup.sha256 }, change.before)) throw new NexusError("SAVE_BACKUP_INVALID", "Original backup mismatch.");
      }
      const rescue = current ? await this.backups.backupFile(this.target(plan, change.targetPath)) : null;
      if (rescue && !equal({ bytes: rescue.bytes, sha256: rescue.sha256 }, current)) throw new NexusError("SAVE_RESCUE_BACKUP_FAILED", "Restore rescue changed while copying.");
      record.rescue[change.targetPath] = rescue?.backupId ?? null;
      record.restoreExpected[change.targetPath] = current;
      await this.writeRecord(record);
    }
    record.state = "restoring";
    await this.writeRecord(record);
    for (const change of [...changes].reverse()) {
      if (record.restored.includes(change.targetPath)) continue;
      await this.guard(plan);
      const current = await fileState(this.target(plan, change.targetPath));
      const expected = record.restoreExpected[change.targetPath] ?? null;
      // These exact temporary paths were absent before apply and are owned by
      // its write-ahead intent. Preserve even partial bytes outside the live
      // root before removing them; recovery can itself resume after a crash.
      for (const phase of ["import", "restore"]) {
        const temporary = `${this.target(plan, change.targetPath)}.${plan.planId}.save-${phase}-tmp`;
        const tempState = await fileState(temporary);
        if (!tempState) continue;
        const saved = await this.backups.backupFile(temporary);
        if (!equal({ bytes: saved.bytes, sha256: saved.sha256 }, tempState)) throw new NexusError("SAVE_RESCUE_BACKUP_FAILED", "Recovery artifact changed while preserving it.");
        record.artifacts.push({ path: temporary, backupId: saved.backupId });
        await this.writeRecord(record);
        if (!equal(await fileState(temporary), tempState)) throw new NexusError("SAVE_TARGET_DRIFTED", "Recovery staging file changed externally.");
        await unlink(temporary);
      }
      if (!equal(current, change.before)) {
        if (!equal(current, expected)) throw new NexusError("SAVE_TARGET_DRIFTED", "Target changed after recovery snapshot; preserve it before recovery can continue.");
        const backupId = record.backups[change.targetPath];
        const source = backupId ? (await this.backups.get(backupId)).absolutePath : null;
        await this.publish(plan, change, source, expected, true);
      }
      await this.verifyState(plan, change, change.before);
      await this.checkpoint?.(`restore_written:${change.targetPath}`);
      record.restored.push(change.targetPath);
      await this.writeRecord(record);
      await this.checkpoint?.(`after_restore:${change.targetPath}`);
    }
    record.state = automatic ? "rolled_back" : "restored";
    await this.writeRecord(record);
  }
}
