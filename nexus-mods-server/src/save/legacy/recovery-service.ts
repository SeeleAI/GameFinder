import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import { sha256File } from "../../install/file-hash.js";
import { assertRealPath, relativeFile } from "../generic/input.js";
import { assertUuid } from "../storage/json-store.js";

// V2 used the V1 transaction bridge: both releases persisted these same file
// records. Read only the frozen fields needed for recovery, never game registries.
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const fileSchema = z.object({ relativePath: z.string(), backupObjectId: z.string().uuid(), bytes: z.number().int().nonnegative(), sha256: hash }).passthrough();
const backupSchema = z.object({ schemaVersion: z.literal(1), backupId: z.string().uuid(), sourceRoot: z.string(),
  files: z.array(fileSchema).min(1).max(10000), treeHash: hash, backupRecordHash: hash }).passthrough();
const stateSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("absent") }), z.object({ kind: z.literal("file"), bytes: z.number().int().nonnegative(), sha256: hash })]);
const planSchema = z.object({ schemaVersion: z.literal(1), target: z.object({ absolutePath: z.string() }).passthrough(),
  operations: z.array(z.object({ targetRelativePath: z.string(), expectedPreState: stateSchema, expectedPostState: stateSchema }).passthrough()).min(1).max(10000), planHash: hash }).passthrough();
const transactionSchema = z.object({ schemaVersion: z.literal(1), transactionId: z.string().uuid(), planId: z.string().uuid(),
  planKind: z.enum(["restore", "replacement"]), planHash: hash, rescueBackupId: z.string().uuid().nullable(),
  state: z.enum(["committed", "rolled-back", "failed", "recovery-required"]), transactionHash: hash }).passthrough();
const operationSchema = z.object({ schemaVersion: z.literal(1), recordId: z.string().uuid(), planId: z.string().uuid(),
  kind: z.enum(["restore", "replacement"]), transactionId: z.string().uuid(), recordHash: hash }).passthrough();
export const legacySaveRecoveryInputSchema = z.object({ recordId: z.string().uuid(), kind: z.enum(["backup", "operation", "transaction"]) });
type File = z.infer<typeof fileSchema>;

function fail(message: string, details?: Record<string, unknown>): never {
  throw new NexusError("SAVE_BACKUP_INVALID", message, details ? { details } : {});
}
function verifyHash(raw: Record<string, unknown>, field: string) {
  const { [field]: expected, ...body } = raw;
  if (sha256CanonicalJson(body) !== expected) fail(`Historical ${field} integrity verification failed.`);
}
function uniquePaths(paths: string[]) {
  const seen: string[] = [];
  for (const raw of paths) {
    const name = relativeFile(raw).toLowerCase();
    if (seen.some((p) => p === name || p.startsWith(`${name}/`) || name.startsWith(`${p}/`))) fail("Historical record contains overlapping or duplicate paths.");
    seen.push(name);
  }
}

