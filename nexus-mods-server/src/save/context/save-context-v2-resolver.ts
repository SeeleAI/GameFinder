import { randomUUID } from "node:crypto";

import { NexusError } from "../../errors.js";
import type { SaveLocationStrategyRegistryV2 } from "../location-strategies/registry.js";
import type { WindowsSaveEnvironmentV2 } from "../location-strategies/types.js";
import { materializeSaveUnitsV2 } from "../layout-families/materializer.js";
import type { GameSaveRecipeRegistryV2 } from "../recipes/recipe-registry.js";
import type { GameInstallContextV2, SaveContextV2 } from "../v2/contracts.js";
import { computeSaveContextV2Hash, saveContextV2Schema } from "../v2/contracts.js";

export class SaveContextResolverV2 {
  constructor(private readonly input: {
    recipes: GameSaveRecipeRegistryV2;
    strategies: SaveLocationStrategyRegistryV2;
    environment: WindowsSaveEnvironmentV2;
  }) {}

  async resolve(install: Readonly<GameInstallContextV2>): Promise<SaveContextV2> {
    const recipe = install.recipe ? this.input.recipes.findById(install.recipe.recipeId) : null;
    if (!recipe || recipe.recipeHash !== install.recipe?.recipeHash) {
      throw new NexusError("SAVE_RECIPE_NOT_FOUND", "The Install Context Recipe is unavailable or changed.");
    }
    const matches: Array<{
      strategyId: string;
      absolutePath: string;
      accountDirectory: string | null;
      accountKind: SaveContextV2["accountIdentity"]["kind"];
      evidence: string;
      units: Awaited<ReturnType<typeof materializeSaveUnitsV2>>;
    }> = [];
    for (const declaration of recipe.locationStrategies) {
      const strategy = this.input.strategies.get(declaration.strategyId);
      const candidates = await strategy.candidates({
        install,
        recipe,
        parameters: declaration.parameters,
        environment: this.input.environment,
      });
      for (const candidate of candidates) {
        const units = await materializeSaveUnitsV2(candidate.absolutePath, recipe);
        if (units.length > 0) matches.push({
          strategyId: candidate.strategyId,
          absolutePath: candidate.absolutePath,
          accountDirectory: candidate.accountDirectory,
          accountKind: candidate.accountKind,
          evidence: candidate.evidence,
          units,
        });
      }
    }
    if (matches.length === 0) throw new NexusError("SAVE_LOCATION_STRATEGY_EXHAUSTED", "No Location Strategy produced a root with a valid Recipe layout.", { details: { recipeId: recipe.recipeId } });
    if (matches.length > 1) throw new NexusError("SAVE_CONTEXT_AMBIGUOUS", "Multiple save roots satisfy the Recipe and layout.", { details: { candidateRoots: matches.map((match) => match.absolutePath) } });
    const match = matches[0]!;
    const createdAt = new Date().toISOString();
    const saveContextId = randomUUID();
    const withoutHash: Omit<SaveContextV2, "contextHash"> = {
      schemaVersion: 2,
      saveContextId,
      installContextId: install.installContextId,
      installContextHash: install.contextHash,
      recipe: { recipeId: recipe.recipeId, recipeVersion: recipe.recipeVersion, recipeHash: recipe.recipeHash },
      resolverId: install.resolver.resolverId,
      distributionKind: install.distributionKind,
      accountIdentity: {
        kind: match.accountKind,
        value: match.accountDirectory,
        evidence: match.evidence,
      },
      saveRoots: [{ rootId: "primary", absolutePath: match.absolutePath, role: "primary", strategyId: match.strategyId }],
      saveUnits: match.units.map((unit) => ({
        unitId: unit.unitId,
        rootId: "primary",
        layoutFamily: unit.layoutFamily,
        materializedFiles: unit.files,
        materializationHash: unit.materializationHash,
      })),
      binding: recipe.binding,
      format: recipe.format,
      verification: { state: "confirmed", method: "recipe+filesystem" },
      evidence: [{
        kind: "location-strategy",
        path: match.absolutePath,
        detail: match.evidence,
        observedAt: createdAt,
      }, {
        kind: "layout-materialization",
        path: match.absolutePath,
        detail: `Materialized ${match.units.reduce((sum, unit) => sum + unit.files.length, 0)} exact managed file(s).`,
        observedAt: createdAt,
      }],
      createdAt,
    };
    return saveContextV2Schema.parse({ ...withoutHash, contextHash: computeSaveContextV2Hash(withoutHash) });
  }
}
