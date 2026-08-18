import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { NexusError } from "../errors.js";
import type { AdapterInstanceCompatibility } from "./adapter.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { SmapiFolderModAdapter } from "./adapters/smapi-folder-mod.js";
import { inspectZipArchive } from "./archive-inspector.js";
import { sha256CanonicalJson } from "./content-hash.js";
import type {
  GameInstance,
  GameProfile,
  InstallPlan,
  OperationOutcome,
  PackageAnalysis,
  PackageUnit,
  PathState,
  TransactionPhase,
  UninstallPlan,
} from "./contracts.js";
import { packageAnalysisSchema } from "./contracts.js";
import { planModInstall, type InstallPlanResult } from "./core/install-planner.js";
import { RecoveryManager, type RecoveryResult } from "./core/recovery-manager.js";
import { StagingManager } from "./core/staging-manager.js";
import { inspectInstallationState } from "./core/state-inspector.js";
import {
  inspectDirectoryTree,
  inspectPathState,
} from "./core/tree-state.js";
import {
  TransactionEngine,
  type ApplyInstallResult,
} from "./core/transaction-engine.js";
import {
  UninstallEngine,
  type ApplyUninstallResult,
} from "./core/uninstall-engine.js";
import {
  planModUninstall,
  type UninstallPlanResult,
} from "./core/uninstall-planner.js";
import {
  verifyInstallInput,
  type ExpectedNexusSource,
  type VerifiedInstallInput,
} from "./input-verifier.js";
import { analyzePackageInventory } from "./package-analyzer.js";
import {
  probeStardewValleyInstance,
  STARDEW_VALLEY_PROFILE,
} from "./profiles/stardew-valley.js";
import { BackupStore } from "./storage/backup-store.js";
import { InstallationRecordStore } from "./storage/installation-record-store.js";
import { PlanExecutionContextStore } from "./storage/plan-execution-context-store.js";
import { PlanStore } from "./storage/plan-store.js";
import { TransactionJournalStore } from "./storage/transaction-journal-store.js";
import { UninstallPlanStore } from "./storage/uninstall-plan-store.js";
import type { PlanReviewMode } from "../plan-review.js";
import {
  AGENTIC_FILE_METHOD_ADAPTER_ID,
  AgenticFileMethodAdapter,
} from "./v2/agentic-file-method-adapter.js";
import { LegacyV1CompatibilityProvider } from "./v2/legacy-compatibility-provider.js";
import { resolveManagedTarget } from "./path-policy.js";

export interface InstallInputReference {
  archivePath: string;
  receiptPath: string;
  expectedSource?: ExpectedNexusSource;
}

export interface InspectedInstallInput {
  verifiedInput: VerifiedInstallInput;
  inventory: Awaited<ReturnType<typeof inspectZipArchive>>;
  analysis: PackageAnalysis;
}

export interface AdapterMatchSummary {
  adapterId: string;
  adapterVersion: string;
  state: string;
  confidence: number;
  packageUnitIds: string[];
  positiveSignals: string[];
  negativeSignals: string[];
  missingEvidence: string[];
  requiresUserChoice: boolean;
  compatibility: AdapterInstanceCompatibility | null;
}

export interface PlannedInstall {
  result: InstallPlanResult;
  analysis: PackageAnalysis;
  instance: GameInstance;
  profile: GameProfile;
  verifiedInput: VerifiedInstallInput;
}

export interface UninstallVerificationCheck {
  operationId: string;
  operationKind: OperationOutcome["operationKind"];
  targetRelativePath: string;
  passed: boolean;
  expected: string;
  actual: PathState | ReadonlyArray<{
    targetRelativePath: string;
    state: PathState;
  }>;
}

export interface VerifyUninstallResult {
  record: Awaited<ReturnType<InstallService["getInstallation"]>>;
  passed: boolean;
  checks: ReadonlyArray<UninstallVerificationCheck>;
  retainedFilePaths: ReadonlyArray<string>;
}

