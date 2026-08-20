import { readdir } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import type { GameSaveRecipe } from "../v2/contracts.js";
import {
  gameSaveRecipeSchema,
  verifyGameSaveRecipeHash,
} from "../v2/contracts.js";
import {
  ensureRealStoreDirectory,
  publishJsonExclusive,
  readStoredJson,
} from "../storage/json-store.js";

export class GameSaveRecipeStoreV2 {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  static async create(managerRoot: string): Promise<GameSaveRecipeStoreV2> {
    return new GameSaveRecipeStoreV2(
      await ensureRealStoreDirectory(managerRoot, "recipes", "v2"),
    );
  }

  async save(recipe: GameSaveRecipe): Promise<Readonly<GameSaveRecipe>> {
    const parsed = gameSaveRecipeSchema.parse(recipe);
    if (!verifyGameSaveRecipeHash(parsed)) {
      throw new NexusError("SAVE_CONTRACT_INVALID", "Game Save Recipe hash verification failed.", {
        details: { recipeId: parsed.recipeId },
      });
    }
    const filePath = this.#path(parsed.recipeHash);
    await publishJsonExclusive(filePath, parsed).catch(async (error: unknown) => {
      const existing = await this.get(parsed.recipeHash).catch(() => null);
      if (existing && existing.recipeId === parsed.recipeId && existing.recipeVersion === parsed.recipeVersion) {
        return;
      }
      throw error;
    });
    return await this.get(parsed.recipeHash);
  }

  async get(recipeHash: string): Promise<Readonly<GameSaveRecipe>> {
    const recipe = await readStoredJson(
      this.#path(recipeHash),
      gameSaveRecipeSchema,
      "Game Save Recipe was not found.",
    );
    if (!verifyGameSaveRecipeHash(recipe)) {
      throw new NexusError("SAVE_CONTEXT_STALE", "Stored Game Save Recipe hash verification failed.", {
        details: { recipeId: recipe.recipeId, recipeHash },
      });
    }
    return recipe;
  }

  async list(): Promise<ReadonlyArray<Readonly<GameSaveRecipe>>> {
    const names = (await readdir(this.#root))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .sort((left, right) => left.localeCompare(right));
    return await Promise.all(names.map(async (name) => await this.get(name.slice(0, 64))));
  }

  #path(recipeHash: string): string {
    if (!/^[a-f0-9]{64}$/.test(recipeHash)) {
      throw new NexusError("SAVE_CONTRACT_INVALID", "recipeHash must be a lowercase SHA-256 value.");
    }
    return path.join(this.#root, `${recipeHash}.json`);
  }
}
