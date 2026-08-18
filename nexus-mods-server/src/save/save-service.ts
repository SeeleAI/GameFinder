import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NexusError } from "../errors.js";
import { sha256CanonicalJson } from "../install/content-hash.js";
import type { PlanReviewMode } from "../plan-review.js";
import {
  EldenRingSlotImportService,
} from "./adapters/elden-ring-slot-import-service.js";
import {
  type SaveBackupFaultInjector,
  SaveBackupService,
} from "./backup/save-backup-service.js";
import {
  diffSaveSnapshots,
  snapshotSaveRoot,
} from "./context/differential-probe.js";
import {
  currentSaveEnvironment,
  expandSaveTemplate,
  type SaveEnvironment,
} from "./context/environment.js";
import {
  gameRootFingerprint,
  SaveContextResolver,
} from "./context/save-context-resolver.js";
import { probeSteamGameInstall } from "./context/steam-install-resolver.js";
import type {
  GameInstallContext,
  GameSaveProfile,
  LearnedSaveProfile,
  SaveBackupRecord,
  SaveCompatibilityAssessment,
  SaveContext,
  SaveDownloadReceipt,
  SaveInputInspection,
  SaveLocationProbe,
  SaveOperationRecord,
  SaveRestorePlan,
  SaveReplacementPlan,
  SaveRuntimeVerificationRecord,
  SaveSourceCandidate,
  SaveSourceSnapshot,
  StandardSavePackage,
  EldenRingSaveAnalysis,
  EldenRingSlotImportPlan,
  EldenRingStagedImport,
} from "./contracts.js";
import {
  learnedSaveProfileSchema,
  saveLocationProbeSchema,
} from "./contracts.js";
import { GameSaveProfileRegistry } from "./profiles/registry.js";
import {
  type RarCapability,
  type SevenZipArchiveCapability,
  SaveInputInspector,
} from "./package/input-inspector.js";
import { SavePackageNormalizer } from "./package/package-normalizer.js";
import {
  type AppliedSaveRestore,
  type SaveRestoreFaultInjector,
  SaveRestoreService,
} from "./restore/save-restore-service.js";
import { SaveCompatibilityAssessor } from "./replacement/compatibility-assessor.js";
import {
  type AppliedSaveReplacement,
  type SaveReplacementFaultInjector,
  SaveReplacementService,
} from "./replacement/save-replacement-service.js";
import { SaveRuntimeVerificationService } from "./replacement/save-runtime-verification-service.js";
import {
  type NexusSaveResearchClient,
  type SaveSourceFetch,
  type SaveSourceResearchResult,
  SaveSourceService,
} from "./source/save-source-service.js";
import { SaveContextStore } from "./storage/context-store.js";
import { LearnedSaveProfileStore } from "./storage/learned-profile-store.js";
import { SaveProbeStore } from "./storage/probe-store.js";

export interface SaveServiceOptions {
  managerRoot: string;
  environment?: Partial<SaveEnvironment>;
  profiles?: ReadonlyArray<GameSaveProfile>;
  probeTtlMs?: number;
  restorePlanTtlMs?: number;
  processGuard?: (processNames: ReadonlyArray<string>) => Promise<void>;
  backupFaultInjector?: SaveBackupFaultInjector;
  restoreFaultInjector?: SaveRestoreFaultInjector;
  rarCapability?: RarCapability | null;
  sevenZipCapability?: SevenZipArchiveCapability | null;
  replacementPlanTtlMs?: number;
  replacementFaultInjector?: SaveReplacementFaultInjector;
  eldenRingSlotImportPlanTtlMs?: number;
  nexusClient?: NexusSaveResearchClient;
  saveSourceFetch?: SaveSourceFetch;
}

export interface CompleteSaveLocationProbeResult {
  probe: Readonly<SaveLocationProbe>;
  learnedProfile: Readonly<LearnedSaveProfile> | null;
  saveContext: Readonly<SaveContext> | null;
}

export function resolveDefaultSaveManagerRoot(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) return path.join(localAppData, "GameFinder");
  }
  return path.join(os.homedir(), ".local", "share", "GameFinder");
}

function resolveEnvironment(
  overrides: Partial<SaveEnvironment> | undefined,
): SaveEnvironment {
  return {
    ...currentSaveEnvironment(),
    ...overrides,
  };
}

