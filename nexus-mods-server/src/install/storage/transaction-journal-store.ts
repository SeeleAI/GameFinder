import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import type {
  TransactionEntry,
  TransactionJournal,
  TransactionPhase,
} from "../contracts.js";
import {
  transactionEntrySchema,
  transactionJournalSchema,
} from "../contracts.js";

interface JournalHeaderLine {
  kind: "header";
  schemaVersion: 1;
  transactionId: string;
  transactionKind: TransactionJournal["transactionKind"];
  planId: string;
  gameInstanceId: string;
  startedAt: string;
}

interface JournalEntryLine {
  kind: "entry";
  entry: TransactionEntry;
}

interface JournalStateLine {
  kind: "state";
  state: TransactionPhase;
  completedAt: string | null;
  recordedAt: string;
}

type JournalLine = JournalHeaderLine | JournalEntryLine | JournalStateLine;

const TERMINAL_STATES = new Set<TransactionPhase>([
  "committed",
  "preflight_failed",
  "rolled_back",
  "recovery_required",
  "uninstalled",
  "installed_restored",
]);

async function appendDurably(filePath: string, value: JournalLine): Promise<void> {
  const handle = await open(filePath, "a");
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertTransactionId(transactionId: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      transactionId,
    )
  ) {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      "transactionId must be a UUID.",
    );
  }
}

export class TransactionJournalWriter {
  readonly #store: TransactionJournalStore;
  readonly transactionId: string;
  #nextSequence: number;

  constructor(
    store: TransactionJournalStore,
    transactionId: string,
    nextSequence: number,
  ) {
    this.#store = store;
    this.transactionId = transactionId;
    this.#nextSequence = nextSequence;
  }

  async append(
    entry: Omit<TransactionEntry, "sequence" | "recordedAt"> & {
      recordedAt?: string;
    },
  ): Promise<TransactionEntry> {
    const parsed = transactionEntrySchema.parse({
      ...entry,
      sequence: this.#nextSequence,
      recordedAt: entry.recordedAt ?? new Date().toISOString(),
    });
    await this.#store.appendLine(this.transactionId, {
      kind: "entry",
      entry: parsed,
    });
    this.#nextSequence += 1;
    return parsed;
  }

  async setState(
    state: TransactionPhase,
    options: { completed?: boolean } = {},
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.#store.appendLine(this.transactionId, {
      kind: "state",
      state,
      completedAt: options.completed ? now : null,
      recordedAt: now,
    });
  }

  async snapshot(): Promise<TransactionJournal> {
    return await this.#store.read(this.transactionId);
  }
}

