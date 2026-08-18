import os from "node:os";
import path from "node:path";

import { NexusError } from "../../errors.js";

export interface SaveEnvironment {
  platform: NodeJS.Platform;
  appData: string | null;
  localAppData: string | null;
  userProfile: string;
  username: string;
}

export function currentSaveEnvironment(): SaveEnvironment {
  return {
    platform: process.platform,
    appData: process.env.APPDATA?.trim() || null,
    localAppData: process.env.LOCALAPPDATA?.trim() || null,
    userProfile: process.env.USERPROFILE?.trim() || os.homedir(),
    username: process.env.USERNAME?.trim() || os.userInfo().username,
  };
}

export function assertWindowsSaveEnvironment(
  environment: SaveEnvironment,
): void {
  if (environment.platform !== "win32") {
    throw new NexusError(
      "SAVE_ADAPTER_UNSUPPORTED",
      "Game save discovery currently supports Windows only.",
      { details: { platform: environment.platform } },
    );
  }
  if (!environment.appData || !path.isAbsolute(environment.appData)) {
    throw new NexusError(
      "SAVE_CONTEXT_NOT_FOUND",
      "APPDATA is unavailable, so Windows save roots cannot be expanded.",
    );
  }
  if (!path.isAbsolute(environment.userProfile)) {
    throw new NexusError(
      "SAVE_CONTRACT_INVALID",
      "The Windows user profile path must be absolute.",
    );
  }
}

export function expandSaveTemplate(
  template: string,
  environment: SaveEnvironment,
  steamId64: string | null,
): string {
  assertWindowsSaveEnvironment(environment);
  let expanded = template
    .replaceAll("%APPDATA%", environment.appData ?? "")
    .replaceAll("%LOCALAPPDATA%", environment.localAppData ?? "")
    .replaceAll("%USERPROFILE%", environment.userProfile);
  if (expanded.includes("{STEAM_ID64}")) {
    if (!steamId64) {
      throw new NexusError(
        "SAVE_CONTEXT_AMBIGUOUS",
        "A Steam account is required to expand this save-root template.",
        { details: { template } },
      );
    }
    expanded = expanded.replaceAll("{STEAM_ID64}", steamId64);
  }
  expanded = expanded.replaceAll("/", path.sep);
  if (!path.isAbsolute(expanded)) {
    throw new NexusError(
      "SAVE_CONTRACT_INVALID",
      "Expanded save paths must be absolute.",
      { details: { template, expanded } },
    );
  }
  return path.resolve(expanded);
}
