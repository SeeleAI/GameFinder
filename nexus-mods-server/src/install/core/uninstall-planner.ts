import { randomUUID } from "node:crypto";
import path from "node:path";

import { NexusError } from "../../errors.js";
import type {
  CurrentStateInspection,
  GameInstance,
  GameProfile,
  InstallationRecord,
  UninstallAction,
  UninstallPlan,
} from "../contracts.js";
import type { UninstallPlanStore } from "../storage/uninstall-plan-store.js";
import {
  normalizeManagedRelativePath,
  resolveManagedTarget,
} from "../path-policy.js";
import { inspectInstallationState } from "./state-inspector.js";
import { inspectPathState } from "./tree-state.js";
import {
  createPlanReview,
  type PlanReviewMode,
} from "../../plan-review.js";

function joinManagedPath(root: string, child: string): string {
  return normalizeManagedRelativePath(
    path.posix.join(root.replaceAll("\\", "/"), child.replaceAll("\\", "/")),
  );
}

function deepestFirst(left: string, right: string): number {
  const depth = right.split("/").length - left.split("/").length;
  return depth !== 0 ? depth : right.localeCompare(left);
}

export interface UninstallPlanResult {
  plan: UninstallPlan;
  inspection: CurrentStateInspection;
}

export async function planModUninstall(input: {
  record: InstallationRecord;
  profile: GameProfile;
  instance: GameInstance;
  planStore: UninstallPlanStore;
  ttlMs?: number;
  reviewMode?: PlanReviewMode;
}): Promise<UninstallPlanResult> {
  if (
    input.record.state === "uninstalled" ||
    input.record.state === "uninstalled_with_retained_data"
  ) {
    throw new NexusError(
      "UNINSTALL_BLOCKED",
      "The Installation Record is already uninstalled.",
    );
  }
  const inspection = await inspectInstallationState({
    record: input.record,
    profile: input.profile,
    instance: input.instance,
  });
  if (inspection.blocking) {
    throw new NexusError(
      "INSTALLATION_DIRTY",
      "Uninstall planning found modified, protected, or replaced managed paths.",
      {
        details: {
          installationId: input.record.installationId,
          blockingPaths: inspection.paths.filter((item) =>
            ["modified", "protected", "replaced_by_managed_layer"].includes(
              item.state,
            ),
          ),
        },
      },
    );
  }

  const actions: UninstallAction[] = [];
  const retainedPaths: string[] = [];
  const retainedFilePaths: string[] = [];
  for (const outcome of [...input.record.operationOutcomes].reverse()) {
    if (outcome.outcome !== "applied") continue;
    const inspectedPath = inspection.paths.find(
      (item) =>
        item.targetRelativePath.toLowerCase() ===
        outcome.targetRelativePath.toLowerCase(),
    );
    if (!inspectedPath) continue;
    if (
      inspectedPath.state === "missing" &&
      outcome.operationKind !== "install_tree"
    ) {
      continue;
    }
    if (
      inspectedPath.state === "unmanaged_extra" ||
      (inspectedPath.unmanagedFilePaths?.length ?? 0) > 0 ||
      (inspectedPath.unmanagedDirectoryPaths?.length ?? 0) > 0
    ) {
      retainedPaths.push(outcome.targetRelativePath);
    }
    retainedFilePaths.push(...(inspectedPath.unmanagedFilePaths ?? []));

    switch (outcome.operationKind) {
      case "install_new_file":
        actions.push({
          actionId: randomUUID(),
          kind: "delete_owned_file",
          targetRelativePath: outcome.targetRelativePath,
          expectedCurrentState: outcome.postState,
        });
        break;
      case "replace_file":
        if (!outcome.backupId) {
          throw new NexusError(
            "BACKUP_MISSING",
            "A replaced file has no preimage backup for uninstall.",
          );
        }
        actions.push({
          actionId: randomUUID(),
          kind: "restore_backup",
          targetRelativePath: outcome.targetRelativePath,
          backupId: outcome.backupId,
          expectedCurrentState: outcome.postState,
        });
        break;
      case "install_tree": {
        for (const file of [...outcome.ownedFiles].sort((left, right) =>
          deepestFirst(left.relativePath, right.relativePath),
        )) {
          const targetRelativePath = joinManagedPath(
            outcome.targetRelativePath,
            file.relativePath,
          );
          const resolved = resolveManagedTarget({
            gameRoot: input.instance.gameRoot,
            targetRelativePath,
            writableRoots: input.profile.filesystem.writableRoots,
            protectedRoots: input.profile.filesystem.protectedRoots,
          });
          const current = await inspectPathState(resolved.targetAbsolutePath);
          if (current.kind === "absent") continue;
          if (
            current.kind !== "file" ||
            current.bytes !== file.bytes ||
            current.sha256 !== file.sha256
          ) {
            throw new NexusError(
              "INSTALLATION_DIRTY",
              "An owned file changed during Uninstall Plan generation.",
              { details: { targetRelativePath, current } },
            );
          }
          actions.push({
            actionId: randomUUID(),
            kind: "delete_owned_file",
            targetRelativePath,
            expectedCurrentState: {
              kind: "file",
              bytes: file.bytes,
              sha256: file.sha256,
            },
          });
        }
        const directories = [
          ...outcome.ownedDirectories.map((directory) =>
            joinManagedPath(outcome.targetRelativePath, directory),
          ),
          outcome.targetRelativePath,
        ];
        for (const directory of [...new Set(directories)].sort(deepestFirst)) {
          actions.push({
            actionId: randomUUID(),
            kind: "remove_empty_directory",
            targetRelativePath: directory,
          });
        }
        break;
      }
      case "replace_managed_tree":
        if (!outcome.backupId) {
          throw new NexusError(
            "BACKUP_MISSING",
            "A replaced managed tree has no preimage backup for uninstall.",
          );
        }
        actions.push({
          actionId: randomUUID(),
          kind: "restore_managed_tree",
          targetRelativePath: outcome.targetRelativePath,
          backupId: outcome.backupId,
          expectedCurrentState: outcome.postState,
        });
        break;
      case "ensure_directory":
        if (outcome.preState.kind === "absent") {
          actions.push({
            actionId: randomUUID(),
            kind: "remove_empty_directory",
            targetRelativePath: outcome.targetRelativePath,
          });
        }
        break;
      case "remove_empty_directory":
        actions.push({
          actionId: randomUUID(),
          kind: "ensure_directory",
          targetRelativePath: outcome.targetRelativePath,
        });
        break;
      default: {
        const exhaustive: never = outcome.operationKind;
        return exhaustive;
      }
    }
  }

  const plan = await input.planStore.save(
    {
      installationId: input.record.installationId,
      installationRevision: input.record.revision,
      inspectionId: inspection.inspectionId,
      inspectionStateHash: inspection.stateHash,
      gameInstanceId: input.instance.instanceId,
      gameProfileId: input.profile.profileId,
      gameProfileVersion: input.profile.profileVersion,
      actions,
      retainedPaths: [...new Set(retainedPaths)],
      retainedFilePaths: [...new Set(retainedFilePaths)],
      review: createPlanReview({
        classification:
          input.reviewMode === "always_review"
            ? "review_required"
            : "auto_safe",
        reasonCodes:
          input.reviewMode === "always_review"
            ? ["USER_REQUESTED_REVIEW"]
            : ["MANAGED_UNINSTALL"],
        ...(input.reviewMode === undefined
          ? {}
          : { mode: input.reviewMode }),
        action: "uninstall",
        targetIds: [input.record.installationId],
        decisionInputs: {
          installationRevision: input.record.revision,
          inspectionStateHash: inspection.stateHash,
          actions,
          retainedPaths: [...new Set(retainedPaths)],
          retainedFilePaths: [...new Set(retainedFilePaths)],
        },
      }),
    },
    input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs },
  );
  return { plan, inspection };
}
