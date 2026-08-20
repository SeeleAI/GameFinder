import type { GameInstallContextV2, GameSaveRecipe } from "../v2/contracts.js";
import {
  assertRecipeSupportsResolver,
  buildInstallContextV2,
  recipeById,
  uniqueRecipe,
  validatedGameRoot,
  verifyRecipeAnchor,
} from "./common.js";
import type { SaveInstallResolverInput, SaveInstallResolverV2 } from "./types.js";

export class ManualPeResolver implements SaveInstallResolverV2 {
  readonly resolverId = "manual-pe";
  readonly resolverVersion = "1.0.0";
  readonly distributionKind = "manual-pe" as const;

  async probe(input: SaveInstallResolverInput): Promise<GameInstallContextV2 | null> {
    const gameRoot = await validatedGameRoot(input.gameRoot);
    let recipe: Readonly<GameSaveRecipe>;
    if (input.recipeId !== undefined) {
      recipe = recipeById(input.recipes, input.recipeId);
      assertRecipeSupportsResolver(recipe, this.resolverId);
    } else {
      const matches: Array<Readonly<GameSaveRecipe>> = [];
      for (const candidate of input.recipes.list().filter((value) => value.installResolvers.includes(this.resolverId))) {
        const matched = await verifyRecipeAnchor({
          gameRoot,
          recipe: candidate,
          ...(input.peMetadataReader === undefined ? {} : { peMetadataReader: input.peMetadataReader }),
          requirePeIdentity: true,
        }).then(() => true).catch(() => false);
        if (matched) matches.push(candidate);
      }
      recipe = uniqueRecipe(matches, { resolverId: this.resolverId, gameRoot });
    }
    const anchor = await verifyRecipeAnchor({
      gameRoot,
      recipe,
      ...(input.peMetadataReader === undefined ? {} : { peMetadataReader: input.peMetadataReader }),
      requirePeIdentity: true,
    });
    const platformAppId = recipe.game.platformAppIds.manual ?? recipe.game.platformAppIds.steam ?? null;
    return buildInstallContextV2({
      resolverId: this.resolverId,
      resolverVersion: this.resolverVersion,
      distributionKind: this.distributionKind,
      gameRoot,
      anchor,
      platformAppId,
      additionalEvidence: [{
        kind: "manual-pe-identity",
        path: anchor.anchorPath,
        detail: "Matched the Recipe through executable path and PE product identity without a platform manifest.",
      }],
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  }
}
