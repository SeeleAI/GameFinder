import path from "node:path";

import { NexusError } from "../../errors.js";
import { ensureRealStoreDirectory, publishJsonExclusive, readStoredJson } from "../storage/json-store.js";
import type { AdapterDevelopmentBrief } from "../v2/contracts.js";
import {
  adapterDevelopmentBriefSchema,
  verifyAdapterDevelopmentBriefHash,
} from "../v2/contracts.js";

export class AdapterDevelopmentBriefStore {
  private constructor(private readonly root: string) {}

  static async create(managerRoot: string): Promise<AdapterDevelopmentBriefStore> {
    return new AdapterDevelopmentBriefStore(
      await ensureRealStoreDirectory(managerRoot, "adapter-development-briefs"),
    );
  }

  async save(value: AdapterDevelopmentBrief): Promise<Readonly<AdapterDevelopmentBrief>> {
    const parsed = adapterDevelopmentBriefSchema.parse(value);
    if (!verifyAdapterDevelopmentBriefHash(parsed)) {
      throw new NexusError("SAVE_CONTRACT_INVALID", "Adapter Development Brief hash verification failed.");
    }
    await publishJsonExclusive(path.join(this.root, `${parsed.briefId}.json`), parsed);
    return Object.freeze(parsed);
  }

  async get(briefId: string): Promise<Readonly<AdapterDevelopmentBrief>> {
    const parsed = await readStoredJson(
      path.join(this.root, `${briefId}.json`),
      adapterDevelopmentBriefSchema,
      "Adapter Development Brief was not found.",
    );
    if (parsed.briefId !== briefId || !verifyAdapterDevelopmentBriefHash(parsed)) {
      throw new NexusError("SAVE_CONTEXT_STALE", "Stored Adapter Development Brief is stale.");
    }
    return Object.freeze(parsed);
  }
}
