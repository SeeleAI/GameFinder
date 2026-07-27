import type {
  CurrentStateInspection,
  GameInstance,
  GameProfile,
  InstallationRecord,
  InstallOperation,
  PackageAnalysis,
  PackageUnit
} from "./contracts.js";
import type { StagedPackage } from "./core/staging-manager.js";

export type AdapterMatchState = "matched" | "possible" | "ambiguous" | "unsupported" | "blocked";

export interface AdapterDescriptor {
  adapterId: string;
  adapterVersion: string;
  supportedOperatingSystems: ReadonlyArray<NodeJS.Platform>;
  supportedGameProfileIds: ReadonlyArray<string>;
  supportedLoaderIds: ReadonlyArray<string>;
  capabilities: {
    install: boolean;
    update: boolean;
    staticVerification: boolean;
    runtimeVerification: boolean;
    uninstallVerification: boolean;
  };
}

export interface AdapterMatchResult {
  adapterId: string;
  adapterVersion: string;
  state: AdapterMatchState;
  confidence: number;
  positiveSignals: string[];
  negativeSignals: string[];
  missingEvidence: string[];
  requiresUserChoice: boolean;
  packageUnitIds: string[];
}

export interface AdapterPackageContext {
  analysis: PackageAnalysis;
  profile: GameProfile;
  instance: GameInstance;
  stagedPackage?: StagedPackage;
}

export interface AdapterInstanceCompatibility {
  state: "compatible" | "incompatible" | "dependency-missing" | "ambiguous";
  loaderId: string | null;
  warnings: string[];
  blockingReasons: string[];
}

export interface AdapterPreflightResult {
  ok: boolean;
  warnings: string[];
  blockingReasons: string[];
  requiredProcessesStopped: string[];
}

export interface AdapterPlanDraft {
  packageUnit: PackageUnit;
  operations: InstallOperation[];
  warnings: string[];
  verificationRequirements: string[];
}

export interface AdapterVerificationResult {
  state: "passed" | "failed" | "not-run" | "blocked";
  summary: string;
  evidence: string[];
  warnings: string[];
}

export interface InstallAdapter {
  readonly descriptor: AdapterDescriptor;

  probePackage(context: AdapterPackageContext): Promise<AdapterMatchResult>;

  probeInstance(
    context: AdapterPackageContext,
    match: AdapterMatchResult
  ): Promise<AdapterInstanceCompatibility>;

  preflight(
    context: AdapterPackageContext,
    match: AdapterMatchResult
  ): Promise<AdapterPreflightResult>;

  buildPlan(
    context: AdapterPackageContext,
    match: AdapterMatchResult
  ): Promise<AdapterPlanDraft>;

  verifyStatic(
    record: InstallationRecord,
    inspection: CurrentStateInspection,
    profile: GameProfile,
    instance: GameInstance
  ): Promise<AdapterVerificationResult>;

  verifyRuntime(
    record: InstallationRecord,
    profile: GameProfile,
    instance: GameInstance
  ): Promise<AdapterVerificationResult>;

  verifyUninstall(
    record: InstallationRecord,
    inspection: CurrentStateInspection,
    profile: GameProfile,
    instance: GameInstance
  ): Promise<AdapterVerificationResult>;
}
