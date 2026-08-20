import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import type { GameInstallContextV2 } from "../v2/contracts.js";
import {
  assertRecipeSupportsResolver,
  buildInstallContextV2,
  selectedRecipe,
  uniqueRecipe,
  validatedGameRoot,
  verifyRecipeAnchor,
} from "./common.js";
import type { SaveInstallResolverInput, SaveInstallResolverV2 } from "./types.js";

interface SteamManifest {
  appId: string;
  name: string;
  installDir: string;
  buildId: string | null;
  lastOwner: string | null;
  manifestPath: string;
}

function manifestValue(source: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`"${escaped}"\\s+"([^"]*)"`, "i").exec(source)?.[1] ?? null;
}

function parseSteamManifest(source: string, manifestPath: string): SteamManifest | null {
  const appId = manifestValue(source, "appid");
  const name = manifestValue(source, "name");
  const installDir = manifestValue(source, "installdir");
  if (!appId || !name || !installDir) return null;
  const lastOwner = manifestValue(source, "LastOwner");
  return {
    appId,
    name,
    installDir,
    buildId: manifestValue(source, "buildid"),
    lastOwner: lastOwner && /^\d{17}$/.test(lastOwner) ? lastOwner : null,
    manifestPath,
  };
}

function isWithin(base: string, target: string): boolean {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function findSteamAppsRoot(gameRoot: string): string | null {
  let current = path.resolve(gameRoot);
  for (let depth = 0; depth < 12; depth += 1) {
    if (path.basename(current).toLocaleLowerCase("en-US") === "steamapps") return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

async function readMatchingManifest(steamAppsRoot: string, gameRoot: string): Promise<SteamManifest | null> {
  const names = (await readdir(steamAppsRoot))
    .filter((name) => /^appmanifest_\d+\.acf$/i.test(name))
    .slice(0, 10_000);
  for (const name of names) {
    const manifestPath = path.join(steamAppsRoot, name);
    const manifest = parseSteamManifest(await readFile(manifestPath, "utf8"), manifestPath);
    if (!manifest) continue;
    if (isWithin(path.join(steamAppsRoot, "common", manifest.installDir), gameRoot)) return manifest;
  }
  return null;
}

export class SteamLibraryResolver implements SaveInstallResolverV2 {
  readonly resolverId = "steam-library";
  readonly resolverVersion = "1.0.0";
  readonly distributionKind = "steam-library" as const;

  async probe(input: SaveInstallResolverInput): Promise<GameInstallContextV2 | null> {
    const gameRoot = await validatedGameRoot(input.gameRoot);
    const steamAppsRoot = findSteamAppsRoot(gameRoot);
    if (!steamAppsRoot) return null;
    const manifest = await readMatchingManifest(steamAppsRoot, gameRoot);
    if (!manifest) {
      throw new NexusError("GAME_INSTALL_NOT_IDENTIFIED", "No Steam appmanifest matches the supplied game root.", {
        details: { gameRoot, steamAppsRoot },
      });
    }
    const explicit = selectedRecipe(input);
    const recipe = explicit ?? uniqueRecipe(
      input.recipes.findCandidates({ platform: "steam", platformAppId: manifest.appId }),
      { resolverId: this.resolverId, appId: manifest.appId },
    );
    assertRecipeSupportsResolver(recipe, this.resolverId);
    if (recipe.game.platformAppIds.steam !== manifest.appId) {
      throw new NexusError("SAVE_INSTALL_IDENTITY_AMBIGUOUS", "Steam appmanifest conflicts with the selected Recipe.", {
        details: {
          appId: manifest.appId,
          recipeId: recipe.recipeId,
          recipeAppId: recipe.game.platformAppIds.steam ?? null,
        },
      });
    }
    const anchor = await verifyRecipeAnchor({
      gameRoot,
      recipe,
      ...(input.peMetadataReader === undefined ? {} : { peMetadataReader: input.peMetadataReader }),
    });
    const steamRoot = path.dirname(steamAppsRoot);
    const accountHints = manifest.lastOwner ? [{
      kind: "steam_id64" as const,
      value: manifest.lastOwner,
      confidence: "probable" as const,
      evidence: "Steam appmanifest LastOwner is a syntactically valid SteamID64 account hint.",
    }] : [];
    const platformCandidateRoots = manifest.lastOwner
      ? [path.join(steamRoot, "userdata", manifest.lastOwner, manifest.appId)]
      : [];
    return buildInstallContextV2({
      resolverId: this.resolverId,
      resolverVersion: this.resolverVersion,
      distributionKind: this.distributionKind,
      gameRoot,
      anchor,
      platformAppId: manifest.appId,
      accountHints,
      platformCandidateRoots,
      additionalEvidence: [{
        kind: "steam-appmanifest",
        path: manifest.manifestPath,
        detail: `Matched Steam app ${manifest.appId}, build ${manifest.buildId ?? "unknown"}, installDir ${manifest.installDir}.`,
      }],
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  }
}