function validateProbeTtl(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 60_000 ||
    value > 24 * 60 * 60_000
  ) {
    throw new NexusError(
      "SAVE_CONTRACT_INVALID",
      "Save Location Probe TTL must be between one minute and 24 hours.",
    );
  }
  return value;
}

async function existingChangedPaths(
  saveRoot: string,
  changes: SaveLocationProbe["changes"],
): Promise<string[]> {
  const result = new Set<string>();
  for (const change of changes) {
    if (!change.after || change.after.kind !== "file") continue;
    const absolutePath = path.resolve(
      change.root,
      ...change.relativePath.split("/"),
    );
    const relative = path.relative(saveRoot, absolutePath);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      continue;
    }
    const exists = await stat(absolutePath)
      .then((info) => info.isFile())
      .catch(() => false);
    if (exists) result.add(relative.split(path.sep).join("/"));
  }
  return [...result].sort();
}

export class SaveService {
  readonly #profiles: GameSaveProfileRegistry;
  readonly #contexts: SaveContextStore;
  readonly #learnedProfiles: LearnedSaveProfileStore;
  readonly #probes: SaveProbeStore;
  readonly #resolver: SaveContextResolver;
  readonly #environment: SaveEnvironment;
  readonly #probeTtlMs: number;
  readonly #backups: SaveBackupService;
  readonly #restores: SaveRestoreService;
  readonly #inputInspector: SaveInputInspector;
  readonly #normalizer: SavePackageNormalizer;
  readonly #compatibility: SaveCompatibilityAssessor;
  readonly #replacements: SaveReplacementService;
  readonly #runtimeVerifications: SaveRuntimeVerificationService;
  readonly #sources: SaveSourceService | null;
  readonly #eldenRingSlots: EldenRingSlotImportService;

  private constructor(input: {
    profiles: GameSaveProfileRegistry;
    contexts: SaveContextStore;
    learnedProfiles: LearnedSaveProfileStore;
    probes: SaveProbeStore;
    resolver: SaveContextResolver;
    environment: SaveEnvironment;
    probeTtlMs: number;
    backups: SaveBackupService;
    restores: SaveRestoreService;
    inputInspector: SaveInputInspector;
    normalizer: SavePackageNormalizer;
    compatibility: SaveCompatibilityAssessor;
    replacements: SaveReplacementService;
    runtimeVerifications: SaveRuntimeVerificationService;
    sources: SaveSourceService | null;
    eldenRingSlots: EldenRingSlotImportService;
  }) {
    this.#profiles = input.profiles;
    this.#contexts = input.contexts;
    this.#learnedProfiles = input.learnedProfiles;
    this.#probes = input.probes;
    this.#resolver = input.resolver;
    this.#environment = input.environment;
    this.#probeTtlMs = input.probeTtlMs;
    this.#backups = input.backups;
    this.#restores = input.restores;
    this.#inputInspector = input.inputInspector;
    this.#normalizer = input.normalizer;
    this.#compatibility = input.compatibility;
    this.#replacements = input.replacements;
    this.#runtimeVerifications = input.runtimeVerifications;
    this.#sources = input.sources;
    this.#eldenRingSlots = input.eldenRingSlots;
  }

