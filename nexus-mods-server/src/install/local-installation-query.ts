import { lstat } from "node:fs/promises";
import path from "node:path";

import { readVerifiedModBundleManifest } from "../download-bundle-service.js";
import { NexusError } from "../errors.js";
import type { InstallationRecord } from "./contracts.js";
import { inspectPathState } from "./core/tree-state.js";
import type { InstallService } from "./install-service.js";
import { resolveManagedTarget } from "./path-policy.js";
import { evaluateVersionConstraint } from "./version-constraint.js";
import type { VersionConstraintEvaluation } from "./version-constraint.js";
import { AgenticObjectStore } from "./v2/agentic-object-store.js";
import type {
  EvidencePack,
  InstallerInstallationRecord,
} from "./v2/contracts.js";

export interface FindInstalledNexusModInput {
  domainName: string;
  modId: number;
  canonicalModUrl: string;
  gameRoot?: string;
  versionConstraint?: string;
}

export interface LocalInstallationMatch {
  recordKind: "file_transaction" | "controlled_installer";
  installationId: string;
  transactionId: string;
  installedAt: string;
  state: string;
  game: {
    gameId: string;
    nexusDomainName: string;
    gameRoot: string;
    gameContextId: string | null;
  };
  nexus: {
    canonicalModUrl: string;
    domainName: string;
    modId: number;
    fileId: number;
  };
  version: {
    value: string | null;
    source: "package_manifest" | "bundle_manifest" | "unknown";
  };
  versionConstraint: VersionConstraintEvaluation;
  durableVerification: {
    static: "passed";
    runtime: "passed" | "failed" | "not-run" | "not_applicable";
    unexpectedChanges: number | null;
    processExitCode: number | null;
  };
  currentVerification: {
    status: "passed" | "failed" | "requires_probe";
    checkedAt: string;
    blocking: boolean | null;
    guidance: string;
  };
  dependencySatisfaction: {
    status: "satisfied" | "candidate_requires_probe" | "not_satisfied";
    canMarkSatisfiedNode: boolean;
    reasons: string[];
  };
  evidence: {
    sourcePlanId: string;
    evidencePackId: string | null;
    gameContextId: string | null;
    bundleId: string | null;
    bundleNodeId: string | null;
  };
  warnings: string[];
}

export interface FindInstalledNexusModResult {
  query: {
    canonicalModUrl: string;
    domainName: string;
    modId: number;
    gameRoot: string | null;
    versionConstraint: string | null;
  };
  matches: LocalInstallationMatch[];
  counts: {
    matches: number;
    satisfied: number;
    candidatesRequiringProbe: number;
    notSatisfied: number;
  };
}

const ACTIVE_FILE_STATES = new Set<InstallationRecord["state"]>([
  "installed",
  "runtime_unverified",
  "runtime_verified",
]);

function samePath(left: string, right: string): boolean {
  const leftResolved = path.resolve(left);
  const rightResolved = path.resolve(right);
  return process.platform === "win32"
    ? leftResolved.toLowerCase() === rightResolved.toLowerCase()
    : leftResolved === rightResolved;
}

function versionPermitsSatisfaction(
  evaluation: VersionConstraintEvaluation,
): boolean {
  return (
    evaluation.status === "not_requested" ||
    evaluation.status === "satisfied"
  );
}

