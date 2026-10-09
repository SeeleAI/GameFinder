import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import { InstanceLock } from "../../install/core/instance-lock.js";
import { assertSensitiveProcessesStopped } from "../../install/core/process-guard.js";
import { sha256File } from "../../install/file-hash.js";
import { assertUuid, publishJsonExclusive } from "../storage/json-store.js";
import { assertRealPath, relativeFile } from "./input.js";

export const directSaveBackupInputSchema = z.object({
  sourceRoot: z.string().min(3), paths: z.array(z.string().min(1)).min(1).max(10000),
  processNames: z.array(z.string().regex(/^[^\\/:*?"<>|\x00-\x1f]+$/)).min(1).max(64),
  description: z.string().trim().min(1).max(4000),
});
const fileSchema = z.object({ relativePath: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const recordSchema = z.object({
  schemaVersion: z.literal(1), backupId: z.string().uuid(), createdAt: z.string(), sourceRoot: z.string(),
  processNames: directSaveBackupInputSchema.shape.processNames, description: z.string(), files: z.array(fileSchema).min(1).max(10000), recordHash: z.string(),
});

/** A backup is an immutable exact-file snapshot. It never infers a deletion scope. */
export class DirectSaveBackupService {
  private constructor(readonly root: string, private readonly locksRoot: string,
    private readonly guard: (names: ReadonlyArray<string>) => Promise<void>,
    private readonly checkpoint?: (name: string) => Promise<void>) {}

  static async create(options: { managerRoot: string; processGuard?: (names: ReadonlyArray<string>) => Promise<void>; checkpoint?: (name: string) => Promise<void> }) {
    if (!path.isAbsolute(options.managerRoot)) throw new NexusError("SAVE_PATH_INVALID", "Manager root must be absolute.");
    const root = path.join(options.managerRoot, "save-manager", "direct-backups");
    const locksRoot = path.join(options.managerRoot, "save-manager", "generic-imports", "locks");
    await assertRealPath(root); await assertRealPath(locksRoot);
    await mkdir(path.join(root, "records"), { recursive: true }); await mkdir(path.join(root, "files"), { recursive: true });
    return new DirectSaveBackupService(root, locksRoot, options.processGuard ?? assertSensitiveProcessesStopped, options.checkpoint);
  }

  private async snapshot(root: string, names: string[]) {
    const files = []; let total = 0;
    for (const relativePath of names) {
      const file = path.join(root, ...relativePath.split("/")); await assertRealPath(file);
      const stat = await lstat(file);
      if (!stat.isFile()) throw new NexusError("SAVE_BACKUP_INVALID", "Backup paths must name exact regular files.", { details: { relativePath } });
      total += stat.size;
      if (stat.size > 4 * 1024 ** 3 || total > 20 * 1024 ** 3) throw new NexusError("SAVE_BACKUP_INVALID", "Selected backup exceeds file size limits.");
      files.push({ relativePath, bytes: stat.size, sha256: await sha256File(file) });
    }
    return files;
  }

  async createBackup(raw: z.input<typeof directSaveBackupInputSchema>) {
    const input = directSaveBackupInputSchema.parse(raw); await assertRealPath(input.sourceRoot);
    if (!(await lstat(input.sourceRoot)).isDirectory()) throw new NexusError("SAVE_PATH_INVALID", "Backup source root must be a directory.");
    const names = input.paths.map(relativeFile).sort();
    if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) throw new NexusError("SAVE_PATH_INVALID", "Duplicate backup paths are not allowed.");
    const backupId = randomUUID();
    const lock = new InstanceLock({ locksRoot: this.locksRoot, instanceId: "9067b2dd-a884-4d0a-bef1-aea38b6ed333", transactionId: backupId });
    await lock.acquire();
    try {
      await this.guard(input.processNames);
      const before = await this.snapshot(input.sourceRoot, names); await this.checkpoint?.("after_snapshot");
      const destination = path.join(this.root, "files", backupId); await assertRealPath(destination); await mkdir(destination);
      for (const file of before) {
        const source = path.join(input.sourceRoot, ...file.relativePath.split("/"));
        const target = path.join(destination, ...file.relativePath.split("/"));
        await assertRealPath(source); await assertRealPath(target); await mkdir(path.dirname(target), { recursive: true });
        await copyFile(source, target, constants.COPYFILE_EXCL);
      }
      const copied = await this.snapshot(destination, names);
      await this.guard(input.processNames);
      const after = await this.snapshot(input.sourceRoot, names);
      if (sha256CanonicalJson(before) !== sha256CanonicalJson(copied) || sha256CanonicalJson(before) !== sha256CanonicalJson(after)) {
        throw new NexusError("SAVE_SOURCE_CHANGED_DURING_BACKUP", "Source changed during backup; no backup record was published.");
      }
      const body = { schemaVersion: 1 as const, backupId, createdAt: new Date().toISOString(), sourceRoot: path.resolve(input.sourceRoot),
        processNames: input.processNames, description: input.description, files: before };
      await assertRealPath(path.join(this.root, "records"));
      await publishJsonExclusive(path.join(this.root, "records", `${backupId}.json`), { ...body, recordHash: sha256CanonicalJson(body) });
      return await this.get(backupId);
    } finally { await lock.release(); }
  }

  async get(backupId: string) {
    assertUuid(backupId, "backupId"); const recordPath = path.join(this.root, "records", `${backupId}.json`); await assertRealPath(recordPath);
    const record = recordSchema.parse(JSON.parse(await readFile(recordPath, "utf8")));
    const { recordHash, ...body } = record;
    if (record.backupId !== backupId || sha256CanonicalJson(body) !== recordHash) throw new NexusError("SAVE_BACKUP_INVALID", "Backup record identity or hash is invalid.");
    const names = record.files.map((file) => relativeFile(file.relativePath));
    if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) throw new NexusError("SAVE_BACKUP_INVALID", "Backup file paths collide.");
    const backupRoot = path.join(this.root, "files", backupId);
    const actual = await this.snapshot(backupRoot, names);
    if (sha256CanonicalJson(actual) !== sha256CanonicalJson(record.files)) throw new NexusError("SAVE_BACKUP_INVALID", "Backup files failed integrity verification.");
    return { ...record, backupRoot, integrity: "verified" as const,
      files: record.files.map((file) => ({ ...file, absolutePath: path.join(backupRoot, ...file.relativePath.split("/")) })) };
  }

  async prepareRestore(input: { backupId: string; targetRoot?: string; processNames?: string[] }) {
    const record = await this.get(input.backupId);
    return { inputPath: record.backupRoot, targetRoot: input.targetRoot ?? record.sourceRoot,
      mappings: record.files.map((file) => ({ sourcePath: file.relativePath, targetPath: file.relativePath })), deletePaths: [] as string[],
      processNames: input.processNames ?? record.processNames, description: `Restore verified backup ${record.backupId}: ${record.description}` };
  }
}