  static async create(options: SaveServiceOptions): Promise<SaveService> {
    const profiles = new GameSaveProfileRegistry(options.profiles);
    const environment = resolveEnvironment(options.environment);
    const [contexts, learnedProfiles, probes] = await Promise.all([
      SaveContextStore.create(options.managerRoot),
      LearnedSaveProfileStore.create(options.managerRoot),
      SaveProbeStore.create(options.managerRoot),
    ]);
    const backups = await SaveBackupService.create({
      managerRoot: options.managerRoot,
      contexts,
      profiles,
      ...(options.processGuard === undefined
        ? {}
        : { processGuard: options.processGuard }),
      ...(options.backupFaultInjector === undefined
        ? {}
        : { faultInjector: options.backupFaultInjector }),
    });
    const restores = await SaveRestoreService.create({
      managerRoot: options.managerRoot,
      contexts,
      backups,
      ...(options.restorePlanTtlMs === undefined
        ? {}
        : { planTtlMs: options.restorePlanTtlMs }),
      ...(options.restoreFaultInjector === undefined
        ? {}
        : { faultInjector: options.restoreFaultInjector }),
    });
    const inputInspector = await SaveInputInspector.create({
      managerRoot: options.managerRoot,
      ...(options.rarCapability === undefined
        ? {}
        : { rarCapability: options.rarCapability }),
      ...(options.sevenZipCapability === undefined
        ? {}
        : { sevenZipCapability: options.sevenZipCapability }),
    });
    const normalizer = await SavePackageNormalizer.create({
      managerRoot: options.managerRoot,
      inspector: inputInspector,
    });
    const eldenRingSlots = await EldenRingSlotImportService.create({
      managerRoot: options.managerRoot,
      contexts,
      packages: normalizer,
      ...(options.eldenRingSlotImportPlanTtlMs === undefined
        ? {}
        : { planTtlMs: options.eldenRingSlotImportPlanTtlMs }),
    });
    const compatibility = await SaveCompatibilityAssessor.create({
      managerRoot: options.managerRoot,
      contexts,
      packages: normalizer,
    });
    const replacements = await SaveReplacementService.create({
      managerRoot: options.managerRoot,
      contexts,
      packages: normalizer,
      assessments: compatibility,
      backups,
      eldenRingSlots,
      ...(options.replacementPlanTtlMs === undefined
        ? {}
        : { planTtlMs: options.replacementPlanTtlMs }),
      ...(options.replacementFaultInjector === undefined
        ? {}
        : { faultInjector: options.replacementFaultInjector }),
    });
    const runtimeVerifications = await SaveRuntimeVerificationService.create(
      options.managerRoot,
    );
    const sources = options.nexusClient
      ? await SaveSourceService.create({
          managerRoot: options.managerRoot,
          nexus: options.nexusClient,
          ...(options.saveSourceFetch ? { fetch: options.saveSourceFetch } : {}),
        })
      : null;
    return new SaveService({
      profiles,
      contexts,
      learnedProfiles,
      probes,
      resolver: new SaveContextResolver({
        profiles,
        learnedProfiles,
        environment,
      }),
      environment,
      probeTtlMs: validateProbeTtl(
        options.probeTtlMs ?? 30 * 60_000,
      ),
      backups,
      restores,
      inputInspector,
      normalizer,
      compatibility,
      replacements,
      runtimeVerifications,
      sources,
      eldenRingSlots,
    });
  }

  listProfiles(): ReadonlyArray<GameSaveProfile> {
    return this.#profiles.list();
  }

  async probeGameInstall(input: {
    gameRoot: string;
  }): Promise<Readonly<GameInstallContext>> {
    const context = await probeSteamGameInstall({
      gameRoot: input.gameRoot,
      profiles: this.#profiles,
    });
    return await this.#contexts.saveInstallContext(context);
  }

  async getGameInstallContext(
    installContextId: string,
  ): Promise<Readonly<GameInstallContext>> {
    return await this.#contexts.getInstallContext(installContextId);
  }

  async resolveSaveLocations(
    installContextId: string,
  ): Promise<Readonly<SaveContext>> {
    const install = await this.#contexts.getInstallContext(installContextId);
    const context = await this.#resolver.resolve(install);
    return await this.#contexts.saveSaveContext(context);
  }

  async getSaveContext(
    saveContextId: string,
  ): Promise<Readonly<SaveContext>> {
    return await this.#contexts.getSaveContext(saveContextId);
  }

  async createSaveBackup(input: {
    saveContextId: string;
    unitId: string;
    reason: SaveBackupRecord["reason"];
  }): Promise<Readonly<SaveBackupRecord>> {
    return await this.#backups.createBackup(input);
  }

  async getSaveBackup(backupId: string): Promise<Readonly<SaveBackupRecord>> {
    return await this.#backups.getBackup(backupId);
  }

  async listSaveBackups(
    saveContextId?: string,
  ): Promise<ReadonlyArray<Readonly<SaveBackupRecord>>> {
    return await this.#backups.listBackups(saveContextId);
  }

  async verifySaveBackup(backupId: string): Promise<Readonly<SaveBackupRecord>> {
    return await this.#backups.verifyBackup(backupId);
  }

  async planSaveRestore(input: {
    backupId: string;
    saveContextId: string;
    mode: SaveRestorePlan["mode"];
    targetKind?: SaveRestorePlan["target"]["kind"];
    reviewMode?: PlanReviewMode;
  }): Promise<Readonly<SaveRestorePlan>> {
    return await this.#restores.planRestore(input);
  }

  async getSaveRestorePlan(
    restorePlanId: string,
  ): Promise<Readonly<SaveRestorePlan>> {
    return await this.#restores.getPlan(restorePlanId);
  }

