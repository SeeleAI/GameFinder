import { randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import type { SaveTransactionRecord } from "../contracts.js";
import { saveTransactionRecordSchema } from "../contracts.js";
import {
  assertUuid,
  ensureRealStoreDirectory,
  publishJsonExclusive,
  readStoredJson,
} from "../storage/json-store.js";

interface JournalHeader {
  kind: "header";
  schemaVersion: 1;
  transactionId: string;
  planKind: "restore" | "replacement";
  planId: string;
  planHash: string;
  startedAt: string;
}

interface JournalEventLine {
  kind: "event";
  event: SaveTransactionRecord["events"][number];
}

type JournalLine = JournalHeader | JournalEventLine;

async function appendDurably(filePath: string, value: JournalLine): Promise<void> {
  const handle = await open(filePath, "a");
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class SaveTransactionWriter {
  readonly #store: SaveTransactionStore;
  readonly header: JournalHeader;
  #nextSequence = 0;

  constructor(store: SaveTransactionStore, header: JournalHeader) {
    this.#store = store;
    this.header = header;
  }

  get transactionId(): string {
    return this.header.transactionId;
  }

  async append(
    phase: SaveTransactionRecord["events"][number]["phase"],
    message: string,
  ): Promise<void> {
    const event = {
      sequence: this.#nextSequence,
      phase,
      message,
      observedAt: new Date().toISOString(),
    };
    await this.#store.append(this.transactionId, { kind: "event", event });
    this.#nextSequence += 1;
  }

  async finalize(input: {
    state: SaveTransactionRecord["state"];
    rescueBackupId: string | null;
  }): Promise<Readonly<SaveTransactionRecord>> {
    const journal = await this.#store.readJournal(this.transactionId);
    const withoutHash = {
      schemaVersion: 1 as const,
      transactionId: this.transactionId,
      planKind: this.header.planKind,
      planId: this.header.planId,
      planHash: this.header.planHash,
      rescueBackupId: input.rescueBackupId,
      state: input.state,
      events: journal.events,
      startedAt: this.header.startedAt,
      completedAt: new Date().toISOString(),
    };
    return await this.#store.saveRecord(
      saveTransactionRecordSchema.parse({
        ...withoutHash,
        transactionHash: sha256CanonicalJson(withoutHash),
      }),
    );
  }
}

export class SaveTransactionStore {
  readonly #journalsRoot: string;
  readonly #recordsRoot: string;

  private constructor(journalsRoot: string, recordsRoot: string) {
    this.#journalsRoot = journalsRoot;
    this.#recordsRoot = recordsRoot;
  }

  static async create(managerRoot: string): Promise<SaveTransactionStore> {
    const [journalsRoot, recordsRoot] = await Promise.all([
      ensureRealStoreDirectory(managerRoot, "transactions", "journals"),
      ensureRealStoreDirectory(managerRoot, "transactions", "records"),
    ]);
    return new SaveTransactionStore(journalsRoot, recordsRoot);
  }

  async create(input: {
    planKind: "restore" | "replacement";
    planId: string;
    planHash: string;
  }): Promise<SaveTransactionWriter> {
    assertUuid(input.planId, "planId");
    const header: JournalHeader = {
      kind: "header",
      schemaVersion: 1,
      transactionId: randomUUID(),
      planKind: input.planKind,
      planId: input.planId,
      planHash: input.planHash,
      startedAt: new Date().toISOString(),
    };
    const handle = await open(this.#journalPath(header.transactionId), "wx");
    try {
      await handle.writeFile(`${JSON.stringify(header)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return new SaveTransactionWriter(this, header);
  }

  async append(transactionId: string, line: JournalEventLine): Promise<void> {
    assertUuid(transactionId, "transactionId");
    await appendDurably(this.#journalPath(transactionId), line);
  }

  async readJournal(transactionId: string): Promise<{
    header: JournalHeader;
    events: SaveTransactionRecord["events"];
  }> {
    assertUuid(transactionId, "transactionId");
    const lines = (await readFile(this.#journalPath(transactionId), "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JournalLine);
    const header = lines[0];
    if (!header || header.kind !== "header" || header.transactionId !== transactionId) {
      throw new NexusError(
        "SAVE_ROLLBACK_FAILED",
        "Save transaction journal header is invalid.",
      );
    }
    const events = lines.slice(1).map((line, sequence) => {
      if (line.kind !== "event" || line.event.sequence !== sequence) {
        throw new NexusError(
          "SAVE_ROLLBACK_FAILED",
          "Save transaction journal sequence is invalid.",
        );
      }
      return line.event;
    });
    return { header, events };
  }

  async saveRecord(
    record: SaveTransactionRecord,
  ): Promise<Readonly<SaveTransactionRecord>> {
    await publishJsonExclusive(this.#recordPath(record.transactionId), record);
    return Object.freeze(record);
  }

  async getRecord(
    transactionId: string,
  ): Promise<Readonly<SaveTransactionRecord>> {
    assertUuid(transactionId, "transactionId");
    const record = await readStoredJson(
      this.#recordPath(transactionId),
      saveTransactionRecordSchema,
      "Save Transaction Record was not found.",
    );
    const { transactionHash: _hash, ...payload } = record;
    if (sha256CanonicalJson(payload) !== record.transactionHash) {
      throw new NexusError(
        "SAVE_ROLLBACK_FAILED",
        "Save Transaction Record hash verification failed.",
      );
    }
    return Object.freeze(record);
  }

  #journalPath(transactionId: string): string {
    return path.join(this.#journalsRoot, `${transactionId}.ndjson`);
  }

  #recordPath(transactionId: string): string {
    return path.join(this.#recordsRoot, `${transactionId}.json`);
  }
}
