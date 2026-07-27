import { createHash } from "node:crypto";
import { access, stat } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import type { GameInstance, GameProfile } from "../contracts.js";
import { gameInstanceSchema, gameProfileSchema } from "../contracts.js";

export const STARDEW_VALLEY_PROFILE: GameProfile = gameProfileSchema.parse({
  schemaVersion: 1,
  profileId: "stardew-valley",
  profileVersion: "1.0.0",
  gameName: "Stardew Valley",
  nexusDomainName: "stardewvalley",
  supportedOperatingSystems: ["win32"],
  discovery: {
    executableAnchors: ["Stardew Valley.exe"],
    steamAppIds: [413150],
  },
  filesystem: {
    writableRoots: ["Mods"],
    protectedRoots: ["Content"],
    liveModRoots: ["Mods"],
    stateLocationPolicy: "local-app-data",
  },
  loaders: [
    {
      loaderId: "smapi",
      detectionPaths: ["StardewModdingAPI.exe"],
      modRoots: ["Mods"],
      logLocations: ["%APPDATA%/StardewValley/ErrorLogs/SMAPI-latest.txt"],
    },
  ],
  runtime: {
    processNames: ["Stardew Valley.exe", "StardewModdingAPI.exe"],
    lockSensitiveProcessNames: ["Stardew Valley.exe", "StardewModdingAPI.exe"],
  },
});

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function deterministicProvisionalInstanceId(
  profileId: string,
  gameRoot: string,
): string {
  const bytes = createHash("sha256")
    .update(`${profileId}\0${gameRoot.toLowerCase()}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export async function probeStardewValleyInstance(input: {
  gameRoot: string;
  instanceId?: string;
  platform?: GameInstance["platform"];
  platformAppId?: string | null;
}): Promise<GameInstance> {
  if (!path.isAbsolute(input.gameRoot)) {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      "The Stardew Valley game root must be absolute.",
    );
  }
  const gameRoot = path.resolve(input.gameRoot);
  const gameRootInfo = await stat(gameRoot).catch((error: unknown) => {
    throw new NexusError(
      "GAME_INSTANCE_NOT_FOUND",
      "The selected Stardew Valley game root does not exist.",
      { cause: error, details: { gameRoot } },
    );
  });
  if (!gameRootInfo.isDirectory()) {
    throw new NexusError(
      "GAME_INSTANCE_NOT_FOUND",
      "The selected Stardew Valley game root is not a directory.",
      { details: { gameRoot } },
    );
  }

  const executablePath = path.join(gameRoot, "Stardew Valley.exe");
  const contentPath = path.join(gameRoot, "Content");
  const [hasExecutable, hasContentDirectory] = await Promise.all([
    exists(executablePath),
    stat(contentPath)
      .then((info) => info.isDirectory())
      .catch(() => false),
  ]);
  if (!hasExecutable || !hasContentDirectory) {
    throw new NexusError(
      "GAME_INSTANCE_NOT_FOUND",
      "The selected directory lacks the Stardew Valley executable or Content anchor.",
      {
        details: {
          gameRoot,
          executableAnchorFound: hasExecutable,
          contentAnchorFound: hasContentDirectory,
        },
      },
    );
  }

  const smapiPath = path.join(gameRoot, "StardewModdingAPI.exe");
  const smapiDetected = await exists(smapiPath);
  const executableFingerprint = createHash("sha256")
    .update(`${gameRoot}\0Stardew Valley.exe`)
    .digest("hex");

  return gameInstanceSchema.parse({
    schemaVersion: 1,
    instanceId:
      input.instanceId ??
      deterministicProvisionalInstanceId(
        STARDEW_VALLEY_PROFILE.profileId,
        gameRoot,
      ),
    profileId: STARDEW_VALLEY_PROFILE.profileId,
    profileVersion: STARDEW_VALLEY_PROFILE.profileVersion,
    gameRoot,
    platform: input.platform ?? "manual",
    platformAppId: input.platformAppId ?? null,
    gameVersion: null,
    anchorFingerprints: [executableFingerprint],
    detectedLoaders: [
      {
        loaderId: "smapi",
        state: smapiDetected ? "detected" : "not-detected",
        version: null,
        absolutePath: smapiDetected ? smapiPath : null,
        modRoots: smapiDetected ? [path.join(gameRoot, "Mods")] : [],
        evidence: smapiDetected
          ? [`Found ${smapiPath}.`]
          : [`Did not find ${smapiPath}.`],
      },
    ],
    verifiedAt: new Date().toISOString(),
  });
}