export interface UninstallPlanLifecycle {
  uninstallPlanId: string;
  state:
    | "planned"
    | "stale"
    | "applying"
    | "committed"
    | "failed"
    | "recovery_required";
  reason:
    | "awaiting_apply"
    | "expired"
    | "installation_record_changed"
    | "transaction_active"
    | "transaction_committed"
    | "transaction_rolled_back"
    | "transaction_recovery_required";
  transactionId: string | null;
  journalState: TransactionPhase | null;
  completedAt: string | null;
  observedAt: string;
}

function pathStateEquals(left: PathState, right: PathState): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "absent" || right.kind === "absent") return true;
  if (left.kind === "file" && right.kind === "file") {
    return left.bytes === right.bytes && left.sha256 === right.sha256;
  }
  if (left.kind === "directory" && right.kind === "directory") {
    return left.treeHash === right.treeHash;
  }
  return false;
}

export function resolveDefaultManagerRoot(): string {
  const configured = process.env.NEXUS_MODS_MANAGER_ROOT?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "NEXUS_MODS_MANAGER_ROOT must be an absolute path.",
      );
    }
    return path.resolve(configured);
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData && path.isAbsolute(localAppData)) {
      return path.join(path.resolve(localAppData), "GameModToolkit");
    }
  }
  return path.join(os.homedir(), ".local", "share", "GameModToolkit");
}

function selectedAnalysis(
  analysis: PackageAnalysis,
  packageUnitId: string | undefined,
): { analysis: PackageAnalysis; packageUnit: PackageUnit } {
  if (analysis.packages.length === 0) {
    throw new NexusError(
      "ADAPTER_NOT_FOUND",
      "The archive contains no supported package unit.",
      { details: { ambiguities: analysis.ambiguities } },
    );
  }
  if (packageUnitId === undefined && analysis.packages.length !== 1) {
    throw new NexusError(
      "ADAPTER_AMBIGUOUS",
      "The archive contains multiple package units; select one packageUnitId.",
      {
        details: {
          packages: analysis.packages.map((unit) => ({
            packageUnitId: unit.packageUnitId,
            packageRoot: unit.packageRoot,
            identity: unit.identity,
          })),
        },
      },
    );
  }
  const packageUnit =
    packageUnitId === undefined
      ? analysis.packages[0]
      : analysis.packages.find((unit) => unit.packageUnitId === packageUnitId);
  if (!packageUnit) {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      "The requested packageUnitId is not present in Package Analysis.",
      { details: { packageUnitId } },
    );
  }
  if (analysis.packages.length === 1) return { analysis, packageUnit };

  const ambiguities = analysis.ambiguities.filter(
    (ambiguity) =>
      ambiguity.packageUnitIds.length === 0 ||
      ambiguity.packageUnitIds.includes(packageUnit.packageUnitId),
  );
  const hashPayload = {
    schemaVersion: 1 as const,
    analyzerVersion: analysis.analyzerVersion,
    archive: analysis.archive,
    packages: [packageUnit],
    ambiguities,
  };
  return {
    analysis: packageAnalysisSchema.parse({
      ...hashPayload,
      analysisId: randomUUID(),
      analysisHash: sha256CanonicalJson(hashPayload),
      analyzedAt: new Date().toISOString(),
    }),
    packageUnit,
  };
}

function conventionalStardewRoots(): string[] {
  if (process.platform !== "win32") return [];
  const roots = new Set<string>();
  const programRoots = [
    process.env["ProgramFiles(x86)"],
    process.env.ProgramFiles,
    process.env.ProgramW6432,
  ].filter((value): value is string => Boolean(value?.trim()));
  for (const programRoot of programRoots) {
    roots.add(
      path.join(
        programRoot,
        "Steam",
        "steamapps",
        "common",
        "Stardew Valley",
      ),
    );
    roots.add(path.join(programRoot, "GOG Galaxy", "Games", "Stardew Valley"));
  }
  return [...roots];
}