  async applySaveRestore(restorePlanId: string): Promise<AppliedSaveRestore> {
    return await this.#restores.applyRestore(restorePlanId);
  }

  async verifySaveRestore(
    recordId: string,
  ): Promise<Readonly<SaveOperationRecord>> {
    return await this.#restores.verifyRestore(recordId);
  }

  async inspectSaveInput(
    inputPath: string,
  ): Promise<Readonly<SaveInputInspection>> {
    return await this.#inputInspector.inspect(inputPath);
  }

  async getSaveInputInspection(
    inspectionId: string,
  ): Promise<Readonly<SaveInputInspection>> {
    return await this.#inputInspector.get(inspectionId);
  }

  async normalizeSavePackage(input: {
    inspectionId: string;
    payloadSelectionId: string;
  }): Promise<Readonly<StandardSavePackage>> {
    return await this.#normalizer.normalize(input);
  }

  async getStandardSavePackage(
    packageId: string,
  ): Promise<Readonly<StandardSavePackage>> {
    return await this.#normalizer.get(packageId);
  }

  async verifyStandardSavePackage(
    packageId: string,
  ): Promise<Readonly<StandardSavePackage>> {
    return await this.#normalizer.verify(packageId);
  }

  async analyzeEldenRingSavePath(absolutePath: string): Promise<Readonly<EldenRingSaveAnalysis>> {
    return await this.#eldenRingSlots.analyzePath(absolutePath);
  }

  async analyzeEldenRingPackage(packageId: string): Promise<Readonly<EldenRingSaveAnalysis>> {
    return await this.#eldenRingSlots.analyzePackage(packageId);
  }

  async analyzeEldenRingSaveContext(saveContextId: string): Promise<Readonly<EldenRingSaveAnalysis>> {
    return await this.#eldenRingSlots.analyzeContext(saveContextId);
  }

  async getEldenRingSaveAnalysis(analysisId: string): Promise<Readonly<EldenRingSaveAnalysis>> {
    return await this.#eldenRingSlots.getAnalysis(analysisId);
  }

  async planEldenRingSlotImport(input: {
    packageId: string;
    saveContextId: string;
    sourceSlot?: number;
    targetSlot?: number;
    allowOccupiedTarget?: boolean;
  }): Promise<Readonly<EldenRingSlotImportPlan>> {
    return await this.#eldenRingSlots.plan(input);
  }

  async getEldenRingSlotImportPlan(slotImportPlanId: string): Promise<Readonly<EldenRingSlotImportPlan>> {
    return await this.#eldenRingSlots.getPlan(slotImportPlanId);
  }

  async stageEldenRingSlotImport(slotImportPlanId: string): Promise<Readonly<EldenRingStagedImport>> {
    return await this.#eldenRingSlots.stage(slotImportPlanId);
  }

  async verifyEldenRingStagedImport(stagedImportId: string): Promise<Readonly<EldenRingStagedImport>> {
    return await this.#eldenRingSlots.verifyStage(stagedImportId);
  }

  async researchNexusSaveSources(input: {
    installContextId: string;
    query?: string;
    maxCandidates?: number;
  }): Promise<SaveSourceResearchResult> {
    const sources = this.#requireSources();
    const install = await this.#contexts.getInstallContext(input.installContextId);
    const profile = this.#profiles.findByCanonicalGameId(install.game.canonicalId);
    const domainName = profile?.sources?.nexusDomainName;
    if (!domainName) {
      throw new NexusError(
        "SAVE_ADAPTER_UNSUPPORTED",
        "No Nexus game domain is mapped for this Game Save Profile.",
      );
    }
    return await sources.researchNexus({
      game: install.game,
      domainName,
      ...(input.query ? { query: input.query } : {}),
      ...(input.maxCandidates ? { maxCandidates: input.maxCandidates } : {}),
    });
  }

  async researchSpeedrunSaveSources(input: {
    installContextId: string;
  }): Promise<SaveSourceResearchResult> {
    const sources = this.#requireSources();
    const install = await this.#contexts.getInstallContext(input.installContextId);
    const profile = this.#profiles.findByCanonicalGameId(install.game.canonicalId);
    const gameSlug = profile?.sources?.speedrunGameSlug;
    if (!gameSlug) {
      throw new NexusError(
        "SAVE_ADAPTER_UNSUPPORTED",
        "No Speedrun game slug is mapped for this Game Save Profile.",
      );
    }
    return await sources.researchSpeedrunOnline({
      game: install.game,
      pageUrl: `https://www.speedrun.com/${gameSlug}/resources`,
    });
  }

