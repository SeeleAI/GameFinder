import { access } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import {
  type SaveLocationProbe,
  hashWithoutField,
  saveLocationProbeSchema,
} from "../contracts.js";
import {
  assertUuid,
  ensureRealStoreDirectory,
  publishJsonExclusive,
  readStoredJson,
} from "./json-store.js";

export class SaveProbeStore {
  readonly #pendingRoot: string;
  readonly #completedRoot: string;

  private constructor(pendingRoot: string, completedRoot: string) {
    this.#pendingRoot = pendingRoot;
    this.#completedRoot = completedRoot;
  }

  static async create(managerRoot: string): Promise<SaveProbeStore> {
    const [pendingRoot, completedRoot] = await Promise.all([
      ensureRealStoreDirectory(managerRoot, "probes", "pending"),
      ensureRealStoreDirectory(managerRoot, "probes", "completed"),
    ]);
    return new SaveProbeStore(pendingRoot, completedRoot);
  }

  async saveStarted(
    probe: SaveLocationProbe,
  ): Promise<Readonly<SaveLocationProbe>> {
    const parsed = saveLocationProbeSchema.parse(probe);
    if (parsed.status !== "pending") {
      throw new NexusError(
        "SAVE_CONTRACT_INVALID",
        "A started Save Location Probe must be pending.",
      );
    }
    this.#verify(parsed);
    await publishJsonExclusive(this.#pendingPath(parsed.probeId), parsed);
    return Object.freeze(parsed);
  }

  async saveCompleted(
    probe: SaveLocationProbe,
  ): Promise<Readonly<SaveLocationProbe>> {
    const parsed = saveLocationProbeSchema.parse(probe);
    if (parsed.status !== "completed") {
      throw new NexusError(
        "SAVE_CONTRACT_INVALID",
        "A completed Save Location Probe must be terminal.",
      );
    }
    this.#verify(parsed);
    await publishJsonExclusive(this.#completedPath(parsed.probeId), parsed);
    return Object.freeze(parsed);
  }

  async get(probeId: string): Promise<Readonly<SaveLocationProbe>> {
    assertUuid(probeId, "probeId");
    const completedPath = this.#completedPath(probeId);
    const isCompleted = await access(completedPath)
      .then(() => true)
      .catch(() => false);
    const parsed = await readStoredJson(
      isCompleted ? completedPath : this.#pendingPath(probeId),
      saveLocationProbeSchema,
      "Save Location Probe was not found.",
    );
    if (parsed.probeId !== probeId) {
      throw new NexusError(
        "SAVE_CONTEXT_STALE",
        "Save Location Probe identity does not match its storage key.",
        { details: { probeId } },
      );
    }
    this.#verify(parsed);
    return Object.freeze(parsed);
  }

  #verify(probe: SaveLocationProbe): void {
    const actualHash = hashWithoutField(probe, "probeHash");
    if (actualHash !== probe.probeHash) {
      throw new NexusError(
        "SAVE_CONTEXT_STALE",
        "Save Location Probe hash verification failed.",
        {
          details: {
            probeId: probe.probeId,
            expectedHash: probe.probeHash,
            actualHash,
          },
        },
      );
    }
  }

  #pendingPath(probeId: string): string {
    return path.join(this.#pendingRoot, `${probeId}.json`);
  }

  #completedPath(probeId: string): string {
    return path.join(this.#completedRoot, `${probeId}.json`);
  }
}
