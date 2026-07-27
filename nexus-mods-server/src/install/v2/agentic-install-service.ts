import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import type { AdapterPackageContext } from "../adapter.js";
import { sha256CanonicalJson } from "../content-hash.js";
import type {
  GameInstance,
  GameProfile,
  InstallOperation,
  PackageAnalysis,
  PackageUnit,
} from "../contracts.js";
import {
  gameInstanceSchema,
  gameProfileSchema,
  packageAnalysisSchema,
} from "../contracts.js";
import {
  inspectOperationConflict,
  preconditionStateHash,
} from "../core/conflict-detector.js";
import { StagingManager } from "../core/staging-manager.js";
import type { ApplyInstallResult } from "../core/transaction-engine.js";
import { sha256File } from "../file-hash.js";
import type {
  InspectedInstallInput,
  InstallInputReference,
  InstallService,
} from "../install-service.js";
import {
  normalizeManagedRelativePath,
  resolveManagedTarget,
} from "../path-policy.js";
import { validateOperationReversibility } from "../reversibility.js";
import { PlanExecutionContextStore } from "../storage/plan-execution-context-store.js";
import { PlanStore } from "../storage/plan-store.js";
import {
  AGENTIC_FILE_METHOD_ADAPTER_ID,
  AGENTIC_FILE_METHOD_ADAPTER_VERSION,
} from "./agentic-file-method-adapter.js";
import { AgenticObjectStore } from "./agentic-object-store.js";
import {
  computeDynamicGameContextHash,
  computeEvidencePackHash,
  computeInstallPlanV2Hash,
  computeInstallProposalHash,
  dynamicGameContextSchema,
  evidencePackSchema,
  installPlanV2Schema,
  installProposalDraftSchema,
  installProposalSchema,
  methodProviderCandidateSchema,
} from "./contracts.js";
import type {
  DynamicGameContext,
  EvidencePack,
  EvidenceReference,
  InstallPlanV2,
  InstallProposal,
  InstallProposalDraft,
  MethodProviderCandidate,
  MethodSignal,
} from "./contracts.js";
import { MethodStore } from "./method-store.js";

interface ExplicitGameContextInput {
  gameRoot: string;
  gameId: string;
  gameName: string;
  nexusDomainName?: string;
  gameVersion?: string;
  platform?: DynamicGameContext["instance"]["platform"];
  platformAppId?: string;
  operatingSystem?: DynamicGameContext["instance"]["operatingSystem"];
  anchorPaths: ReadonlyArray<string>;
  writableRoots: ReadonlyArray<string>;
  protectedRoots?: ReadonlyArray<string>;
  liveModRoots?: ReadonlyArray<string>;
  knownProcessNames?: ReadonlyArray<string>;
  lockSensitiveProcessNames?: ReadonlyArray<string>;
  detectedLoaders?: ReadonlyArray<GameInstance["detectedLoaders"][number]>;
}

export type ProbeAgenticGameContextInput =
  | {
      gameRoot: string;
      legacyProfileId: string;
    }
  | ExplicitGameContextInput;

export interface PrepareEvidenceInput extends InstallInputReference {
  gameContextId?: string;
  bundle?: {
    bundleId: string;
    bundlePath: string;
    bundleHash: string;
    nodeId: string;
    installOrderIndex: number;
  };
  dependencies?: EvidencePack["dependencies"];
}

export interface AgenticMethodQueryResult {
  evidence: EvidencePack;
  context: DynamicGameContext;
  candidates: ReadonlyArray<MethodProviderCandidate>;
  operationCapabilities: {
    installTree: {
      operationKind: "install_tree";
      state: "available";
      executableIn: "M2";
    };
    runBundledInstaller: {
      operationKind: "run_bundled_installer";
      state: "unavailable";
      errorCode: "OPERATION_CAPABILITY_MISSING";
      plannedFor: "M3";
    };
  };
  proposalReadiness: {
    packageUnitCount: number;
    canSubmitFileProposal: boolean;
    recommendedAction:
      | "reprobe_with_legacy_profile"
      | "select_verified_method"
      | "construct_agent_file_proposal"
      | "stop_before_proposal";
    blockers: ReadonlyArray<{
      code:
        | "REGISTERED_PROFILE_AVAILABLE"
        | "PACKAGE_UNIT_MISSING"
        | "OPERATION_CAPABILITY_MISSING";
      message: string;
    }>;
  };
  contextAdvisories: ReadonlyArray<{
    code: "REGISTERED_PROFILE_AVAILABLE";
    legacyProfileId: string;
    message: string;
  }>;
}

const M2_OPERATION_CAPABILITIES = {
  installTree: {
    operationKind: "install_tree",
    state: "available",
    executableIn: "M2",
  },
  runBundledInstaller: {
    operationKind: "run_bundled_installer",
    state: "unavailable",
    errorCode: "OPERATION_CAPABILITY_MISSING",
    plannedFor: "M3",
  },
} as const;

function operatingSystem(
  value: NodeJS.Platform,
): DynamicGameContext["instance"]["operatingSystem"] {
  if (value === "win32" || value === "linux" || value === "darwin") {
    return value;
  }
  throw new NexusError(
    "GAME_CONTEXT_REQUIRED",
    `Operating system ${value} is not supported by Contract V2.`,
  );
}

function evidenceReference(input: {
  kind: EvidenceReference["kind"];
  uri: string;
  summary: string;
  capturedAt: string;
  content: unknown;
}): EvidenceReference {
  return {
    evidenceId: randomUUID(),
    kind: input.kind,
    uri: input.uri,
    capturedAt: input.capturedAt,
    contentSha256: sha256CanonicalJson(input.content),
    summary: input.summary,
  };
}

