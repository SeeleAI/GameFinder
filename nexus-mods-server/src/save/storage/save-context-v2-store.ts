import path from "node:path";

import { NexusError } from "../../errors.js";
import type { SaveContextV2 } from "../v2/contracts.js";
import { saveContextV2Schema, verifySaveContextV2Hash } from "../v2/contracts.js";
import { assertUuid, ensureRealStoreDirectory, publishJsonExclusive, readStoredJson } from "./json-store.js";

export class SaveContextV2Store {
  private constructor(private readonly root: string) {}
  static async create(managerRoot: string): Promise<SaveContextV2Store> {
    return new SaveContextV2Store(await ensureRealStoreDirectory(managerRoot, "save-contexts-v2"));
  }
  async save(context: SaveContextV2): Promise<Readonly<SaveContextV2>> {
    const parsed = saveContextV2Schema.parse(context);
    if (!verifySaveContextV2Hash(parsed)) throw new NexusError("SAVE_CONTEXT_STALE", "Save Context V2 hash verification failed.");
    await publishJsonExclusive(path.join(this.root, `${parsed.saveContextId}.json`), parsed);
    return Object.freeze(parsed);
  }
  async get(saveContextId: string): Promise<Readonly<SaveContextV2>> {
    assertUuid(saveContextId, "saveContextId");
    const parsed = await readStoredJson(path.join(this.root, `${saveContextId}.json`), saveContextV2Schema, "Save Context V2 was not found.");
    if (parsed.saveContextId !== saveContextId || !verifySaveContextV2Hash(parsed)) throw new NexusError("SAVE_CONTEXT_STALE", "Stored Save Context V2 is stale.");
    return Object.freeze(parsed);
  }
}