export class TransactionJournalStore {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  static async create(managerRoot: string): Promise<TransactionJournalStore> {
    if (!path.isAbsolute(managerRoot)) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Transaction managerRoot must be absolute.",
      );
    }
    const root = path.join(path.resolve(managerRoot), "transactions");
    await mkdir(root, { recursive: true });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new NexusError(
        "PROTECTED_PATH",
        "Transaction Journal Store must be a real directory.",
        { details: { root } },
      );
    }
    return new TransactionJournalStore(root);
  }

  async createJournal(input: {
    transactionKind: TransactionJournal["transactionKind"];
    planId: string;
    gameInstanceId: string;
    transactionId?: string;
  }): Promise<TransactionJournalWriter> {
    const transactionId = input.transactionId ?? randomUUID();
    assertTransactionId(transactionId);
    const header: JournalHeaderLine = {
      kind: "header",
      schemaVersion: 1,
      transactionId,
      transactionKind: input.transactionKind,
      planId: input.planId,
      gameInstanceId: input.gameInstanceId,
      startedAt: new Date().toISOString(),
    };
    const handle = await open(this.#pathFor(transactionId), "wx");
    try {
      await handle.writeFile(`${JSON.stringify(header)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return new TransactionJournalWriter(this, transactionId, 0);
  }

  async openJournal(transactionId: string): Promise<TransactionJournalWriter> {
    const journal = await this.read(transactionId);
    const nextSequence =
      journal.entries.reduce(
        (highest, entry) => Math.max(highest, entry.sequence),
        -1,
      ) + 1;
    return new TransactionJournalWriter(this, transactionId, nextSequence);
  }

  async findLatestByPlan(
    planId: string,
  ): Promise<TransactionJournal | null> {
    const matches: TransactionJournal[] = [];
    for (const name of await readdir(this.#root)) {
      const match = /^([0-9a-f-]{36})\.ndjson$/i.exec(name);
      if (!match?.[1]) continue;
      let header: Partial<JournalHeaderLine>;
      try {
        const firstLine = (
          await readFile(path.join(this.#root, name), "utf8")
        ).split(/\r?\n/, 1)[0];
        if (!firstLine) continue;
        header = JSON.parse(firstLine) as Partial<JournalHeaderLine>;
      } catch {
        // A journal without a readable header cannot be associated with this
        // Plan. Exact transaction reads still surface its corruption.
        continue;
      }
      if (
        header.kind !== "header" ||
        header.planId !== planId ||
        header.transactionId !== match[1]
      ) {
        continue;
      }
      matches.push(await this.read(match[1]));
    }
    return (
      matches.sort((left, right) =>
        right.startedAt.localeCompare(left.startedAt),
      )[0] ?? null
    );
  }

  async read(transactionId: string): Promise<TransactionJournal> {
    assertTransactionId(transactionId);
    let text: string;
    try {
      text = await readFile(this.#pathFor(transactionId), "utf8");
    } catch (error) {
      throw new NexusError(
        "NOT_FOUND",
        "Transaction journal was not found.",
        { cause: error, details: { transactionId } },
      );
    }
    const rawLines = text.split(/\r?\n/).filter((line) => line.length > 0);
    if (rawLines.length === 0) {
      throw new NexusError(
        "RECOVERY_REQUIRED",
        "Transaction journal is empty.",
        { details: { transactionId } },
      );
    }
    let lines: JournalLine[];
    try {
      lines = rawLines.map((line) => JSON.parse(line) as JournalLine);
    } catch (error) {
      throw new NexusError(
        "RECOVERY_REQUIRED",
        "Transaction journal contains a partial or invalid line.",
        { cause: error, details: { transactionId } },
      );
    }
    const header = lines[0];
    if (!header || header.kind !== "header" || header.transactionId !== transactionId) {
      throw new NexusError(
        "RECOVERY_REQUIRED",
        "Transaction journal header is invalid.",
        { details: { transactionId } },
      );
    }
    const entries: TransactionEntry[] = [];
    let state: TransactionPhase = "planned";
    let completedAt: string | null = null;
    for (const line of lines.slice(1)) {
      if (line.kind === "entry") {
        const entry = transactionEntrySchema.parse(line.entry);
        if (entry.sequence !== entries.length) {
          throw new NexusError(
            "RECOVERY_REQUIRED",
            "Transaction journal sequence is discontinuous.",
            {
              details: {
                transactionId,
                expectedSequence: entries.length,
                actualSequence: entry.sequence,
              },
            },
          );
        }
        entries.push(entry);
      } else if (line.kind === "state") {
        state = line.state;
        completedAt = line.completedAt;
      } else {
        throw new NexusError(
          "RECOVERY_REQUIRED",
          "Transaction journal contains an unexpected header line.",
          { details: { transactionId } },
        );
      }
    }
    return transactionJournalSchema.parse({
      schemaVersion: 1,
      transactionId: header.transactionId,
      transactionKind: header.transactionKind,
      planId: header.planId,
      gameInstanceId: header.gameInstanceId,
      state,
      startedAt: header.startedAt,
      completedAt,
      entries,
    });
  }

  async listIncomplete(): Promise<ReadonlyArray<TransactionJournal>> {
    const names = await readdir(this.#root);
    const journals: TransactionJournal[] = [];
    for (const name of names.filter((value) => value.endsWith(".ndjson"))) {
      const transactionId = name.slice(0, -".ndjson".length);
      const journal = await this.read(transactionId);
      if (!TERMINAL_STATES.has(journal.state)) journals.push(journal);
    }
    return journals.sort((left, right) =>
      left.startedAt.localeCompare(right.startedAt),
    );
  }

  async appendLine(transactionId: string, line: JournalLine): Promise<void> {
    assertTransactionId(transactionId);
    await appendDurably(this.#pathFor(transactionId), line);
  }

  #pathFor(transactionId: string): string {
    return path.join(this.#root, `${transactionId}.ndjson`);
  }
}
