import { readdir } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import {
  type LearnedSaveProfile,
  hashWithoutField,
  learnedSaveProfileSchema,
} from "../contracts.js";
import {
  ensureRealStoreDirectory,
  publishJsonExclusive,
  readStoredJson,
} from "./json-store.js";

export class LearnedSaveProfileStore {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  static async create(managerRoot: string): Promise<LearnedSaveProfileStore> {
    return new LearnedSaveProfileStore(
      await ensureRealStoreDirectory(managerRoot, "learned-profiles"),
    );
  }

  async save(
    profile: LearnedSaveProfile,
  ): Promise<Readonly<LearnedSaveProfile>> {
    const parsed = learnedSaveProfileSchema.parse(profile);
    this.#verify(parsed);
    await publishJsonExclusive(
      path.join(this.#root, `${parsed.learnedProfileId}.json`),
      parsed,
    );
    return Object.freeze(parsed);
  }

  async listForGame(
    gameCanonicalId: string,
  ): Promise<ReadonlyArray<Readonly<LearnedSaveProfile>>> {
    const names = (await readdir(this.#root))
      .filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
      .sort();
    const profiles: LearnedSaveProfile[] = [];
    for (const name of names) {
      const profile = await readStoredJson(
        path.join(this.#root, name),
        learnedSaveProfileSchema,
        "Learned Save Profile was not found.",
      );
      this.#verify(profile);
      if (profile.gameCanonicalId === gameCanonicalId) {
        profiles.push(profile);
      }
    }
    return profiles.map((profile) => Object.freeze(profile));
  }

  #verify(profile: LearnedSaveProfile): void {
    const actualHash = hashWithoutField(profile, "profileHash");
    if (actualHash !== profile.profileHash) {
      throw new NexusError(
        "SAVE_CONTEXT_STALE",
        "Learned Save Profile hash verification failed.",
        {
          details: {
            learnedProfileId: profile.learnedProfileId,
            expectedHash: profile.profileHash,
            actualHash,
          },
        },
      );
    }
  }
}