  async researchSpeedrunSaveSnapshot(input: {
    installContextId: string;
    pageHtml: string;
    detailPages?: Readonly<Record<string, string>>;
    fixture?: boolean;
  }): Promise<SaveSourceResearchResult> {
    const sources = this.#requireSources();
    const install = await this.#contexts.getInstallContext(input.installContextId);
    const profile = this.#profiles.findByCanonicalGameId(install.game.canonicalId);
    const gameSlug = profile?.sources?.speedrunGameSlug;
    if (!gameSlug) {
      throw new NexusError("SAVE_ADAPTER_UNSUPPORTED", "No Speedrun game slug is mapped for this game.");
    }
    return await sources.researchSpeedrunFromSnapshot({
      game: install.game,
      pageUrl: `https://www.speedrun.com/${gameSlug}/resources`,
      pageHtml: input.pageHtml,
      ...(input.detailPages ? { detailPages: input.detailPages } : {}),
      fetchMode: input.fixture ? "fixture" : "html",
    });
  }

  async getSaveSourceSnapshot(snapshotId: string): Promise<Readonly<SaveSourceSnapshot>> {
    return await this.#requireSources().getSnapshot(snapshotId);
  }

  async getSaveSourceCandidate(candidateId: string): Promise<Readonly<SaveSourceCandidate>> {
    return await this.#requireSources().getCandidate(candidateId);
  }

  async recordNexusSaveDownload(input: {
    candidateId: string;
    nexusReceiptPath: string;
  }): Promise<Readonly<SaveDownloadReceipt>> {
    return await this.#requireSources().recordNexusDownload(input);
  }

  async recordManualSaveDownload(input: {
    candidateId: string;
    absolutePath: string;
  }): Promise<Readonly<SaveDownloadReceipt>> {
    return await this.#requireSources().recordManualDownload(input);
  }

  async downloadSpeedrunSave(input: {
    candidateId: string;
    outputDirectory: string;
  }): Promise<Readonly<SaveDownloadReceipt>> {
    return await this.#requireSources().downloadSpeedrun(input);
  }

  async verifySaveDownloadReceipt(receiptId: string): Promise<Readonly<SaveDownloadReceipt>> {
    return await this.#requireSources().verifyReceipt(receiptId);
  }

  async inspectDownloadedSave(receiptId: string): Promise<Readonly<SaveInputInspection>> {
    const receipt = await this.#requireSources().verifyReceipt(receiptId);
    const inspection = await this.#inputInspector.inspect(receipt.absolutePath);
    if (inspection.input.sha256 !== receipt.sha256 || inspection.input.bytes !== receipt.bytes) {
      throw new NexusError(
        "SAVE_SOURCE_UNAVAILABLE",
        "Downloaded save changed between receipt verification and input inspection.",
      );
    }
    return inspection;
  }

