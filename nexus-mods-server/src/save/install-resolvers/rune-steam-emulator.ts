import { readFile, stat } from "node:fs/promises";
import os from "node:os";
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

function iniValue(source: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*${escaped}\\s*=\\s*([^#;\\r\\n]+)`, "im").exec(source)?.[1]?.trim() ?? null;
}

export class RuneSteamEmulatorResolver implements SaveInstallResolverV2 {
  readonly resolverId = "rune-steam-emulator";
  readonly resolverVersion = "1.0.0";
  readonly distributionKind = "rune-steam-emulator" as const;

  async probe(input: SaveInstallResolverInput): Promise<GameInstallContextV2 | null> {
    const gameRoot = await validatedGameRoot(input.gameRoot);
    const iniPath = path.join(gameRoot, "steam_emu.ini");
    const runeAnchorPath = path.join(gameRoot, "steam_api64.rne");
    const [iniInfo, runeInfo] = await Promise.all([
      stat(iniPath).catch(() => null),
      stat(runeAnchorPath).catch(() => null),
    ]);
    if (!iniInfo?.isFile() || !runeInfo?.isFile()) return null;
    const source = await readFile(iniPath, "utf8");
    const appId = iniValue(source, "AppId");
    if (!appId || !/^\d+$/.test(appId)) {
      throw new NexusError("GAME_INSTALL_NOT_IDENTIFIED", "RUNE configuration has no valid AppId.", {
        details: { iniPath },
      });
    }
    const explicit = selectedRecipe(input);
    const recipe = explicit ?? uniqueRecipe(
      input.recipes.findCandidates({ platform: "steam", platformAppId: appId }),
      { resolverId: this.resolverId, appId },
    );
    assertRecipeSupportsResolver(recipe, this.resolverId);
    if (recipe.game.platformAppIds.steam !== appId) {
      throw new NexusError("SAVE_INSTALL_IDENTITY_AMBIGUOUS", "RUNE AppId conflicts with the selected Recipe.", {
        details: { appId, recipeId: recipe.recipeId, recipeAppId: recipe.game.platformAppIds.steam ?? null },
      });
    }
    const anchor = await verifyRecipeAnchor({
      gameRoot,
      recipe,
      ...(input.peMetadataReader === undefined ? {} : { peMetadataReader: input.peMetadataReader }),
      requirePeIdentity: true,
    });
    const accountId = iniValue(source, "AccountId");
    const accountHints = accountId && accountId !== "0" && /^\d+$/.test(accountId)
      ? [{
          kind: "emulator_account_id" as const,
          value: accountId,
          confidence: "probable" as const,
          evidence: "Explicit non-zero AccountId from RUNE steam_emu.ini; not asserted as SteamID64.",
        }]
      : [];
    const publicRoot = process.env.PUBLIC?.trim() || path.join(path.parse(os.homedir()).root, "Users", "Public");
    return buildInstallContextV2({
      resolverId: this.resolverId,
      resolverVersion: this.resolverVersion,
      distributionKind: this.distributionKind,
      gameRoot,
      anchor,
      platformAppId: appId,
      accountHints,
      platformCandidateRoots: [path.join(publicRoot, "Documents", "Steam", "RUNE", appId)],
      additionalEvidence: [
        { kind: "rune-config", path: iniPath, detail: `Matched RUNE AppId ${appId}; configuration contents were not retained.` },
        { kind: "rune-anchor", path: runeAnchorPath, detail: "Found steam_api64.rne distribution anchor." },
      ],
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  }
}