export class InstallService {
  readonly managerRoot: string;
  readonly #profiles: ReadonlyMap<string, GameProfile>;
  readonly #registry: AdapterRegistry;
  readonly #planStore: PlanStore;
  readonly #contextStore: PlanExecutionContextStore;
  readonly #backupStore: BackupStore;
  readonly #journalStore: TransactionJournalStore;
  readonly #recordStore: InstallationRecordStore;
  readonly #uninstallPlanStore: UninstallPlanStore;

  private constructor(input: {
    managerRoot: string;
    profiles: ReadonlyMap<string, GameProfile>;
    registry: AdapterRegistry;
    planStore: PlanStore;
    contextStore: PlanExecutionContextStore;
    backupStore: BackupStore;
    journalStore: TransactionJournalStore;
    recordStore: InstallationRecordStore;
    uninstallPlanStore: UninstallPlanStore;
  }) {
    this.managerRoot = input.managerRoot;
    this.#profiles = input.profiles;
    this.#registry = input.registry;
    this.#planStore = input.planStore;
    this.#contextStore = input.contextStore;
    this.#backupStore = input.backupStore;
    this.#journalStore = input.journalStore;
    this.#recordStore = input.recordStore;
    this.#uninstallPlanStore = input.uninstallPlanStore;
  }