function gameRelativeRoots(
  context: DynamicGameContext,
  kind: keyof DynamicGameContext["pathPolicy"],
): string[] {
  return context.pathPolicy[kind]
    .filter((root) => root.scope === "game_root")
    .map((root) =>
      normalizeManagedRelativePath(
        root.path,
        context.instance.operatingSystem,
      ),
    );
}

function selectedPackage(
  evidence: EvidencePack,
  packageUnitId: string,
): PackageUnit {
  const unit = evidence.packageUnits.find(
    (candidate) => candidate.packageUnitId === packageUnitId,
  );
  if (!unit) {
    throw new NexusError(
      "PROPOSAL_INVALID",
      "Install Proposal selects a package unit absent from its Evidence Pack.",
      { details: { packageUnitId } },
    );
  }
  return unit;
}

function packageAnalysisFromEvidence(
  evidence: EvidencePack,
  packageUnit: PackageUnit,
): PackageAnalysis {
  const hashPayload = {
    schemaVersion: 1 as const,
    analyzerVersion: "2.0.0-m2-agentic",
    archive: evidence.source.archive,
    packages: [packageUnit],
    ambiguities: [],
  };
  return packageAnalysisSchema.parse({
    ...hashPayload,
    analysisId: randomUUID(),
    analysisHash: sha256CanonicalJson(hashPayload),
    analyzedAt: new Date().toISOString(),
  });
}

function v1ProfileAndInstance(
  context: DynamicGameContext,
): { profile: GameProfile; instance: GameInstance } {
  const writableRoots = gameRelativeRoots(context, "writableRoots");
  if (writableRoots.length === 0) {
    throw new NexusError(
      "GAME_CONTEXT_REQUIRED",
      "Dynamic Game Context has no game-relative writable root.",
    );
  }
  const protectedRoots = gameRelativeRoots(context, "protectedRoots");
  const liveModRoots = gameRelativeRoots(context, "liveModRoots");
  const profileId = `v2-context-${context.game.gameId}`.slice(0, 200);
  const profileVersion = context.gameContextHash.slice(0, 16);
  const profile = gameProfileSchema.parse({
    schemaVersion: 1,
    profileId,
    profileVersion,
    gameName: context.game.name,
    nexusDomainName: context.game.nexusDomainName ?? "unknown-game",
    supportedOperatingSystems: [context.instance.operatingSystem],
    discovery: {
      executableAnchors: [writableRoots[0]],
      steamAppIds:
        context.instance.platform === "steam" &&
        context.instance.platformAppId !== null &&
        /^\d+$/.test(context.instance.platformAppId)
          ? [Number(context.instance.platformAppId)]
          : [],
    },
    filesystem: {
      writableRoots,
      protectedRoots,
      liveModRoots,
      stateLocationPolicy: "local-app-data",
    },
    loaders: [],
    runtime: {
      processNames: context.processes.knownProcessNames,
      lockSensitiveProcessNames:
        context.processes.lockSensitiveProcessNames,
    },
  });
  const instance = gameInstanceSchema.parse({
    schemaVersion: 1,
    instanceId: context.gameContextId,
    profileId,
    profileVersion,
    gameRoot: context.instance.gameRoot,
    platform: context.instance.platform,
    platformAppId: context.instance.platformAppId,
    gameVersion: context.game.version,
    anchorFingerprints: context.instance.anchorFingerprints,
    detectedLoaders: context.detectedLoaders,
    verifiedAt: context.verifiedAt,
  });
  return { profile, instance };
}

function signalMatches(
  signal: MethodSignal,
  evidence: EvidencePack,
  context: DynamicGameContext,
): boolean | null {
  const expected = signal.expected;
  let values: string[];
  switch (signal.kind) {
    case "game_identity":
      values = [
        context.game.gameId,
        context.game.name,
        context.game.nexusDomainName ?? "",
      ];
      break;
    case "loader_state":
      values = context.detectedLoaders.flatMap((loader) => [
        loader.loaderId,
        `${loader.loaderId}:${loader.state}`,
      ]);
      break;
    case "package_type":
      values = evidence.packageUnits.map((unit) => unit.packageType);
      break;
    case "source_identity":
      values = evidence.source.nexus
        ? [
            `${evidence.source.nexus.domainName}:${evidence.source.nexus.modId}`,
            evidence.source.nexus.canonicalModUrl,
          ]
        : [];
      break;
    case "path_exists":
    case "path_pattern":
    case "file_name":
    case "archive_layout":
      values = evidence.archive.entries.map((entry) => entry.relativePath);
      break;
    case "manifest_field":
      return null;
  }
  if (signal.operator === "exists") return values.length > 0;
  if (signal.operator === "not_exists") return values.length === 0;
  if (expected === null) return null;
  if (signal.operator === "equals") {
    return values.some((value) => value.toLowerCase() === expected.toLowerCase());
  }
  if (signal.operator === "contains") {
    return values.some((value) =>
      value.toLowerCase().includes(expected.toLowerCase()),
    );
  }
  if (signal.operator === "matches") {
    try {
      const expression = new RegExp(expected, "i");
      return values.some((value) => expression.test(value));
    } catch {
      return null;
    }
  }
  return null;
}

export class AgenticInstallService {
  readonly #managerRoot: string;
  readonly #legacy: InstallService;
  readonly #objects: AgenticObjectStore;
  readonly #methods: MethodStore;
  readonly #v1PlanStore: PlanStore;
  readonly #v1ContextStore: PlanExecutionContextStore;

