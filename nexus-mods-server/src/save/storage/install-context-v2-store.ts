import path from "node:path";

import { NexusError } from "../../errors.js";
import type { GameInstallContextV2 } from "../v2/contracts.js";
import {
  gameInstallContextV2Schema,
  verifyGameInstallContextV2Hash,
} from "../v2/contracts.js";
import {
  assertUuid,
  ensureRealStoreDirectory,
  publishJsonExclusive,
  readStoredJson,
} from "./json-store.js";

export class GameInstallContextV2Store {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  static async create(managerRoot: string): Promise<GameInstallContextV2Store> {
    return new GameInstallContextV2Store(
      await ensureRealStoreDirectory(managerRoot, "install-contexts-v2"),
    );
  }

  async save(context: GameInstallContextV2): Promise<Readonly<GameInstallContextV2>> {
    const parsed = gameInstallContextV2Schema.parse(context);
    if (!verifyGameInstallContextV2Hash(parsed)) {
      throw new NexusError("SAVE_CONTEXT_STALE", "Game Install Context V2 hash verification failed.", {
        details: { installContextId: parsed.installContextId },
      });
    }
    await publishJsonExclusive(path.join(this.#root, `${parsed.installContextId}.json`), parsed);
    return Object.freeze(parsed);
  }

  async get(installContextId: string): Promise<Readonly<GameInstallContextV2>> {
    assertUuid(installContextId, "installContextId");
    const parsed = await readStoredJson(
      path.join(this.#root, `${installContextId}.json`),
      gameInstallContextV2Schema,
      "Game Install Context V2 was not found.",
    );
    if (parsed.installContextId !== installContextId || !verifyGameInstallContextV2Hash(parsed)) {
      throw new NexusError("SAVE_CONTEXT_STALE", "Stored Game Install Context V2 is stale.", {
        details: { installContextId },
      });
    }
    return Object.freeze(parsed);
  }
}