async function installerVersion(
  record: InstallerInstallationRecord,
  evidence: EvidencePack,
  objects: AgenticObjectStore,
): Promise<{
  value: string | null;
  source: LocalInstallationMatch["version"]["source"];
  warnings: string[];
}> {
  const warnings: string[] = [];
  const plan = await objects
    .getPlan(record.planId, { allowExpired: true })
    .catch(() => null);
  const selectedUnit =
    plan === null
      ? null
      : evidence.packageUnits.find(
          (unit) => unit.packageUnitId === plan.selection.packageUnitId,
        ) ?? null;
  const packageVersion = selectedUnit?.identity.version ?? null;
  if (packageVersion !== null) {
    return {
      value: packageVersion,
      source: "package_manifest",
      warnings,
    };
  }
  if (evidence.source.bundle !== null) {
    try {
      const bundle = await readVerifiedModBundleManifest(
        evidence.source.bundle.bundlePath,
      );
      const archive =
        bundle.archives.find(
          (candidate) =>
            candidate.nodeId === evidence.source.bundle?.nodeId,
        ) ??
        bundle.archives.find(
          (candidate) =>
            candidate.domainName === evidence.source.nexus?.domainName &&
            candidate.modId === evidence.source.nexus?.modId &&
            candidate.fileId === evidence.source.nexus?.fileId,
        );
      if (archive) {
        return {
          value: archive.version,
          source: "bundle_manifest",
          warnings,
        };
      }
      warnings.push(
        "The bound Bundle Manifest has no Archive matching the installer Evidence.",
      );
    } catch {
      warnings.push(
        "The bound Bundle Manifest could not be read, so its version evidence is unavailable.",
      );
    }
  }
  return { value: null, source: "unknown", warnings };
}

function dependencyReasons(input: {
  version: VersionConstraintEvaluation;
  currentStatus: LocalInstallationMatch["currentVerification"]["status"];
}): string[] {
  const reasons: string[] = [];
  if (!versionPermitsSatisfaction(input.version)) {
    reasons.push(input.version.reason);
  }
  if (input.currentStatus === "failed") {
    reasons.push("Current local verification failed.");
  } else if (input.currentStatus === "requires_probe") {
    reasons.push(
      "A fresh game/loader probe is required before this installer record can satisfy a dependency node.",
    );
  }
  return reasons;
}

async function verifyManagedPayload(
  record: InstallationRecord,
  gameRoot: string,
  writableRoots: ReadonlyArray<string>,
  protectedRoots: ReadonlyArray<string>,
): Promise<boolean | null> {
  let checked = 0;
  for (const outcome of record.operationOutcomes) {
    const target = resolveManagedTarget({
      gameRoot,
      targetRelativePath: outcome.targetRelativePath,
      writableRoots,
      protectedRoots,
    });
    if (outcome.postState.kind === "file") {
      checked += 1;
      const state = await inspectPathState(target.targetAbsolutePath);
      if (
        state.kind !== "file" ||
        state.bytes !== outcome.postState.bytes ||
        state.sha256 !== outcome.postState.sha256
      ) {
        return false;
      }
      continue;
    }
    if (outcome.postState.kind !== "directory" || outcome.ownedFiles.length === 0) {
      continue;
    }
    for (const file of outcome.ownedFiles) {
      checked += 1;
      const absolutePath = path.resolve(
        target.targetAbsolutePath,
        ...file.relativePath.split("/"),
      );
      const state = await inspectPathState(absolutePath);
      if (
        state.kind !== "file" ||
        state.bytes !== file.bytes ||
        state.sha256 !== file.sha256
      ) {
        return false;
      }
    }
  }
  return checked === 0 ? null : true;
}

export class LocalInstallationQueryService {
  readonly #legacy: InstallService;
  readonly #objects: AgenticObjectStore;

  private constructor(
    legacy: InstallService,
    objects: AgenticObjectStore,
  ) {
    this.#legacy = legacy;
    this.#objects = objects;
  }

  static async create(input: {
    managerRoot: string;
    legacy: InstallService;
  }): Promise<LocalInstallationQueryService> {
    return new LocalInstallationQueryService(
      input.legacy,
      await AgenticObjectStore.create(input.managerRoot),
    );
  }