  private constructor(input: {
    managerRoot: string;
    legacy: InstallService;
    objects: AgenticObjectStore;
    methods: MethodStore;
    v1PlanStore: PlanStore;
    v1ContextStore: PlanExecutionContextStore;
  }) {
    this.#managerRoot = input.managerRoot;
    this.#legacy = input.legacy;
    this.#objects = input.objects;
    this.#methods = input.methods;
    this.#v1PlanStore = input.v1PlanStore;
    this.#v1ContextStore = input.v1ContextStore;
  }

  static async create(input: {
    managerRoot: string;
    legacy: InstallService;
  }): Promise<AgenticInstallService> {
    const [objects, methods, v1PlanStore, v1ContextStore] = await Promise.all([
      AgenticObjectStore.create(input.managerRoot),
      MethodStore.create(input.managerRoot),
      PlanStore.create({ managerRoot: input.managerRoot }),
      PlanExecutionContextStore.create(input.managerRoot),
    ]);
    return new AgenticInstallService({
      managerRoot: path.resolve(input.managerRoot),
      legacy: input.legacy,
      objects,
      methods,
      v1PlanStore,
      v1ContextStore,
    });
  }

  async probeGameContext(
    input: ProbeAgenticGameContextInput,
  ): Promise<DynamicGameContext> {
    if (!path.isAbsolute(input.gameRoot)) {
      throw new NexusError(
        "GAME_CONTEXT_REQUIRED",
        "Dynamic Game Context requires an absolute gameRoot.",
      );
    }
    const gameRoot = path.resolve(input.gameRoot);
    const rootInfo = await lstat(gameRoot).catch((error: unknown) => {
      throw new NexusError(
        "GAME_INSTANCE_NOT_FOUND",
        "The selected game root does not exist.",
        { cause: error, details: { gameRoot } },
      );
    });
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new NexusError(
        "GAME_INSTANCE_NOT_FOUND",
        "The selected game root must be a real directory.",
        { details: { gameRoot } },
      );
    }