  async normalizeDownloadedSavePackage(input: {
    receiptId: string;
    inspectionId: string;
    payloadSelectionId: string;
  }): Promise<Readonly<StandardSavePackage>> {
    const sources = this.#requireSources();
    const [receipt, inspection] = await Promise.all([
      sources.verifyReceipt(input.receiptId),
      this.#inputInspector.get(input.inspectionId),
    ]);
    if (
      inspection.input.absolutePath !== receipt.absolutePath ||
      inspection.input.sha256 !== receipt.sha256 ||
      inspection.input.bytes !== receipt.bytes
    ) {
      throw new NexusError(
        "SAVE_SOURCE_UNAVAILABLE",
        "Save input inspection does not match the verified download receipt.",
      );
    }
    const candidate = await sources.getCandidate(receipt.candidateId);
    return await this.#normalizer.normalize({
      inspectionId: input.inspectionId,
      payloadSelectionId: input.payloadSelectionId,
      provenance: {
        kind: receipt.source,
        pageUrl: receipt.pageUrl,
        downloadReceiptId: receipt.receiptId,
        originalInputSha256: receipt.sha256,
        claims: candidate.claims,
      },
    });
  }

  async assessSavePackageCompatibility(input: {
    packageId: string;
    saveContextId: string;
  }): Promise<Readonly<SaveCompatibilityAssessment>> {
    return await this.#compatibility.assess(input);
  }

  async getSaveCompatibilityAssessment(
    assessmentId: string,
  ): Promise<Readonly<SaveCompatibilityAssessment>> {
    return await this.#compatibility.get(assessmentId);
  }

  async planSaveReplacement(input: {
    assessmentId: string;
    strategy: "direct_replace";
    reviewMode?: PlanReviewMode;
  }): Promise<Readonly<SaveReplacementPlan>> {
    return await this.#replacements.planReplacement(input);
  }

  async planEldenRingStagedReplacement(
    stagedImportId: string,
    options: { reviewMode?: PlanReviewMode } = {},
  ): Promise<Readonly<SaveReplacementPlan>> {
    return await this.#replacements.planStagedSlotImport(stagedImportId, options);
  }

  async getSaveReplacementPlan(
    replacementPlanId: string,
  ): Promise<Readonly<SaveReplacementPlan>> {
    return await this.#replacements.getPlan(replacementPlanId);
  }

  async applySaveReplacement(
    replacementPlanId: string,
  ): Promise<AppliedSaveReplacement> {
    return await this.#replacements.applyReplacement(replacementPlanId);
  }

  async verifySaveReplacement(
    recordId: string,
  ): Promise<Readonly<SaveOperationRecord>> {
    return await this.#replacements.verifyReplacement(recordId);
  }

  async recordSaveRuntimeVerification(input: {
    operationRecordId: string;
    outcome: SaveRuntimeVerificationRecord["outcome"];
    notes?: string;
  }): Promise<Readonly<SaveRuntimeVerificationRecord>> {
    return await this.#runtimeVerifications.record(input);
  }

  async getSaveRuntimeVerification(
    verificationId: string,
  ): Promise<Readonly<SaveRuntimeVerificationRecord>> {
    return await this.#runtimeVerifications.get(verificationId);
  }

  async beginSaveLocationProbe(
    installContextId: string,
  ): Promise<Readonly<SaveLocationProbe>> {
    const install = await this.#contexts.getInstallContext(installContextId);
    const profile = this.#profiles.findByCanonicalGameId(
      install.game.canonicalId,
    );
    if (!profile) {
      throw new NexusError(
        "SAVE_ADAPTER_UNSUPPORTED",
        "A bounded probe root is unavailable because no Game Save Profile matches this game.",
        { details: { gameCanonicalId: install.game.canonicalId } },
      );
    }
    const observationRoots = [
      ...new Set(
        profile.discovery.probeRootTemplates.map((template) =>
          expandSaveTemplate(template, this.#environment, null),
        ),
      ),
    ];
    const before = await Promise.all(
      observationRoots.map(async (root) => await snapshotSaveRoot(root)),
    );
    const startedAt = new Date();
    const withoutHash = {
      schemaVersion: 1 as const,
      probeId: randomUUID(),
      installContextId,
      profileId: profile.profileId,
      status: "pending" as const,
      observationRoots,
      before,
      after: null,
      changes: [],
      learnedProfileId: null,
      saveContextId: null,
      startedAt: startedAt.toISOString(),
      expiresAt: new Date(
        startedAt.getTime() + this.#probeTtlMs,
      ).toISOString(),
      completedAt: null,
    };
    return await this.#probes.saveStarted(
      saveLocationProbeSchema.parse({
        ...withoutHash,
        probeHash: sha256CanonicalJson(withoutHash),
      }),
    );
  }

  async completeSaveLocationProbe(
    probeId: string,
  ): Promise<CompleteSaveLocationProbeResult> {
    const started = await this.#probes.get(probeId);
    if (started.status === "completed") {
      const [saveContext, learnedProfile] = await Promise.all([
        started.saveContextId
          ? this.#contexts.getSaveContext(started.saveContextId)
          : Promise.resolve(null),
        started.learnedProfileId
          ? this.#learnedProfiles
              .listForGame(
                (
                  await this.#contexts.getInstallContext(
                    started.installContextId,
                  )
                ).game.canonicalId,
              )
              .then(
                (profiles) =>
                  profiles.find(
                    (profile) =>
                      profile.learnedProfileId === started.learnedProfileId,
                  ) ?? null,
              )
          : Promise.resolve(null),
      ]);
      return { probe: started, learnedProfile, saveContext };
    }
    if (Date.parse(started.expiresAt) <= Date.now()) {
      throw new NexusError(
        "SAVE_PROBE_EXPIRED",
        "The Save Location Probe expired before completion.",
        { details: { probeId, expiresAt: started.expiresAt } },
      );
    }
    const install = await this.#contexts.getInstallContext(
      started.installContextId,
    );
    const profile = this.#profiles.findById(started.profileId);
    if (!profile) {
      throw new NexusError(
        "SAVE_CONTEXT_STALE",
        "The Game Save Profile used by this probe is no longer registered.",
        { details: { profileId: started.profileId } },
      );
    }
    const after = await Promise.all(
      started.observationRoots.map(
        async (root) => await snapshotSaveRoot(root),
      ),
    );
    const changes = diffSaveSnapshots(started.before, after);
    const essentialNames = new Set(
      profile.saveUnits.flatMap((unit) =>
        unit.essential.map((entry) =>
          path.basename(entry).toLowerCase(),
        ),
      ),
    );
    const candidateRoots = new Set<string>();
    for (const change of changes) {
      if (
        change.after?.kind === "file" &&
        essentialNames.has(path.basename(change.relativePath).toLowerCase())
      ) {
        candidateRoots.add(
          path.dirname(
            path.resolve(
              change.root,
              ...change.relativePath.split("/"),
            ),
          ),
        );
      }
    }

    let learnedProfile: Readonly<LearnedSaveProfile> | null = null;
    let saveContext: Readonly<SaveContext> | null = null;
    if (
      candidateRoots.size === 1 &&
      !after.some((snapshot) => snapshot.truncated)
    ) {
      const saveRoot = [...candidateRoots][0];
      if (!saveRoot) {
        throw new NexusError(
          "SAVE_CONTEXT_NOT_FOUND",
          "The differential probe candidate root could not be read.",
        );
      }
      const observedRelativePaths = await existingChangedPaths(
        saveRoot,
        changes,
      );
      if (observedRelativePaths.length > 0) {
        const learnedWithoutHash = {
          schemaVersion: 1 as const,
          learnedProfileId: randomUUID(),
          gameCanonicalId: install.game.canonicalId,
          gameRootFingerprint: gameRootFingerprint(install.gameRoot),
          saveRoot,
          observedRelativePaths,
          evidenceHash: sha256CanonicalJson({
            probeId,
            changes,
          }),
          state: "local_verified" as const,
          verifiedAt: new Date().toISOString(),
        };
        learnedProfile = await this.#learnedProfiles.save(
          learnedSaveProfileSchema.parse({
            ...learnedWithoutHash,
            profileHash: sha256CanonicalJson(learnedWithoutHash),
          }),
        );
        const resolved = await this.#resolver.resolve(install);
        const probeEvidenceObservedAt = new Date().toISOString();
        const { contextHash: _resolvedHash, ...resolvedWithoutHash } =
          resolved;
        const updatedWithoutHash = {
          ...resolvedWithoutHash,
          verification: {
            state: "confirmed" as const,
            method: "differential-probe" as const,
          },
          evidence: [
            ...resolved.evidence,
            {
              kind: "differential-probe" as const,
              path: saveRoot,
              detail: `Probe ${probeId} uniquely observed a Save Unit change.`,
              observedAt: probeEvidenceObservedAt,
            },
          ],
        };
        saveContext = await this.#contexts.saveSaveContext({
          ...updatedWithoutHash,
          contextHash: sha256CanonicalJson(updatedWithoutHash),
        });
      }
    }
    const completedAt = new Date().toISOString();
    const completedWithoutHash = {
      ...started,
      status: "completed" as const,
      after,
      changes,
      learnedProfileId: learnedProfile?.learnedProfileId ?? null,
      saveContextId: saveContext?.saveContextId ?? null,
      completedAt,
    };
    const { probeHash: _oldHash, ...completedHashPayload } =
      completedWithoutHash;
    const probe = await this.#probes.saveCompleted(
      saveLocationProbeSchema.parse({
        ...completedHashPayload,
        probeHash: sha256CanonicalJson(completedHashPayload),
      }),
    );
    return { probe, learnedProfile, saveContext };
  }

  #requireSources(): SaveSourceService {
    if (!this.#sources) {
      throw new NexusError(
        "SAVE_SOURCE_UNAVAILABLE",
        "Online save source capability was not configured for this Save Service.",
      );
    }
    return this.#sources;
  }
}
