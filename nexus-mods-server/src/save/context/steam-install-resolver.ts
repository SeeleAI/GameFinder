import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import type {
  GameInstallContext,
  GameSaveProfile,
} from "../contracts.js";
import { gameInstallContextSchema } from "../contracts.js";
import type { GameSaveProfileRegistry } from "../profiles/registry.js";

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
  return (
    new RegExp(`"${escaped}"\\s+"([^"]*)"`, "i").exec(source)?.[1] ?? null
  );
}

function parseSteamManifest(
  source: string,
  manifestPath: string,
): SteamManifest | null {
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
    lastOwner:
      lastOwner && /^\d{17}$/.test(lastOwner) ? lastOwner : null,
    manifestPath,
  };
}

function isWithinWindows(base: string, target: string): boolean {
  const relative = path.win32.relative(
    path.win32.resolve(base),
    path.win32.resolve(target),
  );
  return (
    relative === "" ||
    (!relative.startsWith("..\\") &&
      relative !== ".." &&
      !path.win32.isAbsolute(relative))
  );
}

async function findSteamAppsRoot(gameRoot: string): Promise<string | null> {
  let current = path.resolve(gameRoot);
  for (let depth = 0; depth < 10; depth += 1) {
    if (path.basename(current).toLowerCase() === "steamapps") return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

async function readMatchingManifest(
  steamAppsRoot: string,
  gameRoot: string,
): Promise<SteamManifest | null> {
  const names = (await readdir(steamAppsRoot))
    .filter((name) => /^appmanifest_\d+\.acf$/i.test(name))
    .slice(0, 10_000);
  for (const name of names) {
    const manifestPath = path.join(steamAppsRoot, name);
    const parsed = parseSteamManifest(
      await readFile(manifestPath, "utf8"),
      manifestPath,
    );
    if (!parsed) continue;
    const installRoot = path.join(
      steamAppsRoot,
      "common",
      parsed.installDir,
    );
    if (isWithinWindows(installRoot, gameRoot)) return parsed;
  }
  return null;
}

async function verifyProfileAnchor(
  gameRoot: string,
  profile: GameSaveProfile | null,
): Promise<string | null> {
  if (!profile) {
    const executable = (await readdir(gameRoot)).find((name) =>
      name.toLowerCase().endsWith(".exe"),
    );
    return executable ? path.join(gameRoot, executable) : null;
  }
  for (const anchor of profile.discovery.executableAnchors) {
    const absolutePath = path.join(gameRoot, ...anchor.split("/"));
    const exists = await stat(absolutePath)
      .then((info) => info.isFile())
      .catch(() => false);
    if (exists) return absolutePath;
  }
  return null;
}

export async function probeSteamGameInstall(input: {
  gameRoot: string;
  profiles: GameSaveProfileRegistry;
  now?: Date;
}): Promise<GameInstallContext> {
  if (!path.isAbsolute(input.gameRoot)) {
    throw new NexusError(
      "SAVE_CONTRACT_INVALID",
      "The game root must be an absolute path.",
      { details: { gameRoot: input.gameRoot } },
    );
  }
  const gameRoot = path.resolve(input.gameRoot);
  const rootInfo = await stat(gameRoot).catch((error: unknown) => {
    throw new NexusError(
      "GAME_INSTALL_NOT_IDENTIFIED",
      "The selected game root does not exist.",
      { cause: error, details: { gameRoot } },
    );
  });
  if (!rootInfo.isDirectory()) {
    throw new NexusError(
      "GAME_INSTALL_NOT_IDENTIFIED",
      "The selected game root is not a directory.",
      { details: { gameRoot } },
    );
  }
  const steamAppsRoot = await findSteamAppsRoot(gameRoot);
  if (!steamAppsRoot) {
    throw new NexusError(
      "GAME_INSTALL_NOT_IDENTIFIED",
      "The game root is not inside a Steam steamapps library.",
      { details: { gameRoot } },
    );
  }
  const manifest = await readMatchingManifest(steamAppsRoot, gameRoot);
  if (!manifest) {
    throw new NexusError(
      "GAME_INSTALL_NOT_IDENTIFIED",
      "No Steam appmanifest matches the supplied game root.",
      { details: { gameRoot, steamAppsRoot } },
    );
  }
  const profile = input.profiles.findBySteamAppId(manifest.appId);
  const anchorPath = await verifyProfileAnchor(gameRoot, profile);
  if (!anchorPath) {
    throw new NexusError(
      "GAME_INSTALL_NOT_IDENTIFIED",
      "The supplied game root lacks a recognized executable anchor.",
      {
        details: {
          gameRoot,
          appId: manifest.appId,
          expectedAnchors:
            profile?.discovery.executableAnchors ?? ["*.exe"],
        },
      },
    );
  }
  const now = (input.now ?? new Date()).toISOString();
  const withoutHash = {
    schemaVersion: 1 as const,
    installContextId: randomUUID(),
    gameRoot,
    platform: "windows" as const,
    store: "steam" as const,
    game: {
      canonicalId: profile?.game.canonicalId ?? `steam:${manifest.appId}`,
      displayName: profile?.game.displayName ?? manifest.name,
      storeAppId: manifest.appId,
    },
    storeMetadata: {
      steam: {
        appId: manifest.appId,
        buildId: manifest.buildId,
        lastOwner: manifest.lastOwner,
        installDir: manifest.installDir,
        manifestPath: manifest.manifestPath,
      },
    },
    installEvidence: [
      {
        kind: "steam-appmanifest" as const,
        path: manifest.manifestPath,
        detail: `Matched Steam app ${manifest.appId}, build ${manifest.buildId ?? "unknown"}, installDir ${manifest.installDir}.`,
        observedAt: now,
      },
      {
        kind: "executable-anchor" as const,
        path: anchorPath,
        detail: `Found executable anchor ${path.basename(anchorPath)}.`,
        observedAt: now,
      },
    ],
    confidence: "confirmed" as const,
    createdAt: now,
  };
  return gameInstallContextSchema.parse({
    ...withoutHash,
    contextHash: sha256CanonicalJson(withoutHash),
  });
}
