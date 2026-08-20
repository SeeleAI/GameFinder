import path from "node:path";

import { NexusError } from "../../errors.js";
import type { StandardSavePackageV2 } from "../v2/contracts.js";
import { standardSavePackageV2Schema, verifyStandardSavePackageV2Hash } from "../v2/contracts.js";
import { ensureRealStoreDirectory, publishJsonExclusive, readStoredJson } from "../storage/json-store.js";

export class StandardSavePackageV2Store {
  private constructor(private readonly root: string) {}
  static async create(managerRoot: string): Promise<StandardSavePackageV2Store> {
    return new StandardSavePackageV2Store(await ensureRealStoreDirectory(managerRoot, "standard-save-packages-v2"));
  }
  async save(value: StandardSavePackageV2): Promise<Readonly<StandardSavePackageV2>> {
    const parsed = standardSavePackageV2Schema.parse(value);
    if (!verifyStandardSavePackageV2Hash(parsed)) throw new NexusError("SAVE_PACKAGE_INVALID", "Standard Save Package V2 hash verification failed.");
    await publishJsonExclusive(path.join(this.root, `${parsed.packageId}.json`), parsed);
    return Object.freeze(parsed);
  }
  async get(packageId: string): Promise<Readonly<StandardSavePackageV2>> {
    const parsed = await readStoredJson(path.join(this.root, `${packageId}.json`), standardSavePackageV2Schema, "Standard Save Package V2 was not found.");
    if (parsed.packageId !== packageId || !verifyStandardSavePackageV2Hash(parsed)) throw new NexusError("SAVE_PACKAGE_INVALID", "Stored Standard Save Package V2 is stale.");
    return Object.freeze(parsed);
  }
}