  async find(
    input: FindInstalledNexusModInput,
  ): Promise<FindInstalledNexusModResult> {
    if (input.gameRoot !== undefined && !path.isAbsolute(input.gameRoot)) {
      throw new NexusError(
        "INVALID_INPUT",
        "gameRoot must be an absolute path when supplied.",
      );
    }
    const requestedGameRoot =
      input.gameRoot === undefined ? null : path.resolve(input.gameRoot);
    const [fileRecords, installerRecords] = await Promise.all([
      this.#legacy.listInstallations(),
      this.#objects.listInstallerRecords(),
    ]);
    const matches: LocalInstallationMatch[] = [];

    for (const record of fileRecords) {
      if (
        record.nexus.domainName.toLowerCase() !==
          input.domainName.toLowerCase() ||
        record.nexus.modId !== input.modId ||
        !ACTIVE_FILE_STATES.has(record.state) ||
        record.staticVerification !== "passed"
      ) {
        continue;
      }
      const context = await this.#legacy
        .getInstallationContext(record.installationId)
        .catch(() => null);
      const dynamicContext = await this.#objects
        .getGameContext(record.gameInstanceId)
        .catch(() => null);
      if (
        context === null ||
        (requestedGameRoot !== null &&
          !samePath(context.instance.gameRoot, requestedGameRoot))
      ) {
        continue;
      }
      const versionValue = record.packageSummary.identity.version;
      const version = evaluateVersionConstraint(
        versionValue,
        input.versionConstraint ?? null,
      );
      const checkedAt = new Date().toISOString();
      const verified = await this.#legacy
        .verifyInstallation(record.installationId)
        .catch(() => null);
      const managedPayload = await verifyManagedPayload(
        record,
        context.instance.gameRoot,
        context.profile.filesystem.writableRoots,
        context.profile.filesystem.protectedRoots,
      ).catch(() => false);
      const exactTreePassed =
        verified !== null &&
        verified.staticVerification.state === "passed" &&
        !verified.inspection.blocking;
      const currentPassed = managedPayload ?? exactTreePassed;
      const currentStatus = currentPassed ? "passed" : "failed";
      const satisfaction =
        currentPassed && versionPermitsSatisfaction(version)
          ? "satisfied"
          : "not_satisfied";
      matches.push({
        recordKind: "file_transaction",
        installationId: record.installationId,
        transactionId: record.transactionId,
        installedAt: record.installedAt,
        state: record.state,
        game: {
          gameId: dynamicContext?.game.gameId ?? context.profile.profileId,
          nexusDomainName:
            dynamicContext?.game.nexusDomainName ??
            context.profile.nexusDomainName,
          gameRoot: context.instance.gameRoot,
          gameContextId: dynamicContext?.gameContextId ?? null,
        },
        nexus: {
          canonicalModUrl: input.canonicalModUrl,
          domainName: record.nexus.domainName,
          modId: record.nexus.modId,
          fileId: record.nexus.fileId,
        },
        version: {
          value: versionValue,
          source:
            versionValue === null ? "unknown" : "package_manifest",
        },
        versionConstraint: version,
        durableVerification: {
          static: "passed",
          runtime:
            record.runtimeVerification === "not-run"
              ? "not-run"
              : record.runtimeVerification,
          unexpectedChanges: null,
          processExitCode: null,
        },
        currentVerification: {
          status: currentStatus,
          checkedAt,
          blocking: currentPassed ? false : verified?.inspection.blocking ?? null,
          guidance: currentPassed
            ? exactTreePassed
              ? "Current managed paths pass exact static verification."
              : "Every recorded owned file is intact; extra runtime-generated data does not invalidate dependency presence but remains relevant to uninstall review."
            : "Call verify_mod_install with this installationId and repair or reinstall before satisfying the dependency.",
        },
        dependencySatisfaction: {
          status: satisfaction,
          canMarkSatisfiedNode: satisfaction === "satisfied",
          reasons: dependencyReasons({ version, currentStatus }),
        },
        evidence: {
          sourcePlanId: record.sourcePlanId,
          evidencePackId: null,
          gameContextId: dynamicContext?.gameContextId ?? null,
          bundleId: null,
          bundleNodeId: null,
        },
        warnings:
          currentPassed && !exactTreePassed
            ? [
                "The exact installed tree changed, but all recorded owned files remain intact; runtime-generated or unmanaged extra data was tolerated only for dependency-presence verification.",
              ]
            : [],
      });
    }

    for (const record of installerRecords) {
      if (
        record.state !== "installed" ||
        record.verification.static !== "passed" ||
        record.process.exitCode !== 0 ||
        record.process.timedOut ||
        record.unexpectedChanges.length > 0
      ) {
        continue;
      }
      const [evidence, context] = await Promise.all([
        this.#objects.getEvidence(record.evidencePackId).catch(() => null),
        this.#objects.getGameContext(record.gameContextId).catch(() => null),
      ]);
      if (
        evidence?.source.nexus === null ||
        evidence === null ||
        context === null ||
        evidence.source.nexus.domainName.toLowerCase() !==
          input.domainName.toLowerCase() ||
        evidence.source.nexus.modId !== input.modId ||
        (requestedGameRoot !== null &&
          !samePath(record.gameRoot, requestedGameRoot))
      ) {
        continue;
      }
      const resolvedVersion = await installerVersion(
        record,
        evidence,
        this.#objects,
      );
      const version = evaluateVersionConstraint(
        resolvedVersion.value,
        input.versionConstraint ?? null,
      );
      const gameRootExists = await lstat(record.gameRoot)
        .then((info) => info.isDirectory() && !info.isSymbolicLink())
        .catch(() => false);
      const currentStatus = gameRootExists ? "requires_probe" : "failed";
      const versionPermits = versionPermitsSatisfaction(version);
      const satisfaction =
        !gameRootExists || !versionPermits
          ? "not_satisfied"
          : "candidate_requires_probe";
      matches.push({
        recordKind: "controlled_installer",
        installationId: record.installationId,
        transactionId: record.transactionId,
        installedAt: record.installedAt,
        state: record.state,
        game: {
          gameId: context.game.gameId,
          nexusDomainName:
            context.game.nexusDomainName ?? evidence.source.nexus.domainName,
          gameRoot: record.gameRoot,
          gameContextId: record.gameContextId,
        },
        nexus: {
          canonicalModUrl: evidence.source.nexus.canonicalModUrl,
          domainName: evidence.source.nexus.domainName,
          modId: evidence.source.nexus.modId,
          fileId: evidence.source.nexus.fileId,
        },
        version: {
          value: resolvedVersion.value,
          source: resolvedVersion.source,
        },
        versionConstraint: version,
        durableVerification: {
          static: "passed",
          runtime: "not_applicable",
          unexpectedChanges: record.unexpectedChanges.length,
          processExitCode: record.process.exitCode,
        },
        currentVerification: {
          status: currentStatus,
          checkedAt: new Date().toISOString(),
          blocking: gameRootExists ? null : true,
          guidance: gameRootExists
            ? "Call probe_game_context for this exact gameRoot and verify the expected loader/runtime is currently detected before satisfying the dependency."
            : "The recorded game root no longer exists; do not satisfy the dependency.",
        },
        dependencySatisfaction: {
          status: satisfaction,
          canMarkSatisfiedNode: false,
          reasons: dependencyReasons({ version, currentStatus }),
        },
        evidence: {
          sourcePlanId: record.planId,
          evidencePackId: record.evidencePackId,
          gameContextId: record.gameContextId,
          bundleId: record.bundle?.bundleId ?? null,
          bundleNodeId: record.bundle?.nodeId ?? null,
        },
        warnings: resolvedVersion.warnings,
      });
    }

    matches.sort((left, right) =>
      right.installedAt.localeCompare(left.installedAt),
    );
    return {
      query: {
        canonicalModUrl: input.canonicalModUrl,
        domainName: input.domainName,
        modId: input.modId,
        gameRoot: requestedGameRoot,
        versionConstraint: input.versionConstraint ?? null,
      },
      matches,
      counts: {
        matches: matches.length,
        satisfied: matches.filter(
          (match) => match.dependencySatisfaction.status === "satisfied",
        ).length,
        candidatesRequiringProbe: matches.filter(
          (match) =>
            match.dependencySatisfaction.status ===
            "candidate_requires_probe",
        ).length,
        notSatisfied: matches.filter(
          (match) =>
            match.dependencySatisfaction.status === "not_satisfied",
        ).length,
      },
    };
  }
}
