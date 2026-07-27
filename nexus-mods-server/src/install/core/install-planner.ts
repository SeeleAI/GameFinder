import { NexusError } from "../../errors.js";
import type {
  AdapterMatchResult,
  AdapterPreflightResult,
  InstallAdapter,
} from "../adapter.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type {
  GameInstance,
  GameProfile,
  InstallPlan,
  PackageAnalysis,
  PackageUnit,
} from "../contracts.js";
import type { StagedPackage } from "./staging-manager.js";
import { inspectDirectoryTree } from "./tree-state.js";
import {
  inspectOperationConflict,
  preconditionStateHash,
  type ConflictInspection,
  type ManagedPathOwnership,
} from "./conflict-detector.js";
import { validateOperationReversibility } from "../reversibility.js";
import type { PlanStore } from "../storage/plan-store.js";

export interface InstallPlanResult {
  plan: Readonly<InstallPlan>;
  adapter: {
    adapterId: string;
    adapterVersion: string;
    match: AdapterMatchResult;
  };
  packageUnit: PackageUnit;
  preflight: AdapterPreflightResult;
  inspections: ReadonlyArray<ConflictInspection>;
  warnings: ReadonlyArray<string>;
  verificationRequirements: ReadonlyArray<string>;
}

async function assertStagingStillMatches(staged: StagedPackage): Promise<void> {
  const currentTree = await inspectDirectoryTree(staged.packageAbsolutePath);
  if (
    currentTree.treeHash !== staged.treeHash ||
    currentTree.totalBytes !== staged.totalBytes
  ) {
    throw new NexusError(
      "PLAN_STALE",
      "The staged package changed before the Install Plan was frozen.",
      {
        details: {
          stagingId: staged.stagingId,
          expectedTreeHash: staged.treeHash,
          actualTreeHash: currentTree.treeHash,
        },
      },
    );
  }
}

function dependencyError(
  adapter: InstallAdapter,
  blockingReasons: ReadonlyArray<string>,
): NexusError {
  return new NexusError(
    "DEPENDENCY_MISSING",
    "The selected game instance is missing an Adapter dependency.",
    {
      details: {
        adapterId: adapter.descriptor.adapterId,
        blockingReasons,
      },
    },
  );
}

export async function planModInstall(input: {
  analysis: PackageAnalysis;
  profile: GameProfile;
  instance: GameInstance;
  stagedPackage: StagedPackage;
  registry: AdapterRegistry;
  planStore: PlanStore;
  ownership?: ReadonlyArray<ManagedPathOwnership>;
  ttlMs?: number;
}): Promise<InstallPlanResult> {
  if (
    input.analysis.archive.sha256 !== input.stagedPackage.archive.sha256 ||
    input.analysis.archive.absolutePath !==
      input.stagedPackage.archive.absolutePath
  ) {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      "Package Analysis and staging refer to different archives.",
    );
  }
  if (
    input.profile.profileId !== input.instance.profileId ||
    input.profile.profileVersion !== input.instance.profileVersion
  ) {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      "Game Instance does not match the selected Game Profile version.",
    );
  }

  await assertStagingStillMatches(input.stagedPackage);
  const context = {
    analysis: input.analysis,
    profile: input.profile,
    instance: input.instance,
    stagedPackage: input.stagedPackage,
  };
  const selected = await input.registry.select(context);
  const compatibility = await selected.adapter.probeInstance(
    context,
    selected.match,
  );
  if (compatibility.state === "dependency-missing") {
    throw dependencyError(selected.adapter, compatibility.blockingReasons);
  }
  if (compatibility.state !== "compatible") {
    throw new NexusError(
      "INSTALL_CONFLICT",
      "The selected Adapter is not compatible with the game instance.",
      {
        details: {
          adapterId: selected.adapter.descriptor.adapterId,
          compatibility,
        },
      },
    );
  }
  const preflight = await selected.adapter.preflight(context, selected.match);
  if (!preflight.ok) {
    throw new NexusError(
      "INSTALL_CONFLICT",
      "Adapter preflight blocked Install Plan creation.",
      {
        details: {
          adapterId: selected.adapter.descriptor.adapterId,
          blockingReasons: preflight.blockingReasons,
        },
      },
    );
  }

  const draft = await selected.adapter.buildPlan(context, selected.match);
  if (draft.operations.length === 0) {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      "An Adapter must produce at least one standard operation.",
    );
  }
  for (const operation of draft.operations) {
    validateOperationReversibility(operation);
  }

  const inspections = await Promise.all(
    draft.operations.map((operation) =>
      inspectOperationConflict({
        operation,
        gameRoot: input.instance.gameRoot,
        writableRoots: input.profile.filesystem.writableRoots,
        protectedRoots: input.profile.filesystem.protectedRoots,
        ...(input.ownership === undefined
          ? {}
          : { ownership: input.ownership }),
        installingModUniqueId: draft.packageUnit.identity.uniqueId,
      }),
    ),
  );
  const blocking = inspections.filter(
    (inspection) => inspection.conflict.blocking,
  );
  if (blocking.length > 0) {
    throw new NexusError(
      "INSTALL_CONFLICT",
      "Install Plan creation was blocked by target filesystem conflicts.",
      {
        details: {
          adapterId: selected.adapter.descriptor.adapterId,
          packageUnitId: draft.packageUnit.packageUnitId,
          conflicts: blocking.map((inspection) => inspection.conflict),
        },
      },
    );
  }

  const plan = await input.planStore.save(
    {
      archive: input.analysis.archive,
      analysisId: input.analysis.analysisId,
      analysisHash: input.analysis.analysisHash,
      gameInstanceId: input.instance.instanceId,
      gameProfileId: input.profile.profileId,
      gameProfileVersion: input.profile.profileVersion,
      adapterId: selected.adapter.descriptor.adapterId,
      adapterVersion: selected.adapter.descriptor.adapterVersion,
      staging: {
        stagingId: input.stagedPackage.stagingId,
        packageRoot: input.stagedPackage.packageRoot,
        sourceTreeHash: input.stagedPackage.treeHash,
      },
      operations: draft.operations,
      conflicts: inspections.map((inspection) => inspection.conflict),
      preconditionStateHash: preconditionStateHash(inspections),
    },
    input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs },
  );

  return {
    plan,
    adapter: {
      adapterId: selected.adapter.descriptor.adapterId,
      adapterVersion: selected.adapter.descriptor.adapterVersion,
      match: selected.match,
    },
    packageUnit: draft.packageUnit,
    preflight,
    inspections,
    warnings: [...compatibility.warnings, ...draft.warnings],
    verificationRequirements: draft.verificationRequirements,
  };
}
