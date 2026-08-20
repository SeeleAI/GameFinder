import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SaveInstallResolverRegistryV2,
} from "../src/save/install-resolvers/resolver-registry.js";
import type { PeMetadataReader } from "../src/save/install-resolvers/types.js";
import { GameSaveRecipeRegistryV2 } from "../src/save/recipes/recipe-registry.js";
import { SaveService } from "../src/save/save-service.js";
import { verifyGameInstallContextV2Hash } from "../src/save/v2/contracts.js";

const temporaryDirectories: string[] = [];
const now = new Date("2026-08-20T00:00:00.000Z");

const peMetadataReader: PeMetadataReader = async (executablePath) => {
  const name = path.basename(executablePath).toLocaleLowerCase("en-US");
  if (name === "eldenring.exe") {
    return {
      productName: "ELDEN RING",
      fileDescription: "ELDEN RING",
      fileVersion: "1.16.0",
      productVersion: "1.16.0",
    };
  }
  if (name === "ghostoftsushima.exe") {
    return {
      productName: "Ghost of Tsushima DIRECTOR'S CUT",
      fileDescription: "Ghost of Tsushima DIRECTOR'S CUT",
      fileVersion: "1053.7.0809.1937",
      productVersion: "1053.7.0809.1937",
    };
  }
  return null;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

describe("save V2 installation resolvers", () => {
  it("identifies a Steam library install and emits a SteamID64 account hint", async () => {
    const root = await temporaryRoot("save-v2-steam-");
    const steamApps = path.join(root, "Steam", "steamapps");
    const gameRoot = path.join(steamApps, "common", "ELDEN RING", "Game");
    await mkdir(gameRoot, { recursive: true });
    await writeFile(path.join(gameRoot, "eldenring.exe"), "steam fixture");
    await writeFile(path.join(steamApps, "appmanifest_1245620.acf"), `
"AppState"
{
  "appid" "1245620"
  "name" "ELDEN RING"
  "installdir" "ELDEN RING"
  "buildid" "20000001"
  "LastOwner" "76561198127396738"
}
`);
    const recipes = await GameSaveRecipeRegistryV2.fromDirectory();
    const context = await new SaveInstallResolverRegistryV2().probe({
      gameRoot,
      recipes,
      peMetadataReader,
      now,
    });

    expect(context.distributionKind).toBe("steam-library");
    expect(context.recipe?.recipeId).toBe("elden-ring-windows");
    expect(context.accountHints).toEqual([expect.objectContaining({
      kind: "steam_id64",
      value: "76561198127396738",
      confidence: "probable",
    })]);
    expect(context.platformCandidateRoots[0]).toBe(
      path.join(root, "Steam", "userdata", "76561198127396738", "1245620"),
    );
    expect(verifyGameInstallContextV2Hash(context)).toBe(true);
  });

  it("identifies RUNE without converting a default AccountId into a Steam identity", async () => {
    const gameRoot = await temporaryRoot("save-v2-rune-");
    await Promise.all([
      writeFile(path.join(gameRoot, "GhostOfTsushima.exe"), "rune fixture"),
      writeFile(path.join(gameRoot, "steam_api64.rne"), "rune anchor"),
      writeFile(path.join(gameRoot, "steam_emu.ini"), "AppId=2215430\n;AccountId=0\n"),
    ]);
    const recipes = await GameSaveRecipeRegistryV2.fromDirectory();
    const context = await new SaveInstallResolverRegistryV2().probe({
      gameRoot,
      recipes,
      peMetadataReader,
      now,
    });

    expect(context.distributionKind).toBe("rune-steam-emulator");
    expect(context.recipe?.recipeId).toBe("ghost-of-tsushima-directors-cut-windows");
    expect(context.accountHints).toEqual([]);
    expect(context.installEvidence.map((evidence) => evidence.detail).join("\n"))
      .not.toContain("AccountId=0");
    expect(verifyGameInstallContextV2Hash(context)).toBe(true);
  });

  it("classifies an explicit RUNE AccountId only as an emulator account", async () => {
    const gameRoot = await temporaryRoot("save-v2-rune-account-");
    await Promise.all([
      writeFile(path.join(gameRoot, "GhostOfTsushima.exe"), "rune fixture"),
      writeFile(path.join(gameRoot, "steam_api64.rne"), "rune anchor"),
      writeFile(path.join(gameRoot, "steam_emu.ini"), "AppId=2215430\nAccountId=76561197960271872\n"),
    ]);
    const recipes = await GameSaveRecipeRegistryV2.fromDirectory();
    const context = await new SaveInstallResolverRegistryV2().probe({
      gameRoot,
      recipes,
      peMetadataReader,
      now,
    });

    expect(context.accountHints).toEqual([expect.objectContaining({
      kind: "emulator_account_id",
      value: "76561197960271872",
    })]);
    expect(context.accountHints.some((hint) => hint.kind === "steam_id64")).toBe(false);
  });

  it("uses manual PE identity only as a fallback and rejects a Recipe/resolver mismatch", async () => {
    const gameRoot = await temporaryRoot("save-v2-manual-");
    await writeFile(path.join(gameRoot, "GhostOfTsushima.exe"), "manual fixture");
    const recipes = await GameSaveRecipeRegistryV2.fromDirectory();
    const registry = new SaveInstallResolverRegistryV2();
    const context = await registry.probe({ gameRoot, recipes, peMetadataReader, now });

    expect(context.distributionKind).toBe("manual-pe");
    expect(context.recipe?.recipeId).toBe("ghost-of-tsushima-directors-cut-windows");
    expect(verifyGameInstallContextV2Hash(context)).toBe(true);

    await expect(registry.probe({
      gameRoot,
      recipes,
      recipeId: "elden-ring-windows",
      resolverHint: "manual-pe",
      peMetadataReader,
      now,
    })).rejects.toMatchObject({ code: "SAVE_INSTALL_IDENTITY_AMBIGUOUS" });
  });

  it("publishes and reads a RUNE Game Install Context V2 through SaveService", async () => {
    const root = await temporaryRoot("save-v2-service-");
    const gameRoot = path.join(root, "game");
    const managerRoot = path.join(root, "manager");
    await mkdir(gameRoot, { recursive: true });
    await Promise.all([
      writeFile(path.join(gameRoot, "GhostOfTsushima.exe"), "rune fixture"),
      writeFile(path.join(gameRoot, "steam_api64.rne"), "rune anchor"),
      writeFile(path.join(gameRoot, "steam_emu.ini"), "AppId=2215430\nAccountId=76561197960271872\n"),
    ]);
    const service = await SaveService.create({ managerRoot, peMetadataReader });
    const context = await service.probeGameInstall({
      gameRoot,
      resolverHint: "rune-steam-emulator",
    });

    expect(context).toMatchObject({
      schemaVersion: 2,
      distributionKind: "rune-steam-emulator",
      recipe: { recipeId: "ghost-of-tsushima-directors-cut-windows" },
    });
    expect(await service.getGameInstallContext(context.installContextId)).toEqual(context);
  });
});
