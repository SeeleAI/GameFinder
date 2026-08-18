import type { GameSaveProfile } from "../contracts.js";
import { gameSaveProfileSchema } from "../contracts.js";

export const ELDEN_RING_STEAM_PC_PROFILE: GameSaveProfile =
  gameSaveProfileSchema.parse({
    schemaVersion: 1,
    profileId: "elden-ring-steam-pc",
    profileVersion: "1.0.0",
    game: {
      canonicalId: "steam:1245620",
      displayName: "ELDEN RING",
      store: "steam",
      storeAppId: "1245620",
    },
    supportedPlatforms: ["windows"],
    sources: {
      nexusDomainName: "eldenring",
      speedrunGameSlug: "eldenring",
    },
    discovery: {
      executableAnchors: ["eldenring.exe"],
      saveRootTemplates: ["%APPDATA%/EldenRing/{STEAM_ID64}"],
      probeRootTemplates: ["%APPDATA%/EldenRing"],
      accountDirectoryPattern: "^\\d{17}$",
    },
    saveUnits: [
      {
        unitId: "vanilla-main",
        essential: ["ER0000.sl2"],
        companions: ["ER0000.sl2.bak"],
        auxiliary: ["steam_autocloud.vdf"],
        managedPaths: [
          "ER0000.sl2",
          "ER0000.sl2.bak",
          "steam_autocloud.vdf",
        ],
      },
    ],
    format: {
      kind: "game-specific-container",
      adapterId: "elden-ring-steam-pc",
    },
    runtime: {
      processNames: ["eldenring.exe", "start_protected_game.exe"],
      lockSensitiveProcessNames: [
        "eldenring.exe",
        "start_protected_game.exe",
        "steam.exe",
      ],
    },
  });
