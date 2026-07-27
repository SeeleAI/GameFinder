import { randomUUID } from "node:crypto";
import path from "node:path";

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
  PackageUnit,
} from "../contracts.js";
import { normalizeManagedRelativePath } from "../path-policy.js";

export const SMAPI_FOLDER_ADAPTER_ID = "smapi-folder-mod";
export const SMAPI_FOLDER_ADAPTER_VERSION = "1.0.0";

function selectedPackage(
  context: AdapterPackageContext,
  match: AdapterMatchResult,
): PackageUnit {
  if (match.packageUnitIds.length !== 1 || !match.packageUnitIds[0]) {
    throw new NexusError(
      "ADAPTER_AMBIGUOUS",
      "The SMAPI Adapter requires exactly one selected package unit.",
      { details: { packageUnitIds: match.packageUnitIds } },
    );
  }
  const unit = context.analysis.packages.find(
    (candidate) => candidate.packageUnitId === match.packageUnitIds[0],
  );
  if (!unit) {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      "The Adapter match references an unknown package unit.",
    );
  }
  return unit;
}

function relevantAmbiguity(
  context: AdapterPackageContext,
  packageUnitId: string,
): boolean {
  return context.analysis.ambiguities.some(
    (ambiguity) =>
      ambiguity.packageUnitIds.length === 0 ||
      ambiguity.packageUnitIds.includes(packageUnitId),
  );
}

export class SmapiFolderModAdapter implements InstallAdapter {
  readonly descriptor = {
    adapterId: SMAPI_FOLDER_ADAPTER_ID,
    adapterVersion: SMAPI_FOLDER_ADAPTER_VERSION,
    supportedOperatingSystems: ["win32"] as const,
    supportedGameProfileIds: ["stardew-valley"] as const,
    supportedLoaderIds: ["smapi"] as const,
    capabilities: {
      install: true,
      update: false,
      staticVerification: true,
      runtimeVerification: false,
      uninstallVerification: true,
    },
  };

  async probePackage(
    context: AdapterPackageContext,
  ): Promise<AdapterMatchResult> {
    const supported = context.analysis.packages.filter(
      (unit) =>
        unit.packageType === "loader-plugin" ||
        unit.packageType === "content-pack",
    );
    const ambiguousUnits = supported.filter((unit) =>
      relevantAmbiguity(context, unit.packageUnitId),
    );
    const profileSupported = this.descriptor.supportedGameProfileIds.includes(
      context.profile.profileId as "stardew-valley",
    );

    let state: AdapterMatchResult["state"];
    if (!profileSupported) state = "unsupported";
    else if (supported.length === 0) state = "unsupported";
    else if (supported.length > 1 || ambiguousUnits.length > 0) {
      state = "ambiguous";
    } else state = "matched";

    return {
      adapterId: this.descriptor.adapterId,
      adapterVersion: this.descriptor.adapterVersion,
      state,
      confidence: state === "matched" ? 0.99 : state === "ambiguous" ? 0.65 : 0,
      positiveSignals: supported.flatMap((unit) => unit.positiveSignals),
      negativeSignals: [
        ...(profileSupported
          ? []
          : [`Game Profile ${context.profile.profileId} is not supported.`]),
        ...supported.flatMap((unit) => unit.negativeSignals),
      ],
      missingEvidence:
        supported.length === 0
          ? ["A valid SMAPI EntryDll or ContentPackFor manifest."]
          : [],
      requiresUserChoice: supported.length > 1,
      packageUnitIds: supported.map((unit) => unit.packageUnitId),
    };
  }

