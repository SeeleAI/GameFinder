import { NexusError } from "../../errors.js";
import type { GameSaveProfile } from "../contracts.js";
import { ELDEN_RING_STEAM_PC_PROFILE } from "./elden-ring-steam-pc.js";

export class GameSaveProfileRegistry {
  readonly #profiles: ReadonlyArray<GameSaveProfile>;

  constructor(
    profiles: ReadonlyArray<GameSaveProfile> = [
      ELDEN_RING_STEAM_PC_PROFILE,
    ],
  ) {
    const ids = new Set<string>();
    for (const profile of profiles) {
      if (ids.has(profile.profileId)) {
        throw new NexusError(
          "SAVE_CONTRACT_INVALID",
          "Game Save Profile IDs must be unique.",
          { details: { profileId: profile.profileId } },
        );
      }
      ids.add(profile.profileId);
    }
    this.#profiles = [...profiles];
  }

  list(): ReadonlyArray<GameSaveProfile> {
    return [...this.#profiles];
  }

  findById(profileId: string): GameSaveProfile | null {
    return (
      this.#profiles.find((profile) => profile.profileId === profileId) ?? null
    );
  }

  findBySteamAppId(appId: string): GameSaveProfile | null {
    return (
      this.#profiles.find(
        (profile) =>
          profile.game.store === "steam" &&
          profile.game.storeAppId === appId,
      ) ?? null
    );
  }

  findByCanonicalGameId(canonicalId: string): GameSaveProfile | null {
    return (
      this.#profiles.find(
        (profile) => profile.game.canonicalId === canonicalId,
      ) ?? null
    );
  }
}
