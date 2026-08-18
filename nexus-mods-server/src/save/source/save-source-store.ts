import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import {
  hashWithoutField,
  type SaveDownloadReceipt,
  saveDownloadReceiptSchema,
  type SaveSourceCandidate,
  saveSourceCandidateSchema,
  type SaveSourceSnapshot,
  saveSourceSnapshotSchema,
} from "../contracts.js";
import {
  assertUuid,
  ensureRealStoreDirectory,
  publishJsonExclusive,
  readStoredJson,
} from "../storage/json-store.js";

export class SaveSourceStore {
  readonly #snapshotsRoot: string;
  readonly #candidatesRoot: string;
  readonly #receiptsRoot: string;

  private constructor(input: {
    snapshotsRoot: string;
    candidatesRoot: string;
    receiptsRoot: string;
  }) {
    this.#snapshotsRoot = input.snapshotsRoot;
    this.#candidatesRoot = input.candidatesRoot;
    this.#receiptsRoot = input.receiptsRoot;
  }

  static async create(managerRoot: string): Promise<SaveSourceStore> {
    const [snapshotsRoot, candidatesRoot, receiptsRoot] = await Promise.all([
      ensureRealStoreDirectory(managerRoot, "source-snapshots"),
      ensureRealStoreDirectory(managerRoot, "source-candidates"),
      ensureRealStoreDirectory(managerRoot, "download-receipts"),
    ]);
    return new SaveSourceStore({ snapshotsRoot, candidatesRoot, receiptsRoot });
  }