  async probeInstance(
    context: AdapterPackageContext,
    match: AdapterMatchResult,
  ): Promise<AdapterInstanceCompatibility> {
    selectedPackage(context, match);
    const loader = context.instance.detectedLoaders.find(
      (candidate) => candidate.loaderId === "smapi",
    );
    if (!loader || loader.state === "not-detected") {
      return {
        state: "dependency-missing",
        loaderId: "smapi",
        warnings: [],
        blockingReasons: [
          "SMAPI is required but was not detected in the selected game instance.",
        ],
      };
    }
    if (loader.state === "ambiguous") {
      return {
        state: "ambiguous",
        loaderId: "smapi",
        warnings: [],
        blockingReasons: [
          "The selected game instance has an ambiguous SMAPI installation.",
        ],
      };
    }
    return {
      state: "compatible",
      loaderId: "smapi",
      warnings:
        loader.version === null
          ? ["SMAPI was detected, but its version could not be determined."]
          : [],
      blockingReasons: [],
    };
  }

  async preflight(
    context: AdapterPackageContext,
    match: AdapterMatchResult,
  ): Promise<AdapterPreflightResult> {
    const compatibility = await this.probeInstance(context, match);
    return {
      ok: compatibility.state === "compatible",
      warnings: compatibility.warnings,
      blockingReasons: compatibility.blockingReasons,
      requiredProcessesStopped:
        context.profile.runtime.lockSensitiveProcessNames,
    };
  }

  async buildPlan(
    context: AdapterPackageContext,
    match: AdapterMatchResult,
  ): Promise<AdapterPlanDraft> {
    const unit = selectedPackage(context, match);
    const staged = context.stagedPackage;
    if (!staged) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "The SMAPI Adapter requires a staged package before planning.",
      );
    }
    if (
      staged.packageRoot !== unit.packageRoot ||
      staged.archive.sha256 !== context.analysis.archive.sha256
    ) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "The staged package does not match Package Analysis.",
      );
    }
    if (unit.packageRoot === ".") {
      throw new NexusError(
        "ADAPTER_AMBIGUOUS",
        "A root-level SMAPI package has no trustworthy target folder name.",
      );
    }
    const folderName = path.posix.basename(unit.packageRoot);
    const targetRelativePath = normalizeManagedRelativePath(
      `Mods/${folderName}`,
      "win32",
    );
    return {
      packageUnit: unit,
      operations: [
        {
          operationId: randomUUID(),
          kind: "install_tree",
          sourceRelativePath: unit.packageRoot,
          sourceTreeHash: staged.treeHash,
          ownershipMode: "installed_file_set",
          targetRelativePath,
          expectedPreState: { kind: "absent" },
          expectedPostState: {
            kind: "directory",
            treeHash: staged.treeHash,
            entries: staged.files.length + staged.directories.length,
          },
        },
      ],
      warnings: [],
      verificationRequirements: [
        "The installed directory tree must match the staged source tree hash.",
        "manifest.json and every declared EntryDll must remain present.",
      ],
    };
  }

  async verifyStatic(
    _record: InstallationRecord,
    inspection: CurrentStateInspection,
    _profile: GameProfile,
    _instance: GameInstance,
  ): Promise<AdapterVerificationResult> {
    const failures = inspection.paths.filter(
      (pathState) => pathState.state !== "unchanged",
    );
    return {
      state: failures.length === 0 ? "passed" : "failed",
      summary:
        failures.length === 0
          ? "All recorded SMAPI package paths match their post-state."
          : `${failures.length} recorded SMAPI package paths differ from their post-state.`,
      evidence: inspection.paths.map(
        (pathState) => `${pathState.targetRelativePath}: ${pathState.state}`,
      ),
      warnings: [],
    };
  }

  async verifyRuntime(
    _record: InstallationRecord,
    _profile: GameProfile,
    _instance: GameInstance,
  ): Promise<AdapterVerificationResult> {
    return {
      state: "not-run",
      summary: "SMAPI runtime-log verification is not implemented in Phase 6B-2.",
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
          ? "No recorded SMAPI package paths remain."
          : `${remaining.length} recorded SMAPI package paths remain.`,
      evidence: remaining.map((pathState) => pathState.targetRelativePath),
      warnings: [],
    };
  }
}
