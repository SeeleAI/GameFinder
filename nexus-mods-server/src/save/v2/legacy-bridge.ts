import { sha256CanonicalJson } from "../../install/content-hash.js";
import type { GameInstallContext, GameSaveProfile, SaveContext } from "../contracts.js";
import { gameInstallContextSchema, gameSaveProfileSchema, saveContextSchema } from "../contracts.js";
import type { GameInstallContextV2, GameSaveRecipe, SaveContextV2 } from "./contracts.js";

function legacyProbeRoots(recipe: Readonly<GameSaveRecipe>): string[] {
  const roots: string[] = [];
  for (const declaration of recipe.locationStrategies) {
    const product = typeof declaration.parameters.productDirectory === "string"
      ? declaration.parameters.productDirectory
      : null;
    if (!product) continue;
    if (declaration.strategyId.startsWith("documents-")) roots.push(`%USERPROFILE%/Documents/${product}`);
    else if (declaration.strategyId.startsWith("saved-games-")) roots.push(`%USERPROFILE%/Saved Games/${product}`);
    else if (declaration.strategyId.startsWith("appdata-roaming-")) roots.push(`%APPDATA%/${product}`);
    else if (declaration.strategyId.startsWith("appdata-local-")) roots.push(`%LOCALAPPDATA%/${product}`);
  }
  return roots.length > 0 ? roots : ["%USERPROFILE%/GameFinder/V2-bounded-probe"];
}

function legacySaveRoots(recipe: Readonly<GameSaveRecipe>): string[] {
  return legacyProbeRoots(recipe).map((root, index) =>
    recipe.locationStrategies[index]?.strategyId.includes("account-subdir")
      ? `${root}/{STEAM_ID64}`
      : root,
  );
}

export function recipeLegacyTransactionProfile(recipe: Readonly<GameSaveRecipe>): GameSaveProfile {
  return gameSaveProfileSchema.parse({
    schemaVersion: 1,
    profileId: recipe.recipeId,
    profileVersion: recipe.recipeVersion,
    game: {
      canonicalId: recipe.game.canonicalId,
      displayName: recipe.game.displayName,
      store: "steam",
      storeAppId: recipe.game.platformAppIds.steam ?? recipe.game.canonicalId,
    },
    supportedPlatforms: ["windows"],
    sources: recipe.sources,
    discovery: {
      executableAnchors: recipe.identity.executableAnchors,
      saveRootTemplates: legacySaveRoots(recipe),
      probeRootTemplates: legacyProbeRoots(recipe),
      accountDirectoryPattern: recipe.locationStrategies
        .map((strategy) => strategy.parameters.accountDirectoryPattern)
        .find((value): value is string => typeof value === "string") ?? null,
    },
    saveUnits: recipe.saveUnits.map((unit) => ({
      unitId: unit.unitId,
      essential: [...new Set([...unit.requiredAll, ...unit.requiredAnyOf])].length > 0
        ? [...new Set([...unit.requiredAll, ...unit.requiredAnyOf])]
        : [unit.managedPatterns[0]!],
      companions: [],
      auxiliary: [],
      managedPaths: unit.managedPatterns,
    })),
    format: {
      kind: recipe.format.kind === "opaque-files" ? "unknown" : recipe.format.kind,
      adapterId: recipe.format.adapterId,
    },
    runtime: recipe.runtime,
  });
}

export function gameInstallContextV2LegacyProjection(context: Readonly<GameInstallContextV2>): GameInstallContext {
  const manifestEvidence = context.installEvidence.find((evidence) => evidence.kind === "steam-appmanifest");
  const steamId = context.accountHints.find((hint) => hint.kind === "steam_id64")?.value ?? null;
  const withoutHash: Omit<GameInstallContext, "contextHash"> = {
    schemaVersion: 1,
    installContextId: context.installContextId,
    gameRoot: context.gameRoot,
    platform: "windows",
    store: context.distributionKind === "steam-library" ? "steam" : "manual",
    game: {
      canonicalId: context.game.canonicalId,
      displayName: context.game.displayName,
      storeAppId: context.game.platformAppId,
    },
    storeMetadata: {
      steam: context.distributionKind === "steam-library" && context.game.platformAppId && manifestEvidence?.path
        ? {
            appId: context.game.platformAppId,
            buildId: null,
            lastOwner: steamId && /^\d{17}$/.test(steamId) ? steamId : null,
            installDir: context.game.displayName,
            manifestPath: manifestEvidence.path,
          }
        : null,
    },
    installEvidence: context.installEvidence.map((evidence) => ({
      kind: evidence.kind === "steam-appmanifest" ? "steam-appmanifest" as const
        : evidence.kind === "pe-version" ? "pe-version" as const
          : evidence.kind === "executable-anchor" ? "executable-anchor" as const
            : "filesystem" as const,
      path: evidence.path,
      detail: evidence.detail,
      observedAt: evidence.observedAt,
    })),
    confidence: context.confidence,
    createdAt: context.createdAt,
  };
  return gameInstallContextSchema.parse({ ...withoutHash, contextHash: sha256CanonicalJson(withoutHash) });
}

export function saveContextV2LegacyProjection(context: Readonly<SaveContextV2>): SaveContext {
  const withoutHash: Omit<SaveContext, "contextHash"> = {
    schemaVersion: 1,
    saveContextId: context.saveContextId,
    installContextId: context.installContextId,
    windowsUserSidHash: null,
    windowsUserIdentityHash: sha256CanonicalJson({ scope: "v2-transaction-bridge", saveContextHash: context.contextHash }),
    profile: { profileId: context.recipe.recipeId, profileVersion: context.recipe.recipeVersion, source: "built-in" },
    storeAccount: context.accountIdentity.kind === "steam_id64"
      ? { kind: "steam_id64", value: context.accountIdentity.value }
      : { kind: "unknown", value: context.accountIdentity.value },
    saveRoots: context.saveRoots.map(({ rootId, absolutePath, role }) => ({ rootId, absolutePath, role })),
    saveUnits: context.saveUnits.map((unit) => ({
      unitId: unit.unitId,
      essential: unit.materializedFiles.filter((file) => file.role === "essential").map((file) => file.relativePath),
      companions: unit.materializedFiles.filter((file) => file.role === "companion").map((file) => file.relativePath),
      auxiliary: unit.materializedFiles.filter((file) => file.role === "auxiliary").map((file) => file.relativePath),
      managedPaths: unit.materializedFiles.map((file) => file.relativePath),
    })),
    format: { kind: context.format.kind === "opaque-files" ? "unknown" : context.format.kind, adapterId: context.format.adapterId },
    evidence: context.evidence.map((evidence) => ({ kind: "filesystem" as const, path: evidence.path, detail: evidence.detail, observedAt: evidence.observedAt })),
    verification: { state: "confirmed", method: "profile+filesystem" },
    createdAt: context.createdAt,
  };
  return saveContextSchema.parse({ ...withoutHash, contextHash: sha256CanonicalJson(withoutHash) });
}