  static async create(options: { managerRoot?: string } = {}): Promise<InstallService> {
    const managerRoot = path.resolve(
      options.managerRoot ?? resolveDefaultManagerRoot(),
    );
    if (managerRoot === path.parse(managerRoot).root) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "A filesystem root cannot be used as the Mod manager state directory.",
      );
    }
    const [
      planStore,
      contextStore,
      backupStore,
      journalStore,
      recordStore,
      uninstallPlanStore,
    ] = await Promise.all([
      PlanStore.create({ managerRoot }),
      PlanExecutionContextStore.create(managerRoot),
      BackupStore.create(managerRoot),
      TransactionJournalStore.create(managerRoot),
      InstallationRecordStore.create(managerRoot),
      UninstallPlanStore.create({ managerRoot }),
    ]);
    return new InstallService({
      managerRoot,
      profiles: new Map([
        [STARDEW_VALLEY_PROFILE.profileId, STARDEW_VALLEY_PROFILE],
      ]),
      registry: new AdapterRegistry([
        new SmapiFolderModAdapter(),
        new AgenticFileMethodAdapter(),
      ]),
      planStore,
      contextStore,
      backupStore,
      journalStore,
      recordStore,
      uninstallPlanStore,
    });
  }

  createLegacyCompatibilityProvider(): LegacyV1CompatibilityProvider {
    return new LegacyV1CompatibilityProvider({
      registry: new AdapterRegistry(
        this.#registry
          .list()
          .filter(
            (adapter) =>
              adapter.descriptor.adapterId !== AGENTIC_FILE_METHOD_ADAPTER_ID,
          ),
      ),
      profiles: this.listProfiles(),
    });
  }

  listProfiles(): GameProfile[] {
    return [...this.#profiles.values()];
  }

  getProfile(profileId: string): GameProfile {
    const profile = this.#profiles.get(profileId);
    if (!profile) {
      throw new NexusError(
        "GAME_PROFILE_NOT_FOUND",
        `Game Profile ${profileId} is not registered.`,
      );
    }
    return profile;
  }

  async probeGameInstall(input: {
    profileId: string;
    gameRoot: string;
  }): Promise<GameInstance> {
    const profile = this.getProfile(input.profileId);
    if (profile.profileId === STARDEW_VALLEY_PROFILE.profileId) {
      return await probeStardewValleyInstance({ gameRoot: input.gameRoot });
    }
    throw new NexusError(
      "GAME_PROFILE_NOT_FOUND",
      `Game Profile ${input.profileId} has no instance probe.`,
    );
  }

  async detectGameInstalls(input: {
    profileId: string;
    candidateRoots?: ReadonlyArray<string>;
  }): Promise<GameInstance[]> {
    this.getProfile(input.profileId);
    const candidates = new Set([
      ...(input.candidateRoots ?? []),
      ...(input.profileId === STARDEW_VALLEY_PROFILE.profileId
        ? conventionalStardewRoots()
        : []),
    ]);
    const instances: GameInstance[] = [];
    for (const gameRoot of candidates) {
      if (!path.isAbsolute(gameRoot)) continue;
      try {
        instances.push(
          await this.probeGameInstall({
            profileId: input.profileId,
            gameRoot,
          }),
        );
      } catch (error) {
        if (
          !(error instanceof NexusError) ||
          error.code !== "GAME_INSTANCE_NOT_FOUND"
        ) {
          throw error;
        }
      }
    }
    return instances;
  }

  async inspect(input: InstallInputReference): Promise<InspectedInstallInput> {
    const verifiedInput = await verifyInstallInput(input);
    const inventory = await inspectZipArchive({
      archive: verifiedInput.archive,
    });
    const analysis = await analyzePackageInventory(inventory);
    return { verifiedInput, inventory, analysis };
  }

  async matchAdapters(input: InstallInputReference & {
    profileId: string;
    gameRoot: string;
  }): Promise<{
    analysis: PackageAnalysis;
    instance: GameInstance;
    matches: AdapterMatchSummary[];
  }> {
    const [{ analysis }, instance] = await Promise.all([
      this.inspect(input),
      this.probeGameInstall(input),
    ]);
    const profile = this.getProfile(input.profileId);
    const context = { analysis, profile, instance };
    const matches = await this.#registry.matchAll(context);
    const summaries: AdapterMatchSummary[] = [];
    for (const { adapter, match } of matches) {
      let compatibility: AdapterInstanceCompatibility | null = null;
      if (match.state === "matched" && match.packageUnitIds.length === 1) {
        compatibility = await adapter.probeInstance(context, match);
      }
      summaries.push({ ...match, compatibility });
    }
    return { analysis, instance, matches: summaries };
  }

  async plan(input: InstallInputReference & {
    profileId: string;
    gameRoot: string;
    packageUnitId?: string;
    reviewMode?: PlanReviewMode;
  }): Promise<PlannedInstall> {
    const [{ verifiedInput, inventory, analysis: rawAnalysis }, instance] =
      await Promise.all([
        this.inspect(input),
        this.probeGameInstall(input),
      ]);
    const profile = this.getProfile(input.profileId);
    const { analysis, packageUnit } = selectedAnalysis(
      rawAnalysis,
      input.packageUnitId,
    );
    const stagingManager = await StagingManager.create({
      managerRoot: this.managerRoot,
      gameRoot: instance.gameRoot,
      liveModRoots: profile.filesystem.liveModRoots,
    });
    const stagedPackage = await stagingManager.stagePackage({
      inventory,
      packageRoot: packageUnit.packageRoot,
    });
    try {
      const result = await planModInstall({
        analysis,
        profile,
        instance,
        stagedPackage,
        registry: this.#registry,
        planStore: this.#planStore,
        ...(input.reviewMode === undefined
          ? {}
          : { reviewMode: input.reviewMode }),
      });
      await this.#contextStore.save({
        planId: result.plan.planId,
        planHash: result.plan.planHash,
        analysis,
        profile,
        instance,
        packageUnitId: result.packageUnit.packageUnitId,
        archivePath: verifiedInput.archive.absolutePath,
        receiptPath: verifiedInput.receipt.receiptPath,
        expectedSource: {
          domainName: verifiedInput.source.domainName,
          modId: verifiedInput.source.modId,
          fileId: verifiedInput.source.fileId,
        },
      });
      return {
        result,
        analysis,
        instance,
        profile,
        verifiedInput,
      };
    } catch (error) {
      await stagingManager.cleanup(stagedPackage.stagingId).catch(() => undefined);
      throw error;
    }
  }

  async apply(planId: string): Promise<ApplyInstallResult> {
    const [plan, context] = await Promise.all([
      this.#planStore.get(planId),
      this.#contextStore.get(planId),
    ]);
    if (plan.planHash !== context.planHash) {
      throw new NexusError(
        "PLAN_STALE",
        "Install Plan no longer matches its frozen execution context.",
      );
    }
    if (plan.review?.classification === "blocked") {
      throw new NexusError(
        "PLAN_REVIEW_BLOCKED",
        "Install Plan review classification blocks execution.",
        { details: { planId, reasonCodes: plan.review.reasonCodes } },
      );
    }
    const verifiedInput = await verifyInstallInput({
      archivePath: context.archivePath,
      receiptPath: context.receiptPath,
      expectedSource: context.expectedSource,
    });
    const stagingManager = await StagingManager.create({
      managerRoot: this.managerRoot,
      gameRoot: context.instance.gameRoot,
      liveModRoots: context.profile.filesystem.liveModRoots,
    });
    const engine = new TransactionEngine({
      managerRoot: this.managerRoot,
      planStore: this.#planStore,
      stagingManager,
      backupStore: this.#backupStore,
      journalStore: this.#journalStore,
      recordStore: this.#recordStore,
      adapterRegistry: this.#registry,
    });
    return await engine.applyInstallPlan({
      planId,
      profile: context.profile,
      instance: context.instance,
      analysis: context.analysis,
      packageUnitId: context.packageUnitId,
      verifiedInput,
    });
  }

  async getPlan(planId: string): Promise<Readonly<InstallPlan>> {
    return await this.#planStore.get(planId, { allowExpired: true });
  }

  async getTransaction(transactionId: string) {
    return await this.#journalStore.read(transactionId);
  }

  async getInstallation(installationId: string) {
    return await this.#recordStore.get(installationId);
  }

  async listInstallations() {
    return await this.#recordStore.listAll();
  }

  async getInstallationContext(installationId: string) {
    const record = await this.#recordStore.get(installationId);
    const context = await this.#contextStore.get(record.sourcePlanId);
    return {
      record,
      profile: context.profile,
      instance: context.instance,
    };
  }

  async inspectInstallation(installationId: string) {
    const { record, profile, instance } =
      await this.getInstallationContext(installationId);
    const inspection = await inspectInstallationState({
      record,
      profile,
      instance,
    });
    return { record, profile, instance, inspection };
  }

  async verifyInstallation(installationId: string) {
    const record = await this.#recordStore.get(installationId);
    const context = await this.#contextStore.get(record.sourcePlanId);
    const inspection = await inspectInstallationState({
      record,
      profile: context.profile,
      instance: context.instance,
    });
    const adapter = this.#registry.get(record.adapterId);
    const [staticVerification, runtimeVerification] = await Promise.all([
      adapter.verifyStatic(
        record,
        inspection,
        context.profile,
        context.instance,
      ),
      adapter.verifyRuntime(record, context.profile, context.instance),
    ]);
    return {
      record,
      inspection,
      staticVerification,
      runtimeVerification,
    };
  }

  async verifyUninstall(
    installationId: string,
  ): Promise<VerifyUninstallResult> {
    const { record, profile, instance } =
      await this.getInstallationContext(installationId);
    const checks: UninstallVerificationCheck[] = [];
    const retainedFilePaths: string[] = [];
    for (const outcome of record.operationOutcomes) {
      if (outcome.outcome !== "applied") continue;
      const target = resolveManagedTarget({
        gameRoot: instance.gameRoot,
        targetRelativePath: outcome.targetRelativePath,
        writableRoots: profile.filesystem.writableRoots,
        protectedRoots: profile.filesystem.protectedRoots,
      });
      switch (outcome.operationKind) {
        case "install_new_file": {
          const actual = await inspectPathState(target.targetAbsolutePath);
          checks.push({
            operationId: outcome.operationId,
            operationKind: outcome.operationKind,
            targetRelativePath: target.targetRelativePath,
            passed: actual.kind === "absent",
            expected: "installed file is absent",
            actual,
          });
          break;
        }
        case "replace_file":
        case "replace_managed_tree": {
          const actual = await inspectPathState(target.targetAbsolutePath);
          checks.push({
            operationId: outcome.operationId,
            operationKind: outcome.operationKind,
            targetRelativePath: target.targetRelativePath,
            passed: pathStateEquals(actual, outcome.preState),
            expected: "path matches its exact pre-install state",
            actual,
          });
          break;
        }
        case "install_tree": {
          const actual = await Promise.all(
            outcome.ownedFiles.map(async (file) => {
              const ownedTarget = resolveManagedTarget({
                gameRoot: instance.gameRoot,
                targetRelativePath: path.posix.join(
                  target.targetRelativePath,
                  file.relativePath,
                ),
                writableRoots: profile.filesystem.writableRoots,
                protectedRoots: profile.filesystem.protectedRoots,
              });
              return {
                targetRelativePath: ownedTarget.targetRelativePath,
                state: await inspectPathState(ownedTarget.targetAbsolutePath),
              };
            }),
          );
          checks.push({
            operationId: outcome.operationId,
            operationKind: outcome.operationKind,
            targetRelativePath: target.targetRelativePath,
            passed: actual.every((item) => item.state.kind === "absent"),
            expected:
              "every file owned by the installed tree is absent; unmanaged data may remain",
            actual,
          });
          const rootState = await inspectPathState(
            target.targetAbsolutePath,
          );
          if (rootState.kind === "directory") {
            const tree = await inspectDirectoryTree(
              target.targetAbsolutePath,
            );
            retainedFilePaths.push(
              ...tree.files.map((file) =>
                path.posix.join(
                  target.targetRelativePath,
                  file.relativePath,
                ),
              ),
            );
          }
          break;
        }
        case "ensure_directory": {
          const actual = await inspectPathState(target.targetAbsolutePath);
          const passed =
            outcome.preState.kind === "absent"
              ? actual.kind === "absent" || actual.kind === "directory"
              : actual.kind === "directory";
          checks.push({
            operationId: outcome.operationId,
            operationKind: outcome.operationKind,
            targetRelativePath: target.targetRelativePath,
            passed,
            expected:
              outcome.preState.kind === "absent"
                ? "created directory is absent or retained only for unmanaged data"
                : "pre-existing directory remains",
            actual,
          });
          if (
            outcome.preState.kind === "absent" &&
            actual.kind === "directory"
          ) {
            const tree = await inspectDirectoryTree(
              target.targetAbsolutePath,
            );
            retainedFilePaths.push(
              ...tree.files.map((file) =>
                path.posix.join(
                  target.targetRelativePath,
                  file.relativePath,
                ),
              ),
            );
          }
          break;
        }
        case "remove_empty_directory": {
          const actual = await inspectPathState(target.targetAbsolutePath);
          checks.push({
            operationId: outcome.operationId,
            operationKind: outcome.operationKind,
            targetRelativePath: target.targetRelativePath,
            passed: actual.kind === "directory",
            expected: "removed pre-install directory is restored",
            actual,
          });
          break;
        }
        default: {
          const exhaustive: never = outcome.operationKind;
          return exhaustive;
        }
      }
    }
    const terminal =
      record.state === "uninstalled" ||
      record.state === "uninstalled_with_retained_data";
    return {
      record,
      passed: terminal && checks.every((check) => check.passed),
      checks,
      retainedFilePaths: [...new Set(retainedFilePaths)].sort(
        (left, right) => left.localeCompare(right),
      ),
    };
  }

  async planUninstall(
    installationId: string,
    options: { ttlMs?: number; reviewMode?: PlanReviewMode } = {},
  ): Promise<UninstallPlanResult> {
    const record = await this.#recordStore.get(installationId);
    const context = await this.#contextStore.get(record.sourcePlanId);
    return await planModUninstall({
      record,
      profile: context.profile,
      instance: context.instance,
      planStore: this.#uninstallPlanStore,
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      ...(options.reviewMode === undefined
        ? {}
        : { reviewMode: options.reviewMode }),
    });
  }

  async getUninstallPlan(uninstallPlanId: string) {
    return await this.#uninstallPlanStore.get(uninstallPlanId, {
      allowExpired: true,
    });
  }

  async getUninstallPlanLifecycle(
    uninstallPlanId: string,
    options: { now?: Date } = {},
  ): Promise<{
    plan: UninstallPlan;
    lifecycle: UninstallPlanLifecycle;
  }> {
    const plan = await this.getUninstallPlan(uninstallPlanId);
    const observedAt = (options.now ?? new Date()).toISOString();
    const journal = await this.#journalStore.findLatestByPlan(
      uninstallPlanId,
    );
    if (journal) {
      if (journal.state === "uninstalled") {
        return {
          plan,
          lifecycle: {
            uninstallPlanId,
            state: "committed",
            reason: "transaction_committed",
            transactionId: journal.transactionId,
            journalState: journal.state,
            completedAt: journal.completedAt,
            observedAt,
          },
        };
      }
      if (journal.state === "installed_restored") {
        return {
          plan,
          lifecycle: {
            uninstallPlanId,
            state: "failed",
            reason: "transaction_rolled_back",
            transactionId: journal.transactionId,
            journalState: journal.state,
            completedAt: journal.completedAt,
            observedAt,
          },
        };
      }
      if (journal.state === "recovery_required") {
        return {
          plan,
          lifecycle: {
            uninstallPlanId,
            state: "recovery_required",
            reason: "transaction_recovery_required",
            transactionId: journal.transactionId,
            journalState: journal.state,
            completedAt: journal.completedAt,
            observedAt,
          },
        };
      }
      return {
        plan,
        lifecycle: {
          uninstallPlanId,
          state: "applying",
          reason: "transaction_active",
          transactionId: journal.transactionId,
          journalState: journal.state,
          completedAt: journal.completedAt,
          observedAt,
        },
      };
    }

    const record = await this.#recordStore.get(plan.installationId);
    if (record.revision !== plan.installationRevision) {
      return {
        plan,
        lifecycle: {
          uninstallPlanId,
          state: "stale",
          reason: "installation_record_changed",
          transactionId: null,
          journalState: null,
          completedAt: null,
          observedAt,
        },
      };
    }
    if (Date.parse(plan.expiresAt) <= Date.parse(observedAt)) {
      return {
        plan,
        lifecycle: {
          uninstallPlanId,
          state: "stale",
          reason: "expired",
          transactionId: null,
          journalState: null,
          completedAt: null,
          observedAt,
        },
      };
    }
    return {
      plan,
      lifecycle: {
        uninstallPlanId,
        state: "planned",
        reason: "awaiting_apply",
        transactionId: null,
        journalState: null,
        completedAt: null,
        observedAt,
      },
    };
  }

  async applyUninstall(
    uninstallPlanId: string,
  ): Promise<ApplyUninstallResult> {
    const plan = await this.#uninstallPlanStore.get(uninstallPlanId);
    const record = await this.#recordStore.get(plan.installationId);
    const context = await this.#contextStore.get(record.sourcePlanId);
    const engine = new UninstallEngine({
      managerRoot: this.managerRoot,
      planStore: this.#uninstallPlanStore,
      backupStore: this.#backupStore,
      journalStore: this.#journalStore,
      recordStore: this.#recordStore,
    });
    return await engine.applyUninstallPlan({
      uninstallPlanId,
      profile: context.profile,
      instance: context.instance,
    });
  }

  async recoverInstallTransaction(transactionId: string): Promise<RecoveryResult> {
    const journal = await this.#journalStore.read(transactionId);
    const context = await this.#contextStore.get(journal.planId);
    const recovery = new RecoveryManager({
      managerRoot: this.managerRoot,
      planStore: this.#planStore,
      backupStore: this.#backupStore,
      journalStore: this.#journalStore,
      recordStore: this.#recordStore,
    });
    return await recovery.recoverInstall({
      transactionId,
      profile: context.profile,
      instance: context.instance,
    });
  }
}