  async saveResearch(input: {
    snapshot: SaveSourceSnapshot;
    candidates: ReadonlyArray<SaveSourceCandidate>;
  }): Promise<{
    snapshot: Readonly<SaveSourceSnapshot>;
    candidates: ReadonlyArray<Readonly<SaveSourceCandidate>>;
  }> {
    const snapshot = saveSourceSnapshotSchema.parse(input.snapshot);
    const candidates = input.candidates.map((candidate) =>
      saveSourceCandidateSchema.parse(candidate),
    );
    if (
      candidates.some(
        (candidate) =>
          candidate.snapshotId !== snapshot.snapshotId ||
          candidate.source !== snapshot.source ||
          candidate.game.canonicalId !== snapshot.game.canonicalId,
      ) ||
      snapshot.candidateIds.length !== candidates.length ||
      snapshot.candidateIds.some(
        (candidateId, index) => candidateId !== candidates[index]?.candidateId,
      )
    ) {
      throw new NexusError(
        "SAVE_CONTRACT_INVALID",
        "Save source candidates do not match their immutable snapshot.",
      );
    }
    this.#verifySnapshot(snapshot);
    for (const candidate of candidates) this.#verifyCandidate(candidate);
    for (const candidate of candidates) {
      await publishJsonExclusive(this.#candidatePath(candidate.candidateId), candidate);
    }
    await publishJsonExclusive(this.#snapshotPath(snapshot.snapshotId), snapshot);
    return {
      snapshot: Object.freeze(snapshot),
      candidates: candidates.map((candidate) => Object.freeze(candidate)),
    };
  }

  async getSnapshot(snapshotId: string): Promise<Readonly<SaveSourceSnapshot>> {
    assertUuid(snapshotId, "snapshotId");
    const snapshot = await readStoredJson(
      this.#snapshotPath(snapshotId),
      saveSourceSnapshotSchema,
      "Save Source Snapshot was not found.",
    );
    this.#verifySnapshot(snapshot);
    return Object.freeze(snapshot);
  }

  async getCandidate(candidateId: string): Promise<Readonly<SaveSourceCandidate>> {
    assertUuid(candidateId, "candidateId");
    const candidate = await readStoredJson(
      this.#candidatePath(candidateId),
      saveSourceCandidateSchema,
      "Save Source Candidate was not found.",
    );
    this.#verifyCandidate(candidate);
    await this.getSnapshot(candidate.snapshotId);
    return Object.freeze(candidate);
  }

  async getCandidates(snapshotId: string): Promise<ReadonlyArray<Readonly<SaveSourceCandidate>>> {
    const snapshot = await this.getSnapshot(snapshotId);
    return await Promise.all(
      snapshot.candidateIds.map(async (candidateId) => await this.getCandidate(candidateId)),
    );
  }

  async findLatestSnapshot(input: {
    source: SaveSourceSnapshot["source"];
    gameCanonicalId: string;
    pageUrl: string;
    query: string | null;
  }): Promise<Readonly<SaveSourceSnapshot> | null> {
    const files = await readdir(this.#snapshotsRoot);
    const snapshots: Array<{ snapshot: SaveSourceSnapshot; modifiedAtMs: number }> = [];
    for (const file of files.filter((value) => value.endsWith(".json"))) {
      const snapshot = await readStoredJson(
        path.join(this.#snapshotsRoot, file),
        saveSourceSnapshotSchema,
        "Save Source Snapshot was not found.",
      );
      this.#verifySnapshot(snapshot);
      if (
        snapshot.source === input.source &&
        snapshot.game.canonicalId === input.gameCanonicalId &&
        snapshot.pageUrl === input.pageUrl &&
        snapshot.query === input.query
      ) {
        snapshots.push({
          snapshot,
          modifiedAtMs: (await stat(path.join(this.#snapshotsRoot, file))).mtimeMs,
        });
      }
    }
    snapshots.sort((left, right) =>
      right.snapshot.fetchedAt.localeCompare(left.snapshot.fetchedAt) ||
      right.modifiedAtMs - left.modifiedAtMs ||
      right.snapshot.snapshotId.localeCompare(left.snapshot.snapshotId),
    );
    return snapshots[0] ? Object.freeze(snapshots[0].snapshot) : null;
  }

  async saveReceipt(receipt: SaveDownloadReceipt): Promise<Readonly<SaveDownloadReceipt>> {
    const parsed = saveDownloadReceiptSchema.parse(receipt);
    if (hashWithoutField(parsed, "receiptHash") !== parsed.receiptHash) {
      throw new NexusError("SAVE_CONTRACT_INVALID", "Save Download Receipt hash failed.");
    }
    const [candidate, snapshot] = await Promise.all([
      this.getCandidate(parsed.candidateId),
      this.getSnapshot(parsed.sourceSnapshotId),
    ]);
    if (
      candidate.candidateHash !== parsed.candidateHash ||
      snapshot.snapshotHash !== parsed.sourceSnapshotHash ||
      candidate.snapshotId !== snapshot.snapshotId ||
      candidate.source !== parsed.source
    ) {
      throw new NexusError(
        "SAVE_SOURCE_UNAVAILABLE",
        "Download provenance no longer matches the frozen source selection.",
      );
    }
    await publishJsonExclusive(this.#receiptPath(parsed.receiptId), parsed);
    return Object.freeze(parsed);
  }

  async getReceipt(receiptId: string): Promise<Readonly<SaveDownloadReceipt>> {
    assertUuid(receiptId, "receiptId");
    const receipt = await readStoredJson(
      this.#receiptPath(receiptId),
      saveDownloadReceiptSchema,
      "Save Download Receipt was not found.",
    );
    if (hashWithoutField(receipt, "receiptHash") !== receipt.receiptHash) {
      throw new NexusError("SAVE_SOURCE_UNAVAILABLE", "Save Download Receipt hash failed.");
    }
    return Object.freeze(receipt);
  }

  #verifySnapshot(snapshot: SaveSourceSnapshot): void {
    if (hashWithoutField(snapshot, "snapshotHash") !== snapshot.snapshotHash) {
      throw new NexusError("SAVE_SOURCE_UNAVAILABLE", "Save Source Snapshot hash failed.");
    }
  }

  #verifyCandidate(candidate: SaveSourceCandidate): void {
    if (hashWithoutField(candidate, "candidateHash") !== candidate.candidateHash) {
      throw new NexusError("SAVE_SOURCE_UNAVAILABLE", "Save Source Candidate hash failed.");
    }
  }

  #snapshotPath(snapshotId: string): string {
    return path.join(this.#snapshotsRoot, `${snapshotId}.json`);
  }

  #candidatePath(candidateId: string): string {
    return path.join(this.#candidatesRoot, `${candidateId}.json`);
  }

  #receiptPath(receiptId: string): string {
    return path.join(this.#receiptsRoot, `${receiptId}.json`);
  }
}