/** Read/export compatibility only. No legacy plan can be resumed through here. */
export class LegacySaveRecoveryService {
  private constructor(readonly root: string) {}
  static async create(options: { managerRoot: string }) {
    if (!path.isAbsolute(options.managerRoot)) fail("Manager root must be absolute.");
    const root = path.join(options.managerRoot, "save-manager"); await assertRealPath(root);
    return new LegacySaveRecoveryService(root);
  }
  private async read<T>(segments: string[], schema: z.ZodType<T>, hashField: string): Promise<T> {
    const file = path.join(this.root, ...segments); await assertRealPath(file);
    let raw: unknown;
    try { raw = JSON.parse(await readFile(file, "utf8")); }
    catch (error) { fail("Required historical record is missing or unreadable; no paths or deletion scope were guessed.", { file, reason: String(error) }); }
    const value = schema.parse(raw);
    verifyHash(raw as Record<string, unknown>, hashField);
    return value;
  }
  private async backup(id: string) {
    assertUuid(id, "backupId");
    const record = await this.read(["backups", "records", `${id}.json`], backupSchema, "backupRecordHash");
    if (record.backupId !== id || !path.isAbsolute(record.sourceRoot)) fail("Historical backup identity or source root is invalid.");
    uniquePaths(record.files.map((file) => file.relativePath));
    if (sha256CanonicalJson(record.files.map(({ relativePath, bytes, sha256 }) => ({ relativePath, bytes, sha256 }))) !== record.treeHash) fail("Historical backup tree hash is invalid.");
    return record;
  }
  private async source(file: File): Promise<string> {
    assertUuid(file.backupObjectId, "backupObjectId");
    const referencePath = path.join(this.root, "backups", "references", `${file.backupObjectId}.json`); await assertRealPath(referencePath);
    const reference = z.object({ backupId: z.string().uuid(), objectKind: z.literal("file"), sha256: hash, bytes: z.number().int().nonnegative(), absolutePath: z.string() })
      .parse(JSON.parse(await readFile(referencePath, "utf8")));
    const canonical = path.join(this.root, "backups", "objects", "files", file.sha256.slice(0, 2), file.sha256);
    if (reference.backupId !== file.backupObjectId || reference.sha256 !== file.sha256 || reference.bytes !== file.bytes
      || path.resolve(reference.absolutePath).toLowerCase() !== canonical.toLowerCase()) fail("Historical backup reference is inconsistent or escapes its object store.");
    await assertRealPath(canonical); const stat = await lstat(canonical);
    if (!stat.isFile() || stat.size !== file.bytes || await sha256File(canonical) !== file.sha256) fail("Historical backup object is missing or corrupt.");
    return canonical;
  }
  private async state(root: string, relativePath: string) {
    const file = path.join(root, ...relativePath.split("/")); await assertRealPath(file);
    const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!stat) return { kind: "absent" as const };
    if (!stat.isFile()) fail("Historical target path is no longer a regular file.", { file });
    return { kind: "file" as const, bytes: stat.size, sha256: await sha256File(file) };
  }
  async prepare(raw: z.input<typeof legacySaveRecoveryInputSchema>) {
    const input = legacySaveRecoveryInputSchema.parse(raw);
    let targetRoot: string;
    let files: File[] = [];
    const deletePaths: string[] = [];
    if (input.kind === "backup") {
      const backup = await this.backup(input.recordId); targetRoot = backup.sourceRoot; files = backup.files;
    } else {
      let transactionId = input.recordId;
      let operation: z.infer<typeof operationSchema> | undefined;
      if (input.kind === "operation") {
        operation = await this.read(["records", `${input.recordId}.json`], operationSchema, "recordHash");
        if (operation.recordId !== input.recordId) fail("Historical operation identity is inconsistent.");
        transactionId = operation.transactionId;
      }
      const transaction = await this.read(["transactions", "records", `${transactionId}.json`], transactionSchema, "transactionHash");
      if (transaction.transactionId !== transactionId || (operation && (operation.planId !== transaction.planId || operation.kind !== transaction.planKind))) fail("Historical operation/transaction linkage is inconsistent.");
      if (transaction.state === "rolled-back" || transaction.state === "failed") fail("This historical transaction is not a committed or recoverable mutation; inspect its records before forming a new explicit import.");
      const plan = await this.read([`${transaction.planKind}-plans`, `${transaction.planId}.json`], planSchema, "planHash");
      if (plan.planHash !== transaction.planHash || plan[transaction.planKind === "restore" ? "restorePlanId" : "replacementPlanId"] !== transaction.planId) fail("Historical plan identity/hash is inconsistent.");
      targetRoot = plan.target.absolutePath;
      if (!path.isAbsolute(targetRoot)) fail("Historical target root is not absolute.");
      uniquePaths(plan.operations.map((item) => item.targetRelativePath));
      const backup = transaction.rescueBackupId ? await this.backup(transaction.rescueBackupId) : null;
      for (const item of plan.operations) {
        const name = relativeFile(item.targetRelativePath);
        if (transaction.state === "recovery-required") {
          const current = await this.state(targetRoot, name);
          if (sha256CanonicalJson(current) === sha256CanonicalJson(item.expectedPreState)) continue;
          if (sha256CanonicalJson(current) !== sha256CanonicalJson(item.expectedPostState) && current.kind !== "absent") {
            fail("Interrupted historical target has unrecognized bytes; reliable touched scope is unavailable.", { targetPath: name });
          }
        }
        if (item.expectedPreState.kind === "absent") { deletePaths.push(name); continue; }
        const file = backup?.files.find((entry) => relativeFile(entry.relativePath).toLowerCase() === name.toLowerCase());
        if (!file || file.bytes !== item.expectedPreState.bytes || file.sha256 !== item.expectedPreState.sha256) {
          fail("Historical rescue backup does not cover the frozen pre-operation state.", { targetPath: name, rescueBackupId: transaction.rescueBackupId });
        }
        files.push({ ...file, relativePath: name });
      }
    }
    await assertRealPath(targetRoot);
    if (files.length + deletePaths.length === 0) fail("Historical operation has no remaining changed files to recover.");
    // Verify every source before creating an export. Historical records and blobs
    // are never modified, including when a partial export fails.
    const sources = await Promise.all(files.map(async (file) => ({ file, source: await this.source(file) })));
    const inputPath = path.join(this.root, "legacy-exports", randomUUID()); await assertRealPath(inputPath); await mkdir(inputPath, { recursive: true });
    for (const { file, source } of sources) {
      const target = path.join(inputPath, ...relativeFile(file.relativePath).split("/"));
      await assertRealPath(source); await assertRealPath(target); await mkdir(path.dirname(target), { recursive: true }); await copyFile(source, target, constants.COPYFILE_EXCL);
      if ((await lstat(target)).size !== file.bytes || await sha256File(target) !== file.sha256) fail("Historical backup changed while exporting.");
    }
    return { recordId: input.recordId, kind: input.kind, inputPath, targetRoot,
      mappings: files.map((file) => ({ sourcePath: relativeFile(file.relativePath), targetPath: relativeFile(file.relativePath) })), deletePaths,
      deletionReason: deletePaths.length ? "Restore exact historical pre-operation absence recorded in the frozen operation plan." : undefined,
      files: files.map((file) => ({ relativePath: file.relativePath, bytes: file.bytes, sha256: file.sha256 })),
      description: `Verified historical ${input.kind} ${input.recordId}; create a new generic import plan before writing.`,
      oldPlanResumable: false as const };
  }
}
