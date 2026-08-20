import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import { sha256File } from "../../install/file-hash.js";
import type { GameSaveRecipeRegistryV2 } from "../recipes/recipe-registry.js";
import type {
  GameInstallContextV2,
  GameSaveRecipe,
  SaveAccountKind,
  SaveDistributionKind,
} from "../v2/contracts.js";
import {
  computeGameInstallContextV2Hash,
  gameInstallContextV2Schema,
} from "../v2/contracts.js";
import { readWindowsPeMetadata } from "./pe-metadata.js";
import type {
  PeMetadataReader,
  SaveInstallResolverInput,
  VerifiedRecipeAnchor,
} from "./types.js";

export async function validatedGameRoot(value: string): Promise<string> {
  if (!path.isAbsolute(value)) {
    throw new NexusError("SAVE_CONTRACT_INVALID", "The game root must be absolute.", {
      details: { gameRoot: value },
    });
  }
  const gameRoot = path.resolve(value);
  const info = await stat(gameRoot).catch((error: unknown) => {
    throw new NexusError("GAME_INSTALL_NOT_IDENTIFIED", "The selected game root does not exist.", {
      cause: error,
      details: { gameRoot },
    });
  });
  if (!info.isDirectory()) {
    throw new NexusError("GAME_INSTALL_NOT_IDENTIFIED", "The selected game root is not a directory.", {
      details: { gameRoot },
    });
  }
  return gameRoot;
}

export function recipeById(
  recipes: GameSaveRecipeRegistryV2,
  recipeId: string,
): Readonly<GameSaveRecipe> {
  const recipe = recipes.findById(recipeId);
  if (!recipe) {
    throw new NexusError("SAVE_RECIPE_NOT_FOUND", "The requested Game Save Recipe was not found.", {
      details: { recipeId },
    });
  }
  return recipe;
}

export function assertRecipeSupportsResolver(
  recipe: Readonly<GameSaveRecipe>,
  resolverId: string,
): void {
  if (!recipe.installResolvers.includes(resolverId)) {
    throw new NexusError(
      "SAVE_INSTALL_IDENTITY_AMBIGUOUS",
      "The selected Game Save Recipe does not support this installation resolver.",
      { details: { recipeId: recipe.recipeId, resolverId } },
    );
  }
}

export function uniqueRecipe(
  candidates: ReadonlyArray<Readonly<GameSaveRecipe>>,
  evidence: Record<string, unknown>,
): Readonly<GameSaveRecipe> {
  if (candidates.length === 0) {
    throw new NexusError("SAVE_RECIPE_NOT_FOUND", "No Game Save Recipe matches the identified installation.", {
      details: evidence,
    });
  }
  if (candidates.length > 1) {
    throw new NexusError("SAVE_RECIPE_AMBIGUOUS", "Multiple Game Save Recipes match the identified installation.", {
      details: { ...evidence, recipeIds: candidates.map((recipe) => recipe.recipeId) },
    });
  }
  return candidates[0]!;
}

export async function verifyRecipeAnchor(input: {
  gameRoot: string;
  recipe: Readonly<GameSaveRecipe>;
  peMetadataReader?: PeMetadataReader;
  requirePeIdentity?: boolean;
}): Promise<VerifiedRecipeAnchor> {
  const reader = input.peMetadataReader ?? readWindowsPeMetadata;
  for (const anchor of input.recipe.identity.executableAnchors) {
    if (anchor.includes("*")) continue;
    const anchorPath = path.join(input.gameRoot, ...anchor.split("/"));
    const info = await stat(anchorPath).catch(() => null);
    if (!info?.isFile()) continue;
    const peMetadata = await reader(anchorPath);
    if (peMetadata?.productName) {
      const actual = peMetadata.productName.toLocaleLowerCase("en-US");
      const expected = input.recipe.identity.productNames.some(
        (name) => name.toLocaleLowerCase("en-US") === actual,
      );
      if (!expected) continue;
    } else if (input.requirePeIdentity) {
      continue;
    }
    return {
      recipe: input.recipe,
      anchorPath,
      anchorSha256: await sha256File(anchorPath),
      peMetadata,
    };
  }
  throw new NexusError("GAME_INSTALL_NOT_IDENTIFIED", "No executable anchor satisfies the selected Game Save Recipe.", {
    details: {
      gameRoot: input.gameRoot,
      recipeId: input.recipe.recipeId,
      expectedAnchors: input.recipe.identity.executableAnchors,
      requirePeIdentity: input.requirePeIdentity ?? false,
    },
  });
}

export function buildInstallContextV2(input: {
  resolverId: string;
  resolverVersion: string;
  distributionKind: SaveDistributionKind;
  gameRoot: string;
  anchor: VerifiedRecipeAnchor;
  platformAppId: string | null;
  accountHints?: ReadonlyArray<{
    kind: SaveAccountKind;
    value: string | null;
    confidence: "confirmed" | "probable" | "unknown";
    evidence: string;
  }>;
  platformCandidateRoots?: ReadonlyArray<string>;
  additionalEvidence?: ReadonlyArray<{
    kind: string;
    path: string | null;
    detail: string;
  }>;
  now?: Date;
}): GameInstallContextV2 {
  const observedAt = (input.now ?? new Date()).toISOString();
  const installEvidence = [
    {
      kind: "executable-anchor",
      path: input.anchor.anchorPath,
      detail: `Verified ${path.basename(input.anchor.anchorPath)} with SHA-256 ${input.anchor.anchorSha256}.`,
      observedAt,
    },
    ...(input.anchor.peMetadata ? [{
      kind: "pe-version",
      path: input.anchor.anchorPath,
      detail: `PE product=${input.anchor.peMetadata.productName ?? "unknown"}, fileVersion=${input.anchor.peMetadata.fileVersion ?? "unknown"}.`,
      observedAt,
    }] : []),
    ...(input.additionalEvidence ?? []).map((evidence) => ({ ...evidence, observedAt })),
  ];
  const gameRootFingerprint = sha256CanonicalJson({
    gameRoot: path.resolve(input.gameRoot).toLocaleLowerCase("en-US"),
    recipeHash: input.anchor.recipe.recipeHash,
    anchorSha256: input.anchor.anchorSha256,
  });
  const withoutHash: Omit<GameInstallContextV2, "contextHash"> = {
    schemaVersion: 2,
    installContextId: randomUUID(),
    gameRoot: path.resolve(input.gameRoot),
    gameRootFingerprint,
    platform: "windows",
    resolver: { resolverId: input.resolverId, resolverVersion: input.resolverVersion },
    distributionKind: input.distributionKind,
    game: {
      canonicalId: input.anchor.recipe.game.canonicalId,
      displayName: input.anchor.recipe.game.displayName,
      platformAppId: input.platformAppId,
    },
    recipe: {
      recipeId: input.anchor.recipe.recipeId,
      recipeVersion: input.anchor.recipe.recipeVersion,
      recipeHash: input.anchor.recipe.recipeHash,
    },
    accountHints: [...(input.accountHints ?? [])],
    platformCandidateRoots: [...new Set((input.platformCandidateRoots ?? []).map((root) => path.resolve(root)))],
    installEvidence,
    confidence: "confirmed",
    createdAt: observedAt,
  };
  return gameInstallContextV2Schema.parse({
    ...withoutHash,
    contextHash: computeGameInstallContextV2Hash(withoutHash),
  });
}

export function selectedRecipe(input: SaveInstallResolverInput): Readonly<GameSaveRecipe> | null {
  return input.recipeId === undefined ? null : recipeById(input.recipes, input.recipeId);
}
