import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";

import { NexusError } from "../../errors.js";
import { pathStateSchema } from "../contracts.js";
import { scopedPathSchema } from "./contracts.js";

const journalSchema = z.object({
  schemaVersion: z.literal(2),
  planId: z.string().uuid(),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  transactionId: z.string().uuid(),
  phase: z.enum([
    "preflight",
    "backed_up",
    "process_started",
    "process_finished",
    "rolled_back",
    "committed",
    "recovery_required",
  ]),
  captures: z.array(
    z.object({
      root: scopedPathSchema,
      absolutePath: z.string().min(3).max(32_768),
      preState: pathStateSchema,
      backupId: z.string().uuid().nullable(),
    }),
  ).max(100),
  process: z.object({
    exitCode: z.number().int().nullable(),
    signal: z.string().max(100).nullable(),
    timedOut: z.boolean(),
    stdout: z.string().max(65_536),
    stderr: z.string().max(65_536),
  }),
  observedChanges: z.array(z.string().min(1).max(1_024)).max(200_000),
  unexpectedChanges: z.array(z.string().min(1).max(1_024)).max(200_000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ControlledInstallerJournal = z.infer<typeof journalSchema>;

export class ControlledInstallerJournalStore {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  static async create(
    managerRoot: string,
  ): Promise<ControlledInstallerJournalStore> {
    const root = path.join(path.resolve(managerRoot), "installer-journals-v2");
    await mkdir(root, { recursive: true });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new NexusError(
        "PROTECTED_PATH",
        "Controlled installer journals require a real manager directory.",
      );
    }
    return new ControlledInstallerJournalStore(root);
  }

  async get(planId: string): Promise<ControlledInstallerJournal | null> {
    try {
      return journalSchema.parse(
        JSON.parse(await readFile(this.#path(planId), "utf8")) as unknown,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw new NexusError(
        "RECOVERY_REQUIRED",
        "Controlled installer journal is unreadable or corrupt.",
        { cause: error, details: { planId } },
      );
    }
  }

  async save(
    journal: ControlledInstallerJournal,
    options: { create?: boolean } = {},
  ): Promise<ControlledInstallerJournal> {
    const parsed = journalSchema.parse(journal);
    const target = this.#path(parsed.planId);
    if (options.create) {
      await writeFile(target, `${JSON.stringify(parsed, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      }).catch((error: unknown) => {
        throw new NexusError(
          "RECOVERY_REQUIRED",
          "A prior controlled-installer transaction requires recovery before this plan can run again.",
          { cause: error, details: { planId: parsed.planId } },
        );
      });
      return parsed;
    }
    const temporary = `${target}.${parsed.transactionId}.tmp`;
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, target);
    return parsed;
  }

  #path(planId: string): string {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        planId,
      )
    ) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "planId must be a UUID.",
      );
    }
    return path.join(this.#root, `${planId}.json`);
  }
}
