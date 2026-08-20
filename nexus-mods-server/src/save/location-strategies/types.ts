import type { GameInstallContextV2, GameSaveRecipe } from "../v2/contracts.js";

export interface WindowsSaveEnvironmentV2 {
  userProfile: string;
  documents: string;
  savedGames: string;
  appData: string;
  localAppData: string;
  localLow: string;
  publicDocuments: string;
}

export interface SaveRootCandidateV2 {
  strategyId: string;
  absolutePath: string;
  role: "primary" | "secondary" | "variant";
  accountDirectory: string | null;
  accountKind: "steam_id64" | "emulator_account_id" | "platform_account_id" | "opaque_directory_key" | "unknown" | "none";
  evidence: string;
}

export interface SaveLocationStrategyV2 {
  readonly strategyId: string;
  readonly strategyVersion: string;
  candidates(input: {
    install: Readonly<GameInstallContextV2>;
    recipe: Readonly<GameSaveRecipe>;
    parameters: Readonly<Record<string, string | number | boolean>>;
    environment: WindowsSaveEnvironmentV2;
  }): Promise<ReadonlyArray<SaveRootCandidateV2>>;
}
