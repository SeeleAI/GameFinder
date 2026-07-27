import { NexusError } from "../../errors.js";
import type {
  AdapterInstanceCompatibility,
  AdapterMatchResult,
  AdapterPackageContext,
  AdapterPlanDraft,
  AdapterPreflightResult,
  AdapterVerificationResult,
  InstallAdapter,
} from "../adapter.js";
import type {
  CurrentStateInspection,
  GameInstance,
  GameProfile,
  InstallationRecord,
} from "../contracts.js";

export const AGENTIC_FILE_METHOD_ADAPTER_ID = "agentic-v2-file-method";
export const AGENTIC_FILE_METHOD_ADAPTER_VERSION = "2.0.0-m2";

function genericVerification(
  inspection: CurrentStateInspection,
): AdapterVerificationResult {
  const failures = inspection.paths.filter(
    (pathState) => pathState.state !== "unchanged",
  );
  return {
    state: failures.length === 0 ? "passed" : "failed",
    summary:
      failures.length === 0
        ? "All Agentic V2 file-operation targets match their committed post-state."
        : `${failures.length} Agentic V2 file-operation targets differ from their committed post-state.`,
    evidence: inspection.paths.map(
      (pathState) => `${pathState.targetRelativePath}: ${pathState.state}`,
    ),
    warnings: [],
  };
}

export class AgenticFileMethodAdapter implements InstallAdapter {
  readonly descriptor = {
    adapterId: AGENTIC_FILE_METHOD_ADAPTER_ID,
    adapterVersion: AGENTIC_FILE_METHOD_ADAPTER_VERSION,
    supportedOperatingSystems: ["win32", "linux", "darwin"] as const,
    supportedGameProfileIds: [] as const,
    supportedLoaderIds: [] as const,
    capabilities: {
      install: true,
      update: false,
      staticVerification: true,
      runtimeVerification: false,
      uninstallVerification: true,
    },
  };

  async probePackage(
    _context: AdapterPackageContext,
  ): Promise<AdapterMatchResult> {
    return {
      adapterId: this.descriptor.adapterId,
      adapterVersion: this.descriptor.adapterVersion,
      state: "unsupported",
      confidence: 0,
      positiveSignals: [],
      negativeSignals: [
        "This compatibility adapter never participates in V1 package matching.",
      ],
      missingEvidence: [],
      requiresUserChoice: false,
      packageUnitIds: [],
    };
  }

  async probeInstance(
    _context: AdapterPackageContext,
    _match: AdapterMatchResult,
  ): Promise<AdapterInstanceCompatibility> {
    return {
      state: "compatible",
      loaderId: null,
      warnings: [],
      blockingReasons: [],
    };
  }

  async preflight(
    _context: AdapterPackageContext,
    _match: AdapterMatchResult,
  ): Promise<AdapterPreflightResult> {
    return {
      ok: true,
      warnings: [],
      blockingReasons: [],
      requiredProcessesStopped: [],
    };
  }

  async buildPlan(
    _context: AdapterPackageContext,
    _match: AdapterMatchResult,
  ): Promise<AdapterPlanDraft> {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      "Agentic V2 file operations must be planned through Proposal validation, not a V1 Adapter.",
    );
  }

  async verifyStatic(
    _record: InstallationRecord,
    inspection: CurrentStateInspection,
    _profile: GameProfile,
    _instance: GameInstance,
  ): Promise<AdapterVerificationResult> {
    return genericVerification(inspection);
  }

  async verifyRuntime(
    _record: InstallationRecord,
    _profile: GameProfile,
    _instance: GameInstance,
  ): Promise<AdapterVerificationResult> {
    return {
      state: "not-run",
      summary:
        "Agentic V2 M2 does not yet execute method-specific runtime verification.",
      evidence: [],
      warnings: [],
    };
  }

  async verifyUninstall(
    _record: InstallationRecord,
    inspection: CurrentStateInspection,
    _profile: GameProfile,
    _instance: GameInstance,
  ): Promise<AdapterVerificationResult> {
    const remaining = inspection.paths.filter(
      (pathState) => pathState.actualState.kind !== "absent",
    );
    return {
      state: remaining.length === 0 ? "passed" : "failed",
      summary:
        remaining.length === 0
          ? "No Agentic V2 managed paths remain."
          : `${remaining.length} Agentic V2 managed paths remain.`,
      evidence: remaining.map((pathState) => pathState.targetRelativePath),
      warnings: [],
    };
  }
}