    if ("legacyProfileId" in input) {
      const [profile, instance] = await Promise.all([
        Promise.resolve(this.#legacy.getProfile(input.legacyProfileId)),
        this.#legacy.probeGameInstall({
          profileId: input.legacyProfileId,
          gameRoot,
        }),
      ]);
      const capturedAt = new Date().toISOString();
      const reference = evidenceReference({
        kind: "game_instance",
        uri: gameRoot,
        summary: `Verified ${profile.gameName} through V1 Profile ${profile.profileId}.`,
        capturedAt,
        content: { profile, instance },
      });
      const definition = this.#legacy
        .createLegacyCompatibilityProvider()
        .getGameDefinition(profile.profileId);
      const withoutHash: Omit<DynamicGameContext, "gameContextHash"> = {
        schemaVersion: 2,
        gameContextId: randomUUID(),
        state: "observed",
        createdAt: capturedAt,
        verifiedAt: capturedAt,
        game: {
          gameId: profile.profileId,
          name: profile.gameName,
          nexusDomainName: profile.nexusDomainName,
          version: instance.gameVersion,
        },
        instance: {
          gameRoot,
          platform: instance.platform,
          platformAppId: instance.platformAppId,
          operatingSystem: operatingSystem(process.platform),
          anchorFingerprints: instance.anchorFingerprints,
        },
        pathPolicy: {
          writableRoots: profile.filesystem.writableRoots.map((root) => ({
            scope: "game_root" as const,
            path: root,
            evidenceIds: [reference.evidenceId],
          })),
          protectedRoots: profile.filesystem.protectedRoots.map((root) => ({
            scope: "game_root" as const,
            path: root,
            evidenceIds: [reference.evidenceId],
          })),
          liveModRoots: profile.filesystem.liveModRoots.map((root) => ({
            scope: "game_root" as const,
            path: root,
            evidenceIds: [reference.evidenceId],
          })),
          managedStateRoots: [
            {
              scope: "manager_root",
              path: ".",
              evidenceIds: [reference.evidenceId],
            },
          ],
          observableRoots: [],
          processSideEffectRoots: [],
        },
        detectedLoaders: instance.detectedLoaders,
        processes: {
          knownProcessNames: profile.runtime.processNames,
          lockSensitiveProcessNames:
            profile.runtime.lockSensitiveProcessNames,
        },
        definitionBinding: {
          definitionId: definition.definitionId,
          definitionRevision: definition.revision,
          definitionHash: definition.definitionHash,
        },
        legacyProfileBinding: {
          profileId: profile.profileId,
          profileVersion: profile.profileVersion,
        },
        evidence: [reference],
      };
      const context = dynamicGameContextSchema.parse({
        ...withoutHash,
        gameContextHash: computeDynamicGameContextHash(withoutHash),
      });
      return await this.#objects.saveGameContext(context);
    }

    if (input.anchorPaths.length === 0 || input.writableRoots.length === 0) {
      throw new NexusError(
        "GAME_CONTEXT_REQUIRED",
        "An explicit Dynamic Game Context needs at least one verified anchor and writable root.",
      );
    }
    const platform = input.operatingSystem ?? operatingSystem(process.platform);
    const capturedAt = new Date().toISOString();
    const anchorFingerprints: string[] = [];
    const references: EvidenceReference[] = [];
    for (const anchor of input.anchorPaths) {
      const normalized = normalizeManagedRelativePath(anchor, platform);
      const absolute = path.resolve(gameRoot, ...normalized.split("/"));
      const info = await lstat(absolute).catch((error: unknown) => {
        throw new NexusError(
          "GAME_INSTANCE_NOT_FOUND",
          "A declared Dynamic Game Context anchor does not exist.",
          { cause: error, details: { anchor: normalized, absolute } },
        );
      });
      if (info.isSymbolicLink()) {
        throw new NexusError(
          "PROTECTED_PATH",
          "Dynamic Game Context anchors cannot be symbolic links.",
          { details: { anchor: normalized } },
        );
      }
      const fingerprint = info.isFile()
        ? await sha256File(absolute)
        : sha256CanonicalJson({
            path: normalized,
            kind: "directory",
            modifiedAt: info.mtime.toISOString(),
          });
      anchorFingerprints.push(fingerprint);
      references.push(
        evidenceReference({
          kind: "game_instance",
          uri: absolute,
          summary: `Observed game anchor ${normalized}.`,
          capturedAt,
          content: { normalized, fingerprint, bytes: info.size },
        }),
      );
    }
    const normalizeRoots = (roots: ReadonlyArray<string> | undefined) =>
      (roots ?? []).map((root) => ({
        scope: "game_root" as const,
        path: normalizeManagedRelativePath(root, platform),
        evidenceIds: references.map((reference) => reference.evidenceId),
      }));
    const withoutHash: Omit<DynamicGameContext, "gameContextHash"> = {
      schemaVersion: 2,
      gameContextId: randomUUID(),
      state: "observed",
      createdAt: capturedAt,
      verifiedAt: capturedAt,
      game: {
        gameId: input.gameId,
        name: input.gameName,
        nexusDomainName: input.nexusDomainName ?? null,
        version: input.gameVersion ?? null,
      },
      instance: {
        gameRoot,
        platform: input.platform ?? "manual",
        platformAppId: input.platformAppId ?? null,
        operatingSystem: platform,
        anchorFingerprints,
      },
      pathPolicy: {
        writableRoots: normalizeRoots(input.writableRoots),
        protectedRoots: normalizeRoots(input.protectedRoots),
        liveModRoots: normalizeRoots(input.liveModRoots),
        managedStateRoots: [
          {
            scope: "manager_root",
            path: ".",
            evidenceIds: references.map((reference) => reference.evidenceId),
          },
        ],
        observableRoots: [],
        processSideEffectRoots: [],
      },
      detectedLoaders: [...(input.detectedLoaders ?? [])],
      processes: {
        knownProcessNames: [...(input.knownProcessNames ?? [])],
        lockSensitiveProcessNames: [
          ...(input.lockSensitiveProcessNames ?? []),
        ],
      },
      definitionBinding: null,
      legacyProfileBinding: null,
      evidence: references,
    };
    const context = dynamicGameContextSchema.parse({
      ...withoutHash,
      gameContextHash: computeDynamicGameContextHash(withoutHash),
    });
    return await this.#objects.saveGameContext(context);
  }

  async getGameContext(gameContextId: string): Promise<DynamicGameContext> {
    return await this.#objects.getGameContext(gameContextId);
  }

  async prepareEvidence(
    input: PrepareEvidenceInput,
  ): Promise<EvidencePack> {
    const [inspected, context] = await Promise.all([
      this.#legacy.inspect(input),
      input.gameContextId === undefined
        ? Promise.resolve(null)
        : this.#objects.getGameContext(input.gameContextId),
    ]);
    const createdAt = new Date().toISOString();
    const inventoryEvidence = evidenceReference({
      kind: "archive_inventory",
      uri: inspected.verifiedInput.archive.absolutePath,
      summary: `Inspected ${inspected.inventory.entries.length} safe ZIP entries.`,
      capturedAt: createdAt,
      content: inspected.inventory,
    });
    const nexusEvidence = evidenceReference({
      kind: "nexus_metadata",
      uri: inspected.verifiedInput.source.canonicalModUrl,
      summary: `Receipt identifies Nexus file ${inspected.verifiedInput.source.domainName}:${inspected.verifiedInput.source.modId}:${inspected.verifiedInput.source.fileId}.`,
      capturedAt: createdAt,
      content: inspected.verifiedInput.source,
    });
    const dependencies =
      input.dependencies ??
      inspected.analysis.packages.flatMap((unit) =>
        unit.dependencies.map((dependency) => ({
          nodeId: dependency.dependencyId,
          kind: "external_requirement" as const,
          required: dependency.kind === "required",
          satisfied: false,
          evidence: dependency.evidence,
        })),
      );
    const withoutHash: Omit<EvidencePack, "evidencePackHash"> = {
      schemaVersion: 2,
      evidencePackId: randomUUID(),
      createdAt,
      source: {
        archive: inspected.verifiedInput.archive,
        receiptPath: inspected.verifiedInput.receipt.receiptPath,
        nexus: {
          domainName: inspected.verifiedInput.source.domainName,
          modId: inspected.verifiedInput.source.modId,
          fileId: inspected.verifiedInput.source.fileId,
          canonicalModUrl: inspected.verifiedInput.source.canonicalModUrl,
        },
        bundle: input.bundle ?? null,
      },
      archive: {
        inventoryHash: sha256CanonicalJson(inspected.inventory),
        entryCount: inspected.inventory.entries.length,
        entries: inspected.inventory.entries.map((entry) => ({
          relativePath: entry.normalizedPath,
          kind: entry.kind,
          bytes: entry.kind === "file" ? entry.uncompressedBytes : null,
          sha256: null,
        })),
      },
      packageUnits: inspected.analysis.packages,
      dependencies,
      gameContextBinding:
        context === null
          ? null
          : {
              gameContextId: context.gameContextId,
              gameContextHash: context.gameContextHash,
            },
      evidence: [inventoryEvidence, nexusEvidence],
    };
    const evidence = evidencePackSchema.parse({
      ...withoutHash,
      evidencePackHash: computeEvidencePackHash(withoutHash),
    });
    return await this.#objects.saveEvidence(evidence);
  }

  async getEvidence(evidencePackId: string): Promise<EvidencePack> {
    return await this.#objects.getEvidence(evidencePackId);
  }

  async queryMethods(input: {
    evidencePackId: string;
    gameContextId: string;
  }): Promise<AgenticMethodQueryResult> {
    const [evidence, context] = await Promise.all([
      this.#objects.getEvidence(input.evidencePackId),
      this.#objects.getGameContext(input.gameContextId),
    ]);
    if (
      evidence.gameContextBinding !== null &&
      (evidence.gameContextBinding.gameContextId !== context.gameContextId ||
        evidence.gameContextBinding.gameContextHash !==
          context.gameContextHash)
    ) {
      throw new NexusError(
        "EVIDENCE_CONFLICT",
        "Evidence Pack is bound to a different Dynamic Game Context.",
      );
    }
    const candidates: MethodProviderCandidate[] = [];
    const contextAdvisories =
      context.legacyProfileBinding === null
        ? this.#legacy
            .listProfiles()
            .filter(
              (profile) =>
                profile.profileId === context.game.gameId ||
                (context.game.nexusDomainName !== null &&
                  profile.nexusDomainName.toLowerCase() ===
                    context.game.nexusDomainName.toLowerCase()),
            )
            .map((profile) => ({
              code: "REGISTERED_PROFILE_AVAILABLE" as const,
              legacyProfileId: profile.profileId,
              message: `Re-probe this game root with legacyProfileId ${profile.profileId} before planning so stable game identity, loader detection, and path policy are preserved.`,
            }))
        : [];
    const learned = await this.#methods.list({
      operatingSystem: context.instance.operatingSystem,
    });
    for (const method of learned.filter((candidate) =>
      ["local_verified", "promoted"].includes(candidate.state),
    )) {
      const requiredSignals = [
        ...method.scope.gameSelectors,
        ...method.scope.loaderSelectors,
        ...method.scope.sourceSelectors,
        ...method.scope.packageSignals,
      ].filter((signal) => signal.required);
      const results = requiredSignals.map((signal) => ({
        signal,
        matched: signalMatches(signal, evidence, context),
      }));
      const negativeMatched = method.scope.negativeSignals.filter(
        (signal) => signalMatches(signal, evidence, context) === true,
      );
      const missing = results
        .filter((result) => result.matched === null)
        .map((result) => result.signal.signalId);
      const failed = results
        .filter((result) => result.matched === false)
        .map((result) => result.signal.signalId);
      const verified =
        missing.length === 0 &&
        failed.length === 0 &&
        negativeMatched.length === 0;
      candidates.push(
        methodProviderCandidateSchema.parse({
          schemaVersion: 2,
          candidateId: randomUUID(),
          providerId: "method-store",
          providerKind: "built_in_method",
          state: verified
            ? "verified_match"
            : missing.length > 0
              ? "evidence_stale"
              : "no_match",
          confidence: verified ? 1 : 0,
          methodBinding: {
            methodId: method.methodId,
            revision: method.revision,
            methodHash: method.methodHash,
          },
          legacyAdapterBinding: null,
          packageUnitIds: evidence.packageUnits.map(
            (unit) => unit.packageUnitId,
          ),
          positiveSignals: results
            .filter((result) => result.matched === true)
            .map((result) => result.signal.signalId),
          negativeSignals: [...failed, ...negativeMatched.map((item) => item.signalId)],
          missingEvidence: missing,
          requiresUserChoice: false,
        }),
      );
    }

    if (context.legacyProfileBinding !== null) {
      const profile = this.#legacy.getProfile(
        context.legacyProfileBinding.profileId,
      );
      const instance = await this.#legacy.probeGameInstall({
        profileId: profile.profileId,
        gameRoot: context.instance.gameRoot,
      });
      const analysisPayload = {
        schemaVersion: 1 as const,
        analyzerVersion: "2.0.0-m2-evidence-compat",
        archive: evidence.source.archive,
        packages: evidence.packageUnits,
        ambiguities: [],
      };
      const analysis = packageAnalysisSchema.parse({
        ...analysisPayload,
        analysisId: randomUUID(),
        analysisHash: sha256CanonicalJson(analysisPayload),
        analyzedAt: new Date().toISOString(),
      });
      const legacyContext: AdapterPackageContext = {
        analysis,
        profile,
        instance,
      };
      candidates.push(
        ...(await this.#legacy
          .createLegacyCompatibilityProvider()
          .query(legacyContext)),
      );
    }
    const blockers: Array<{
      code:
        | "REGISTERED_PROFILE_AVAILABLE"
        | "PACKAGE_UNIT_MISSING"
        | "OPERATION_CAPABILITY_MISSING";
      message: string;
    }> = [];
    if (contextAdvisories.length > 0) {
      blockers.push(
        ...contextAdvisories.map((advisory) => ({
          code: advisory.code,
          message: advisory.message,
        })),
      );
    }
    if (evidence.packageUnits.length === 0) {
      blockers.push({
        code: "PACKAGE_UNIT_MISSING",
        message:
          "Evidence contains no selectable package unit. Do not invent packageUnitId or packageRoot values.",
      });
      blockers.push({
        code: "OPERATION_CAPABILITY_MISSING",
        message:
          "If this archive requires its bundled installer, M2 cannot accept or execute that operation; preserve Evidence and stop before Proposal submission.",
      });
    }
    const verifiedCandidate = candidates.some(
      (candidate) => candidate.state === "verified_match",
    );
    const recommendedAction =
      contextAdvisories.length > 0
        ? ("reprobe_with_legacy_profile" as const)
        : evidence.packageUnits.length === 0
          ? ("stop_before_proposal" as const)
          : verifiedCandidate
            ? ("select_verified_method" as const)
            : ("construct_agent_file_proposal" as const);
    return {
      evidence,
      context,
      candidates,
      operationCapabilities: M2_OPERATION_CAPABILITIES,
      proposalReadiness: {
        packageUnitCount: evidence.packageUnits.length,
        canSubmitFileProposal:
          evidence.packageUnits.length > 0 &&
          contextAdvisories.length === 0,
        recommendedAction,
        blockers,
      },
      contextAdvisories,
    };
  }

  async submitProposal(input: {
    evidencePackId: string;
    gameContextId: string;
    draft: InstallProposalDraft;
  }): Promise<InstallProposal> {
    const draft = installProposalDraftSchema.parse(input.draft);
    const [evidence, context] = await Promise.all([
      this.#objects.getEvidence(input.evidencePackId),
      this.#objects.getGameContext(input.gameContextId),
    ]);
    if (
      evidence.gameContextBinding !== null &&
      (evidence.gameContextBinding.gameContextId !== context.gameContextId ||
        evidence.gameContextBinding.gameContextHash !==
          context.gameContextHash)
    ) {
      throw new NexusError(
        "EVIDENCE_CONFLICT",
        "Evidence Pack is bound to a different Dynamic Game Context.",
      );
    }
    for (const operation of draft.operations) {
      if (operation.kind === "run_bundled_installer") {
        throw new NexusError(
          "OPERATION_CAPABILITY_MISSING",
          "M2 accepts the bounded-installer contract but does not execute it before M3.",
        );
      }
      if (operation.kind !== "install_tree") {
        throw new NexusError(
          "OPERATION_CAPABILITY_MISSING",
          `M2 currently freezes install_tree operations; ${operation.kind} remains a later generic capability.`,
        );
      }
    }
    const unit = selectedPackage(evidence, draft.selection.packageUnitId);
    if (draft.selection.packageRoot !== unit.packageRoot) {
      throw new NexusError(
        "PROPOSAL_INVALID",
        "Proposal packageRoot does not match the selected Evidence package unit.",
      );
    }
    const binding = draft.strategyBinding;
    if (binding.origin === "agent_proposal") {
      if (
        binding.methodId !== null ||
        binding.methodRevision !== null ||
        binding.methodHash !== null ||
        binding.legacyAdapterBinding !== null
      ) {
        throw new NexusError(
          "PROPOSAL_INVALID",
          "An agent_proposal cannot claim a Method or legacy Adapter binding.",
        );
      }
    } else if (binding.methodId !== null) {
      if (
        binding.methodRevision === null ||
        binding.methodHash === null ||
        binding.legacyAdapterBinding !== null
      ) {
        throw new NexusError(
          "PROPOSAL_INVALID",
          "A Method Proposal requires one exact Method binding and no legacy Adapter binding.",
        );
      }
      const method = await this.#methods.get(
        binding.methodId,
        binding.methodRevision,
      );
      if (
        method.methodHash !== binding.methodHash ||
        !["local_verified", "promoted"].includes(method.state)
      ) {
        throw new NexusError(
          method.state === "quarantined"
            ? "METHOD_QUARANTINED"
            : "METHOD_STALE",
          "The selected learned Method is not reusable for this Proposal.",
        );
      }
      const resolved = await this.queryMethods({
        evidencePackId: evidence.evidencePackId,
        gameContextId: context.gameContextId,
      });
      const candidate = resolved.candidates.find(
        (item) =>
          item.state === "verified_match" &&
          item.methodBinding?.methodId === binding.methodId &&
          item.methodBinding.revision === binding.methodRevision &&
          item.methodBinding.methodHash === binding.methodHash &&
          item.packageUnitIds.includes(unit.packageUnitId),
      );
      if (!candidate) {
        throw new NexusError(
          "METHOD_STALE",
          "The selected Method does not deterministically match this Evidence, Game Context, and package unit.",
        );
      }
    } else if (binding.legacyAdapterBinding !== null) {
      if (
        binding.origin !== "built_in_method" ||
        binding.methodRevision !== null ||
        binding.methodHash !== null
      ) {
        throw new NexusError(
          "PROPOSAL_INVALID",
          "A legacy compatibility Proposal must use built_in_method with only an Adapter binding.",
        );
      }
      const resolved = await this.queryMethods({
        evidencePackId: evidence.evidencePackId,
        gameContextId: context.gameContextId,
      });
      const candidate = resolved.candidates.find(
        (item) =>
          item.state === "verified_match" &&
          item.legacyAdapterBinding !== null &&
          item.legacyAdapterBinding.adapterId ===
            binding.legacyAdapterBinding?.adapterId &&
          item.legacyAdapterBinding.adapterVersion ===
            binding.legacyAdapterBinding?.adapterVersion &&
          item.packageUnitIds.includes(unit.packageUnitId),
      );
      if (!candidate) {
        throw new NexusError(
          "METHOD_STALE",
          "The selected legacy compatibility provider does not match this Evidence, Game Context, and package unit.",
        );
      }
    } else {
      throw new NexusError(
        "PROPOSAL_INVALID",
        "A non-agent Proposal requires an exact Method or legacy Adapter binding.",
      );
    }

    const writableRoots = gameRelativeRoots(context, "writableRoots");
    const protectedRoots = gameRelativeRoots(context, "protectedRoots");
    for (const operation of draft.operations) {
      if (operation.kind !== "install_tree") continue;
      if (operation.sourceRelativePath !== unit.packageRoot) {
        throw new NexusError(
          "PROPOSAL_INVALID",
          "M2 install_tree must use the exact selected package root.",
        );
      }
      if (operation.ownershipMode === "layered_path") {
        throw new NexusError(
          "PROPOSAL_INVALID",
          "install_tree cannot use layered_path ownership in the M2 compatibility executor.",
        );
      }
      resolveManagedTarget({
        gameRoot: context.instance.gameRoot,
        targetRelativePath: operation.targetRelativePath,
        writableRoots,
        protectedRoots,
        platform: context.instance.operatingSystem,
      });
    }

    const withoutHash: Omit<InstallProposal, "proposalHash"> = {
      schemaVersion: 2,
      proposalId: randomUUID(),
      createdAt: new Date().toISOString(),
      evidenceBinding: {
        evidencePackId: evidence.evidencePackId,
        evidencePackHash: evidence.evidencePackHash,
      },
      gameBinding: {
        gameContextId: context.gameContextId,
        gameContextHash: context.gameContextHash,
      },
      ...draft,
    };
    const proposal = installProposalSchema.parse({
      ...withoutHash,
      proposalHash: computeInstallProposalHash(withoutHash),
    });
    return await this.#objects.saveProposal(proposal);
  }

  async getProposal(proposalId: string): Promise<InstallProposal> {
    return await this.#objects.getProposal(proposalId);
  }

  async freezePlan(input: {
    proposalId: string;
    ttlMs?: number;
  }): Promise<InstallPlanV2> {
    const proposal = await this.#objects.getProposal(input.proposalId);
    if (proposal.unresolvedChoices.length > 0) {
      throw new NexusError(
        "USER_CHOICE_REQUIRED",
        "Install Proposal has unresolved choices and cannot be frozen.",
        { details: { choices: proposal.unresolvedChoices } },
      );
    }
    const [evidence, context] = await Promise.all([
      this.#objects.getEvidence(proposal.evidenceBinding.evidencePackId),
      this.#objects.getGameContext(proposal.gameBinding.gameContextId),
    ]);
    if (
      evidence.evidencePackHash !== proposal.evidenceBinding.evidencePackHash ||
      context.gameContextHash !== proposal.gameBinding.gameContextHash
    ) {
      throw new NexusError(
        "PLAN_STALE",
        "Proposal evidence or game context changed before plan freezing.",
      );
    }
    if (proposal.strategyBinding.methodId !== null) {
      const currentMethod = await this.#methods.get(
        proposal.strategyBinding.methodId,
      );
      if (
        currentMethod.revision !== proposal.strategyBinding.methodRevision ||
        currentMethod.methodHash !== proposal.strategyBinding.methodHash ||
        !["local_verified", "promoted"].includes(currentMethod.state)
      ) {
        throw new NexusError(
          currentMethod.state === "quarantined"
            ? "METHOD_QUARANTINED"
            : "METHOD_STALE",
          "The bound Method changed after Proposal validation.",
        );
      }
    }
    const inspected = await this.#legacy.inspect({
      archivePath: evidence.source.archive.absolutePath,
      receiptPath: evidence.source.receiptPath,
      ...(evidence.source.nexus === null
        ? {}
        : {
            expectedSource: {
              domainName: evidence.source.nexus.domainName,
              modId: evidence.source.nexus.modId,
              fileId: evidence.source.nexus.fileId,
            },
          }),
    });
    if (
      inspected.verifiedInput.archive.sha256 !==
        evidence.source.archive.sha256 ||
      sha256CanonicalJson(inspected.inventory) !==
        evidence.archive.inventoryHash
    ) {
      throw new NexusError(
        "EVIDENCE_CONFLICT",
        "Archive inventory changed after Evidence Pack creation.",
      );
    }
    const unit = selectedPackage(evidence, proposal.selection.packageUnitId);
    const liveModRoots = gameRelativeRoots(context, "liveModRoots");
    const stagingManager = await StagingManager.create({
      managerRoot: this.#managerRoot,
      gameRoot: context.instance.gameRoot,
      liveModRoots,
    });
    const staged = await stagingManager.stagePackage({
      inventory: inspected.inventory,
      packageRoot: proposal.selection.packageRoot,
    });
    try {
      const operations: InstallOperation[] = proposal.operations.map(
        (operation) => {
          if (operation.kind !== "install_tree") {
            throw new NexusError(
              "OPERATION_CAPABILITY_MISSING",
              "M2 can freeze only install_tree operations.",
            );
          }
          return {
            operationId: operation.operationId,
            kind: "install_tree",
            sourceRelativePath: operation.sourceRelativePath ?? unit.packageRoot,
            sourceTreeHash: staged.treeHash,
            ownershipMode:
              operation.ownershipMode === "exclusive_tree"
                ? "exclusive_tree"
                : "installed_file_set",
            targetRelativePath: operation.targetRelativePath,
            expectedPreState: { kind: "absent" },
            expectedPostState: {
              kind: "directory",
              treeHash: staged.treeHash,
              entries: staged.files.length + staged.directories.length,
            },
          };
        },
      );
      for (const operation of operations) {
        validateOperationReversibility(operation);
      }
      const writableRoots = gameRelativeRoots(context, "writableRoots");
      const protectedRoots = gameRelativeRoots(context, "protectedRoots");
      const inspections = await Promise.all(
        operations.map((operation) =>
          inspectOperationConflict({
            operation,
            gameRoot: context.instance.gameRoot,
            writableRoots,
            protectedRoots,
            installingModUniqueId: unit.identity.uniqueId,
          }),
        ),
      );
      const blocking = inspections.filter(
        (inspection) => inspection.conflict.blocking,
      );
      if (blocking.length > 0) {
        throw new NexusError(
          "INSTALL_CONFLICT",
          "Agentic Install Proposal conflicts with current target state.",
          {
            details: {
              conflicts: blocking.map((inspection) => inspection.conflict),
            },
          },
        );
      }
      const finalizedOperations = operations.map((operation) => {
        const inspection = inspections.find(
          (candidate) => candidate.operationId === operation.operationId,
        );
        return {
          ...operation,
          expectedPreState: inspection?.actualPreState ?? {
            kind: "absent" as const,
          },
        };
      });
      const { profile, instance } = v1ProfileAndInstance(context);
      const analysis = packageAnalysisFromEvidence(evidence, unit);
      const v1Plan = await this.#v1PlanStore.save(
        {
          archive: evidence.source.archive,
          analysisId: analysis.analysisId,
          analysisHash: analysis.analysisHash,
          gameInstanceId: instance.instanceId,
          gameProfileId: profile.profileId,
          gameProfileVersion: profile.profileVersion,
          adapterId: AGENTIC_FILE_METHOD_ADAPTER_ID,
          adapterVersion: AGENTIC_FILE_METHOD_ADAPTER_VERSION,
          staging: {
            stagingId: staged.stagingId,
            packageRoot: staged.packageRoot,
            sourceTreeHash: staged.treeHash,
          },
          operations: finalizedOperations,
          conflicts: inspections.map((inspection) => inspection.conflict),
          preconditionStateHash: preconditionStateHash(inspections),
        },
        input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs },
      );
      if (evidence.source.nexus === null) {
        throw new NexusError(
          "PROPOSAL_INVALID",
          "The M2 execution bridge requires verified Nexus receipt identity.",
        );
      }
      await this.#v1ContextStore.save({
        planId: v1Plan.planId,
        planHash: v1Plan.planHash,
        analysis,
        profile,
        instance,
        packageUnitId: unit.packageUnitId,
        archivePath: evidence.source.archive.absolutePath,
        receiptPath: evidence.source.receiptPath,
        expectedSource: {
          domainName: evidence.source.nexus.domainName,
          modId: evidence.source.nexus.modId,
          fileId: evidence.source.nexus.fileId,
        },
      });

      const now = new Date();
      const ttlMs = input.ttlMs ?? 30 * 60_000;
      const withoutHash: Omit<InstallPlanV2, "planHash"> = {
        schemaVersion: 2,
        planId: randomUUID(),
        status: "planned",
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        source: {
          archive: evidence.source.archive,
          receiptPath: evidence.source.receiptPath,
          bundleId: evidence.source.bundle?.bundleId ?? null,
          bundleNodeId: evidence.source.bundle?.nodeId ?? null,
        },
        evidenceBinding: proposal.evidenceBinding,
        gameBinding: {
          ...proposal.gameBinding,
          gameRoot: context.instance.gameRoot,
        },
        strategyBinding: {
          ...proposal.strategyBinding,
          proposalId: proposal.proposalId,
          proposalHash: proposal.proposalHash,
        },
        selection: proposal.selection,
        operations: finalizedOperations,
        conflicts: inspections.map((inspection) => ({
          target: inspection.targetRelativePath,
          kind: inspection.conflict.kind,
          blocking: inspection.conflict.blocking,
          message: inspection.conflict.message,
        })),
        preconditions: proposal.preconditions,
        verificationRequirements: proposal.verificationRequirements,
        reversibility: {
          level: "full",
          backupRequirements: [
            "Record every installed file and restore any captured pre-state.",
          ],
        },
        risk: proposal.risk,
        approval: {
          requiresExplicitConfirmation: true,
          approvalDigest: sha256CanonicalJson({
            proposalId: proposal.proposalId,
            gameRoot: context.instance.gameRoot,
            operations: finalizedOperations,
            conflicts: inspections.map((item) => item.conflict),
          }),
        },
        preconditionStateHash: preconditionStateHash(inspections),
      };
      const plan = installPlanV2Schema.parse({
        ...withoutHash,
        planHash: computeInstallPlanV2Hash(withoutHash),
      });
      await this.#objects.savePlan(plan);
      await this.#objects.saveBridge({
        schemaVersion: 2,
        v2PlanId: plan.planId,
        v2PlanHash: plan.planHash,
        v1PlanId: v1Plan.planId,
        v1PlanHash: v1Plan.planHash,
        createdAt: new Date().toISOString(),
      });
      return plan;
    } catch (error) {
      await stagingManager.cleanup(staged.stagingId).catch(() => undefined);
      throw error;
    }
  }

  async getPlan(
    planId: string,
    options: { allowExpired?: boolean } = {},
  ): Promise<InstallPlanV2> {
    return await this.#objects.getPlan(planId, options);
  }

  async applyPlan(planId: string): Promise<{
    plan: InstallPlanV2;
    bridgePlanId: string;
    applied: ApplyInstallResult;
  }> {
    const [plan, bridge] = await Promise.all([
      this.#objects.getPlan(planId),
      this.#objects.getBridge(planId),
    ]);
    if (
      bridge.v2PlanHash !== plan.planHash ||
      bridge.v2PlanId !== plan.planId
    ) {
      throw new NexusError(
        "PLAN_STALE",
        "Install Plan V2 no longer matches its execution bridge.",
      );
    }
    const v1Plan = await this.#legacy.getPlan(bridge.v1PlanId);
    if (v1Plan.planHash !== bridge.v1PlanHash) {
      throw new NexusError(
        "PLAN_STALE",
        "The frozen V1 transaction bridge changed after V2 planning.",
      );
    }
    return {
      plan,
      bridgePlanId: bridge.v1PlanId,
      applied: await this.#legacy.apply(bridge.v1PlanId),
    };
  }
}
