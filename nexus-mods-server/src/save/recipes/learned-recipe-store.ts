import path from "node:path";
import { z } from "zod/v4";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import type { GameSaveRecipe } from "../v2/contracts.js";
import { gameSaveRecipeSchema, verifyGameSaveRecipeHash } from "../v2/contracts.js";
import { ensureRealStoreDirectory, publishJsonExclusive, readStoredJson } from "../storage/json-store.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const learnedRecipeRecordSchema = z.object({
  schemaVersion: z.literal(2),
  learnedRecipeId: z.string().uuid(),
  recipe: gameSaveRecipeSchema,
  gameRootFingerprint: sha256,
  windowsUserIdentityHash: sha256,
  resolverEvidenceHash: sha256,
  probeHash: sha256,
  saveRoot: z.string().trim().min(3).max(32_767),
  materializedPaths: z.array(z.string().trim().min(1).max(1_024)).min(1).max(10_000),
  createdAt: z.iso.datetime({ offset: false }),
  recordHash: sha256,
});

export type LearnedRecipeRecordV2 = z.infer<typeof learnedRecipeRecordSchema>;

export class LearnedGameSaveRecipeStoreV2 {
  private constructor(private readonly root: string) {}
  static async create(managerRoot: string): Promise<LearnedGameSaveRecipeStoreV2> {
    return new LearnedGameSaveRecipeStoreV2(await ensureRealStoreDirectory(managerRoot, "learned-save-recipes-v2"));
  }
  async save(value: Omit<LearnedRecipeRecordV2, "recordHash">): Promise<Readonly<LearnedRecipeRecordV2>> {
    if (value.recipe.trust !== "local_verified" || !verifyGameSaveRecipeHash(value.recipe)) {
      throw new NexusError("SAVE_CONTRACT_INVALID", "A learned Recipe record requires a hash-verified local_verified Recipe.");
    }
    if (!path.isAbsolute(value.saveRoot)) throw new NexusError("SAVE_CONTRACT_INVALID", "A learned Recipe save root must be absolute.");
    const parsed = learnedRecipeRecordSchema.parse({ ...value, recordHash: sha256CanonicalJson(value) });
    await publishJsonExclusive(path.join(this.root, `${parsed.learnedRecipeId}.json`), parsed);
    return Object.freeze(parsed);
  }
  async get(learnedRecipeId: string): Promise<Readonly<LearnedRecipeRecordV2>> {
    const parsed = await readStoredJson(path.join(this.root, `${learnedRecipeId}.json`), learnedRecipeRecordSchema, "Learned Game Save Recipe was not found.");
    const { recordHash, ...payload } = parsed;
    if (recordHash !== sha256CanonicalJson(payload) || !verifyGameSaveRecipeHash(parsed.recipe)) throw new NexusError("SAVE_CONTEXT_STALE", "Learned Recipe record hash verification failed.");
    return Object.freeze(parsed);
  }
}
