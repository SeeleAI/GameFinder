import os from "node:os";
import path from "node:path";

import type { SaveEnvironment } from "../context/environment.js";
import type { WindowsSaveEnvironmentV2 } from "./types.js";

export function windowsSaveEnvironmentV2(
  overrides: (Partial<SaveEnvironment> & {
    documents?: string;
    savedGames?: string;
    localLow?: string;
    publicDocuments?: string;
  }) = {},
): WindowsSaveEnvironmentV2 {
  const userProfile = overrides.userProfile ?? process.env.USERPROFILE?.trim() ?? os.homedir();
  const localAppData = overrides.localAppData ?? process.env.LOCALAPPDATA?.trim() ?? path.join(userProfile, "AppData", "Local");
  return {
    userProfile: path.resolve(userProfile),
    documents: path.resolve(overrides.documents ?? path.join(userProfile, "Documents")),
    savedGames: path.resolve(overrides.savedGames ?? path.join(userProfile, "Saved Games")),
    appData: path.resolve(overrides.appData ?? process.env.APPDATA?.trim() ?? path.join(userProfile, "AppData", "Roaming")),
    localAppData: path.resolve(localAppData),
    localLow: path.resolve(overrides.localLow ?? path.join(path.dirname(localAppData), "LocalLow")),
    publicDocuments: path.resolve(overrides.publicDocuments ?? path.join(process.env.PUBLIC?.trim() ?? path.join(path.parse(userProfile).root, "Users", "Public"), "Documents")),
  };
}
