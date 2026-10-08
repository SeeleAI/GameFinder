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
import { AdapterRequirementAssessor, type AdapterIntendedOperation } from "./adapter-assessment/adapter-requirement-assessor.js";
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
import { SaveContextResolverV2 } from "./context/save-context-v2-resolver.js";
import { SaveInstallResolverRegistryV2 } from "./install-resolvers/resolver-registry.js";
import type { PeMetadataReader } from "./install-resolvers/types.js";
import { SaveLocationStrategyRegistryV2 } from "./location-strategies/registry.js";
import { windowsSaveEnvironmentV2 } from "./location-strategies/windows-known-folders.js";
import { materializeSaveUnitsV2 } from "./layout-families/materializer.js";
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
import { SaveCompatibilityAssessorV2 } from "./replacement/compatibility-assessor-v2.js";
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
import { GameInstallContextV2Store } from "./storage/install-context-v2-store.js";
import { LearnedSaveProfileStore } from "./storage/learned-profile-store.js";
import { SaveProbeStore } from "./storage/probe-store.js";
import { SaveContextV2Store } from "./storage/save-context-v2-store.js";
import { GameSaveRecipeRegistryV2 } from "./recipes/recipe-registry.js";
import type { GameInstallContextV2 } from "./v2/contracts.js";
import type { SaveContextV2 } from "./v2/contracts.js";
import { gameInstallContextV2LegacyProjection, recipeLegacyTransactionProfile, saveContextV2LegacyProjection } from "./v2/legacy-bridge.js";

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
  peMetadataReader?: PeMetadataReader;
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
  readonly #installContextsV2: GameInstallContextV2Store;
  readonly #installResolversV2: SaveInstallResolverRegistryV2;
  readonly #recipesV2: GameSaveRecipeRegistryV2;
  readonly #locationStrategiesV2: SaveLocationStrategyRegistryV2;
  readonly #saveContextsV2: SaveContextV2Store;
  readonly #saveResolverV2: SaveContextResolverV2;
  readonly #peMetadataReader: PeMetadataReader | undefined;
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
  readonly #compatibilityV2: SaveCompatibilityAssessorV2;
  readonly #adapterRequirements: AdapterRequirementAssessor;
  readonly #replacements: SaveReplacementService;
  readonly #runtimeVerifications: SaveRuntimeVerificationService;
  readonly #sources: SaveSourceService | null;
  readonly #eldenRingSlots: EldenRingSlotImportService;

  private constructor(input: {
    profiles: GameSaveProfileRegistry;
    contexts: SaveContextStore;
    installContextsV2: GameInstallContextV2Store;
    installResolversV2: SaveInstallResolverRegistryV2;
    recipesV2: GameSaveRecipeRegistryV2;
    locationStrategiesV2: SaveLocationStrategyRegistryV2;
    saveContextsV2: SaveContextV2Store;
    saveResolverV2: SaveContextResolverV2;
    peMetadataReader?: PeMetadataReader;
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
    compatibilityV2: SaveCompatibilityAssessorV2;
    adapterRequirements: AdapterRequirementAssessor;
    replacements: SaveReplacementService;
    runtimeVerifications: SaveRuntimeVerificationService;
    sources: SaveSourceService | null;
    eldenRingSlots: EldenRingSlotImportService;
  }) {
    this.#profiles = input.profiles;
    this.#contexts = input.contexts;
    this.#installContextsV2 = input.installContextsV2;
    this.#installResolversV2 = input.installResolversV2;
    this.#recipesV2 = input.recipesV2;
    this.#locationStrategiesV2 = input.locationStrategiesV2;
    this.#saveContextsV2 = input.saveContextsV2;
    this.#saveResolverV2 = input.saveResolverV2;
    this.#peMetadataReader = input.peMetadataReader;
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
    this.#compatibilityV2 = input.compatibilityV2;
    this.#adapterRequirements = input.adapterRequirements;
    this.#replacements = input.replacements;
    this.#runtimeVerifications = input.runtimeVerifications;
    this.#sources = input.sources;
    this.#eldenRingSlots = input.eldenRingSlots;
  }

  static async create(options: SaveServiceOptions): Promise<SaveService> {
    const environment = resolveEnvironment(options.environment);
    const recipesV2 = await GameSaveRecipeRegistryV2.fromDirectory();
    const baseProfiles = new GameSaveProfileRegistry(options.profiles);
    const profileCanonicalIds = new Set(baseProfiles.list().map((profile) => profile.game.canonicalId));
    const profiles = new GameSaveProfileRegistry([
      ...baseProfiles.list(),
      ...(options.profiles === undefined ? recipesV2.list() : [])
        .filter((recipe) => !profileCanonicalIds.has(recipe.game.canonicalId))
        .map(recipeLegacyTransactionProfile),
    ]);
    const [contexts, installContextsV2, saveContextsV2, learnedProfiles, probes] = await Promise.all([
      SaveContextStore.create(options.managerRoot),
      GameInstallContextV2Store.create(options.managerRoot),
      SaveContextV2Store.create(options.managerRoot),
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
      recipes: recipesV2,
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
    const adapterRequirements = await AdapterRequirementAssessor.create({
      managerRoot: options.managerRoot,
      contexts: saveContextsV2,
      installs: installContextsV2,
      packages: normalizer,
      recipes: recipesV2,
    });
    const compatibilityV2 = await SaveCompatibilityAssessorV2.create({
      managerRoot: options.managerRoot,
      contexts: saveContextsV2,
      packages: normalizer,
      adapterRequirements,
      recipes: recipesV2,
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
    const locationStrategiesV2 = new SaveLocationStrategyRegistryV2();
    return new SaveService({
      profiles,
      contexts,
      installContextsV2,
      installResolversV2: new SaveInstallResolverRegistryV2(),
      recipesV2,
      locationStrategiesV2,
      saveContextsV2,
      saveResolverV2: new SaveContextResolverV2({
        recipes: recipesV2,
        strategies: locationStrategiesV2,
        environment: windowsSaveEnvironmentV2(options.environment),
      }),
      ...(options.peMetadataReader === undefined ? {} : { peMetadataReader: options.peMetadataReader }),
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
      compatibilityV2,
      adapterRequirements,
      replacements,
      runtimeVerifications,
      sources,
      eldenRingSlots,
    });
  }

  listProfiles(): ReadonlyArray<GameSaveProfile> {
    return this.#profiles.list();
  }

  listRecipesV2() {
    return this.#recipesV2.list();
  }

  listInstallResolversV2() {
    return this.#installResolversV2.list().map((resolver) => ({
      schemaVersion: 2 as const,
      resolverId: resolver.resolverId,
      resolverVersion: resolver.resolverVersion,
      distributionKind: resolver.distributionKind,
      supportedPlatforms: ["windows"] as const,
    }));
  }

  getRecipeV2(recipeId: string) {
    const recipe = this.#recipesV2.findById(recipeId);
    if (!recipe) throw new NexusError("SAVE_RECIPE_NOT_FOUND", "The requested Game Save Recipe was not found.");
    return recipe;
  }

  listLocationStrategiesV2() {
    return this.#locationStrategiesV2.list().map((strategy) => ({
      schemaVersion: 2 as const,
      strategyId: strategy.strategyId,
      strategyVersion: strategy.strategyVersion,
      boundedProbeCapable: true,
    }));
  }

  listLayoutFamiliesV2() {
    return [
      "single-file",
      "slot-file-set",
      "container-with-companions",
      "directory-tree",
      "profile-plus-slots",
    ].map((layoutFamily) => ({ schemaVersion: 2 as const, layoutFamily, layoutVersion: "1.0.0" }));
  }

  async probeGameInstall(input: { gameRoot: string }): Promise<Readonly<GameInstallContext>>;
  async probeGameInstall(input: {
    gameRoot: string;
    recipeId?: string;
    resolverHint?: string;
  }): Promise<Readonly<GameInstallContext | GameInstallContextV2>>;
  async probeGameInstall(input: {
    gameRoot: string;
    recipeId?: string;
    resolverHint?: string;
  }): Promise<Readonly<GameInstallContext | GameInstallContextV2>> {
    const contextV2 = await this.#installResolversV2.probe({
      gameRoot: input.gameRoot,
      recipes: this.#recipesV2,
      ...(input.recipeId === undefined ? {} : { recipeId: input.recipeId }),
      ...(input.resolverHint === undefined ? {} : { resolverHint: input.resolverHint }),
      ...(this.#peMetadataReader === undefined ? {} : { peMetadataReader: this.#peMetadataReader }),
    });
    if (contextV2.distributionKind !== "steam-library") {
      const saved = await this.#installContextsV2.save(contextV2);
      await this.#contexts.saveInstallContext(gameInstallContextV2LegacyProjection(saved));
      return saved;
    }
    const legacy = await probeSteamGameInstall({ gameRoot: input.gameRoot, profiles: this.#profiles });
    return await this.#contexts.saveInstallContext(legacy);
  }

  async getGameInstallContext(
    installContextId: string,
  ): Promise<Readonly<GameInstallContext | GameInstallContextV2>> {
    try {
      return await this.#installContextsV2.get(installContextId);
    } catch (error) {
      if (!(error instanceof NexusError) || error.code !== "NOT_FOUND") throw error;
      return await this.#contexts.getInstallContext(installContextId);
    }
  }

  async resolveSaveLocations(
    installContextId: string,
  ): Promise<Readonly<SaveContext>> {
    try {
      const install = await this.#installContextsV2.get(installContextId);
      const context = await this.#saveResolverV2.resolve(install);
      const saved = await this.#saveContextsV2.save(context);
      await this.#contexts.saveSaveContext(saveContextV2LegacyProjection(saved));
      return saved as unknown as Readonly<SaveContext>;
    } catch (error) {
      if (!(error instanceof NexusError) || error.code !== "NOT_FOUND") throw error;
    }
    const install = await this.#contexts.getInstallContext(installContextId);
    const context = await this.#resolver.resolve(install);
    return await this.#contexts.saveSaveContext(context);
  }

  async getSaveContext(
    saveContextId: string,
  ): Promise<Readonly<SaveContext>> {
    try {
      return await this.#saveContextsV2.get(saveContextId) as unknown as Readonly<SaveContext>;
    } catch (error) {
      if (!(error instanceof NexusError) || error.code !== "NOT_FOUND") throw error;
      return await this.#contexts.getSaveContext(saveContextId);
    }
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
    let additionalManagedPaths: string[] | undefined;
    try {
      const [context, backup] = await Promise.all([
        this.#saveContextsV2.get(input.saveContextId),
        this.#backups.verifyBackup(input.backupId),
      ]);
      const recipe = this.#recipesV2.findById(context.recipe.recipeId);
      const root = context.saveRoots.find((candidate) => candidate.role === "primary");
      if (recipe && recipe.recipeHash === context.recipe.recipeHash && root) {
        const materialized = await materializeSaveUnitsV2(root.absolutePath, recipe);
        additionalManagedPaths = materialized
          .find((candidate) => candidate.unitId === backup.unitId)
          ?.files.map((file) => file.relativePath);
      }
    } catch (error) {
      if (!(error instanceof NexusError) || error.code !== "NOT_FOUND") throw error;
    }
    return await this.#restores.planRestore({
      ...input,
      ...(additionalManagedPaths === undefined ? {} : { additionalManagedPaths }),
    });
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
    target: { saveContextId?: string; recipeId?: string; unitId?: string } = {},
  ): Promise<Readonly<SaveInputInspection>> {
    if (target.saveContextId && target.recipeId) {
      throw new NexusError("SAVE_CONTRACT_INVALID", "Provide saveContextId or recipeId, not both.");
    }
    let recipe = target.recipeId ? this.#recipesV2.findById(target.recipeId) : null;
    if (target.saveContextId) {
      const context = await this.#saveContextsV2.get(target.saveContextId);
      recipe = this.#recipesV2.findById(context.recipe.recipeId);
      if (!recipe || recipe.recipeHash !== context.recipe.recipeHash) {
        throw new NexusError("SAVE_RECIPE_NOT_FOUND", "The Save Context Recipe is unavailable or changed.");
      }
    }
    if ((target.saveContextId || target.recipeId) && !recipe) {
      throw new NexusError("SAVE_RECIPE_NOT_FOUND", "The requested Game Save Recipe was not found.");
    }
    return await this.#inputInspector.inspect(
      inputPath,
      recipe ? { recipe, ...(target.unitId === undefined ? {} : { unitId: target.unitId }) } : undefined,
    );
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
    const target = await this.#researchTarget(input.installContextId);
    const domainName = target.nexusDomainName;
    if (!domainName) {
      throw new NexusError(
        "SAVE_ADAPTER_UNSUPPORTED",
        "No Nexus game domain is mapped for this Game Save Profile.",
      );
    }
    return await sources.researchNexus({
      game: target.game,
      domainName,
      ...(input.query ? { query: input.query } : {}),
      ...(input.maxCandidates ? { maxCandidates: input.maxCandidates } : {}),
    });
  }

  async researchSpeedrunSaveSources(input: {
    installContextId: string;
  }): Promise<SaveSourceResearchResult> {
    const sources = this.#requireSources();
    const target = await this.#researchTarget(input.installContextId);
    const gameSlug = target.speedrunGameSlug;
    if (!gameSlug) {
      throw new NexusError(
        "SAVE_ADAPTER_UNSUPPORTED",
        "No Speedrun game slug is mapped for this Game Save Profile.",
      );
    }
    return await sources.researchSpeedrunOnline({
      game: target.game,
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
    const target = await this.#researchTarget(input.installContextId);
    const gameSlug = target.speedrunGameSlug;
    if (!gameSlug) {
      throw new NexusError("SAVE_ADAPTER_UNSUPPORTED", "No Speedrun game slug is mapped for this game.");
    }
    return await sources.researchSpeedrunFromSnapshot({
      game: target.game,
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
    const candidate = await this.#requireSources().getCandidate(receipt.candidateId);
    const recipes = this.#recipesV2.findCandidates({ canonicalId: candidate.game.canonicalId });
    if (recipes.length !== 1) {
      throw new NexusError(recipes.length === 0 ? "SAVE_RECIPE_NOT_FOUND" : "SAVE_RECIPE_AMBIGUOUS", "Downloaded save source does not resolve to one Game Save Recipe.", {
        details: { candidateId: candidate.candidateId, recipeIds: recipes.map((recipe) => recipe.recipeId) },
      });
    }
    const inspection = await this.#inputInspector.inspect(receipt.absolutePath, { recipe: recipes[0]! });
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
    try {
      return await this.#compatibilityV2.assess(input) as unknown as Readonly<SaveCompatibilityAssessment>;
    } catch (error) {
      if (!(error instanceof NexusError) || error.code !== "NOT_FOUND") throw error;
      return await this.#compatibility.assess(input);
    }
  }

  async assessSaveAdapterRequirement(input: {
    saveContextId: string;
    packageId?: string;
    intendedOperation: AdapterIntendedOperation;
    sourceSlot?: number;
    targetSlot?: number;
    allowWholeUnitFallback?: boolean;
  }) {
    return await this.#adapterRequirements.assess(input);
  }

  async getSaveAdapterRequirementAssessment(assessmentId: string) {
    return await this.#adapterRequirements.get(assessmentId);
  }

  async getSaveAdapterDevelopmentBrief(briefId: string) {
    return await this.#adapterRequirements.getBrief(briefId);
  }

  async getSaveCompatibilityAssessment(
    assessmentId: string,
  ): Promise<Readonly<SaveCompatibilityAssessment>> {
    try {
      return await this.#compatibilityV2.get(assessmentId) as unknown as Readonly<SaveCompatibilityAssessment>;
    } catch (error) {
      if (!(error instanceof NexusError) || error.code !== "NOT_FOUND") throw error;
      return await this.#compatibility.get(assessmentId);
    }
  }

  async planSaveReplacement(input: {
    assessmentId: string;
    strategy: "direct_replace";
    reviewMode?: PlanReviewMode;
  }): Promise<Readonly<SaveReplacementPlan>> {
    let compatibilityV2;
    try {
      compatibilityV2 = await this.#compatibilityV2.get(input.assessmentId);
    } catch (error) {
      if (!(error instanceof NexusError) || error.code !== "NOT_FOUND") throw error;
      return await this.#replacements.planReplacement(input);
    }
    if (!compatibilityV2.adapterRequirementAssessmentId || !compatibilityV2.adapterRequirementAssessmentHash) {
      throw new NexusError("SAVE_ADAPTER_UNSUPPORTED", "The V2 Compatibility Assessment predates G6 Adapter gating; reassess the package.");
    }
    const requirement = await this.#adapterRequirements.get(compatibilityV2.adapterRequirementAssessmentId);
    this.#adapterRequirements.assertCurrent(requirement);
    if (
      requirement.assessmentHash !== compatibilityV2.adapterRequirementAssessmentHash ||
      requirement.packageId !== compatibilityV2.packageId ||
      requirement.packageManifestHash !== compatibilityV2.packageManifestHash ||
      requirement.saveContextId !== compatibilityV2.saveContextId ||
      requirement.saveContextHash !== compatibilityV2.saveContextHash ||
      !compatibilityV2.replacementPlanAllowed ||
      !requirement.replacementPlanAllowed ||
      !(
        ["not_required", "recommended"].includes(requirement.requirement) ||
        (
          requirement.requirement === "required" &&
          requirement.adapterAvailability === "matched" &&
          requirement.reasonCodes.includes("FORMAT_ADAPTER_VALIDATED_EXACT_REPLACEMENT")
        )
      )
    ) {
      throw new NexusError("SAVE_ADAPTER_UNSUPPORTED", "Adapter Requirement Assessment blocks generic direct replacement.", {
        details: { requirement: requirement.requirement, reasonCodes: requirement.reasonCodes },
      });
    }
    await this.#compatibility.saveV2TransactionBridge({
      assessmentId: compatibilityV2.assessmentId,
      packageId: compatibilityV2.packageId,
      packageManifestHash: compatibilityV2.packageManifestHash,
      saveContextId: compatibilityV2.saveContextId,
      reasons: [
        ...compatibilityV2.reasons,
        `G7 transaction bridge is bound to Adapter Requirement Assessment ${requirement.assessmentId}/${requirement.assessmentHash}.`,
      ],
      warnings: compatibilityV2.warnings,
      assessedAt: compatibilityV2.assessedAt,
    });
    return await this.#replacements.planReplacement({
      ...input,
      replacementMode: "exact-unit",
      authorizedTargetPaths: compatibilityV2.targetMappings.map(
        (mapping) => mapping.targetRelativePath,
      ),
    });
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
    const essentialPatterns = new Set(
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
        [...essentialPatterns].some((pattern) => {
          const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
          return new RegExp(`^${escaped}$`, "i").test(path.basename(change.relativePath));
        })
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

  async #researchTarget(installContextId: string): Promise<{
    game: { canonicalId: string; displayName: string; storeAppId: string | null };
    nexusDomainName: string | null;
    speedrunGameSlug: string | null;
  }> {
    try {
      const install = await this.#contexts.getInstallContext(installContextId);
      const profile = this.#profiles.findByCanonicalGameId(install.game.canonicalId);
      return {
        game: install.game,
        nexusDomainName: profile?.sources?.nexusDomainName ?? null,
        speedrunGameSlug: profile?.sources?.speedrunGameSlug ?? null,
      };
    } catch (error) {
      if (!(error instanceof NexusError) || error.code !== "NOT_FOUND") throw error;
    }
    const install = await this.#installContextsV2.get(installContextId);
    const recipe = install.recipe ? this.#recipesV2.findById(install.recipe.recipeId) : null;
    if (!recipe || recipe.recipeHash !== install.recipe?.recipeHash) {
      throw new NexusError("SAVE_RECIPE_NOT_FOUND", "The Install Context Recipe is unavailable or changed.");
    }
    return {
      game: {
        canonicalId: recipe.game.canonicalId,
        displayName: recipe.game.displayName,
        storeAppId: recipe.game.platformAppIds.steam ?? null,
      },
      nexusDomainName: recipe.sources.nexusDomainName,
      speedrunGameSlug: recipe.sources.speedrunGameSlug,
    };
  }
}
