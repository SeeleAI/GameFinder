import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { NexusError } from "../../errors.js";
import type { GameSaveRecipe } from "../v2/contracts.js";
import {
  materializeGameSaveRecipe,
  verifyGameSaveRecipeHash,
} from "../v2/contracts.js";

const DEFAULT_BUILT_IN_DIRECTORY = fileURLToPath(
  new URL("./built-in/", import.meta.url),
);

function normalizeIdentity(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export interface GameSaveRecipeQuery {
  canonicalId?: string;
  platform?: "steam" | "gog" | "epic" | "xbox" | "manual";
  platformAppId?: string;
  executableName?: string;
  productName?: string;
}

export class GameSaveRecipeRegistryV2 {
  readonly #recipes: ReadonlyArray<Readonly<GameSaveRecipe>>;

  constructor(recipes: ReadonlyArray<GameSaveRecipe>) {
    const ids = new Set<string>();
    for (const recipe of recipes) {
      if (!verifyGameSaveRecipeHash(recipe)) {
        throw new NexusError("SAVE_CONTRACT_INVALID", "Game Save Recipe hash verification failed.", {
          details: { recipeId: recipe.recipeId },
        });
      }
      if (ids.has(recipe.recipeId)) {
        throw new NexusError("SAVE_CONTRACT_INVALID", "Game Save Recipe IDs must be unique.", {
          details: { recipeId: recipe.recipeId },
        });
      }
      ids.add(recipe.recipeId);
    }
    this.#recipes = [...recipes].sort((left, right) => left.recipeId.localeCompare(right.recipeId));
  }

  static async fromDirectory(directory = DEFAULT_BUILT_IN_DIRECTORY): Promise<GameSaveRecipeRegistryV2> {
    const names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    const recipes = await Promise.all(names.map(async (name) => {
      const filePath = path.join(directory, name);
      try {
        return materializeGameSaveRecipe(JSON.parse(await readFile(filePath, "utf8")) as unknown);
      } catch (error) {
        throw new NexusError("SAVE_CONTRACT_INVALID", "A Game Save Recipe file is invalid.", {
          cause: error,
          details: { filePath },
        });
      }
    }));
    return new GameSaveRecipeRegistryV2(recipes);
  }

  list(): ReadonlyArray<Readonly<GameSaveRecipe>> {
    return [...this.#recipes];
  }

  findById(recipeId: string): Readonly<GameSaveRecipe> | null {
    return this.#recipes.find((recipe) => recipe.recipeId === recipeId) ?? null;
  }

  findCandidates(query: GameSaveRecipeQuery): ReadonlyArray<Readonly<GameSaveRecipe>> {
    return this.#recipes.filter((recipe) => {
      if (query.canonicalId !== undefined && recipe.game.canonicalId !== query.canonicalId) return false;
      if (query.platform !== undefined && query.platformAppId !== undefined) {
        if (recipe.game.platformAppIds[query.platform] !== query.platformAppId) return false;
      } else if (query.platformAppId !== undefined) {
        if (!Object.values(recipe.game.platformAppIds).includes(query.platformAppId)) return false;
      }
      if (query.executableName !== undefined) {
        const executable = normalizeIdentity(query.executableName);
        if (!recipe.identity.executableAnchors.some(
          (anchor) => normalizeIdentity(path.posix.basename(anchor)) === executable,
        )) return false;
      }
      if (query.productName !== undefined) {
        const productName = normalizeIdentity(query.productName);
        if (!recipe.identity.productNames.some((candidate) => normalizeIdentity(candidate) === productName)) {
          return false;
        }
      }
      return true;
    });
  }
}

export function builtInRecipeDirectory(): string {
  return DEFAULT_BUILT_IN_DIRECTORY;
}
