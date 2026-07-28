import { randomUUID } from "node:crypto";
import path from "node:path";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../content-hash.js";
import type {
  CurrentStateInspection,
  GameInstance,
  GameProfile,
  InstallationRecord,
  OperationOutcome,
  PathState,
} from "../contracts.js";
import { currentStateInspectionSchema } from "../contracts.js";
import {
  normalizeManagedRelativePath,
  resolveManagedTarget,
} from "../path-policy.js";
import { inspectPathState } from "./tree-state.js";

export interface CurrentOwnershipLayer {
  targetRelativePath: string;
  installationId: string;
}

function stateEquals(left: PathState, right: PathState): boolean {
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

async function classifyTreeOutcome(
  outcome: OperationOutcome,
  targetAbsolutePath: string,
  actualState: PathState,
): Promise<"unchanged" | "missing" | "modified" | "unmanaged_extra"> {
  if (actualState.kind === "absent") return "missing";
  if (actualState.kind !== "directory") return "modified";
  if (stateEquals(actualState, outcome.postState)) return "unchanged";
  if (
    outcome.ownershipMode !== "installed_file_set" ||
    outcome.ownedFiles.length === 0
  ) {
    return "modified";
  }

  let missing = false;
  for (const file of outcome.ownedFiles) {
    const absolutePath = path.resolve(
      targetAbsolutePath,
      ...file.relativePath.split("/"),
    );
    const fileState = await inspectPathState(absolutePath);
    if (fileState.kind === "absent") {
      missing = true;
      continue;
    }
    if (
      fileState.kind !== "file" ||
      fileState.bytes !== file.bytes ||
      fileState.sha256 !== file.sha256
    ) {
      return "modified";
    }
  }
  return missing ? "missing" : "unmanaged_extra";
}

function currentOwner(
  layers: ReadonlyArray<CurrentOwnershipLayer>,
  targetRelativePath: string,
): CurrentOwnershipLayer | undefined {
  const folded = targetRelativePath.toLowerCase();
  return layers.find(
    (layer) => layer.targetRelativePath.toLowerCase() === folded,
  );
}

export async function inspectInstallationState(input: {
  record: InstallationRecord;
  profile: GameProfile;
  instance: GameInstance;
  ownershipLayers?: ReadonlyArray<CurrentOwnershipLayer>;
}): Promise<CurrentStateInspection> {
  if (
    input.record.gameInstanceId !== input.instance.instanceId ||
    input.record.gameProfileId !== input.profile.profileId
  ) {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      "Installation Record, Game Profile, and Game Instance do not match.",
    );
  }

  const paths: CurrentStateInspection["paths"] = [];
  for (const outcome of input.record.operationOutcomes) {
    let targetRelativePath = outcome.targetRelativePath;
    let targetAbsolutePath: string;
    try {
      const resolved = resolveManagedTarget({
        gameRoot: input.instance.gameRoot,
        targetRelativePath,
        writableRoots: input.profile.filesystem.writableRoots,
        protectedRoots: input.profile.filesystem.protectedRoots,
      });
      targetRelativePath = resolved.targetRelativePath;
      targetAbsolutePath = resolved.targetAbsolutePath;
    } catch (error) {
      if (!(error instanceof NexusError) || error.code !== "PROTECTED_PATH") {
        throw error;
      }
      targetRelativePath = normalizeManagedRelativePath(targetRelativePath);
      targetAbsolutePath = path.resolve(
        input.instance.gameRoot,
        ...targetRelativePath.split("/"),
      );
      paths.push({
        targetRelativePath,
        state: "protected",
        expectedPostState: outcome.postState,
        actualState: await inspectPathState(targetAbsolutePath),
        currentOwnerInstallationId: null,
      });
      continue;
    }

    const actualState = await inspectPathState(targetAbsolutePath);
    const owner = currentOwner(
      input.ownershipLayers ?? [],
      targetRelativePath,
    );
    let state: CurrentStateInspection["paths"][number]["state"];
    if (owner && owner.installationId !== input.record.installationId) {
      state = "replaced_by_managed_layer";
    } else if (
      outcome.operationKind === "ensure_directory" &&
      actualState.kind === "directory"
    ) {
      state = "unchanged";
    } else if (outcome.postState.kind === "directory") {
      state = await classifyTreeOutcome(
        outcome,
        targetAbsolutePath,
        actualState,
      );
    } else if (stateEquals(actualState, outcome.postState)) {
      state = "unchanged";
    } else if (actualState.kind === "absent") {
      state = "missing";
    } else {
      state = "modified";
    }
    paths.push({
      targetRelativePath,
      state,
      expectedPostState: outcome.postState,
      actualState,
      currentOwnerInstallationId: owner?.installationId ?? null,
    });
  }

  const inspectedAt = new Date().toISOString();
  const stateHash = sha256CanonicalJson({
    installationId: input.record.installationId,
    installationRevision: input.record.revision,
    gameInstanceId: input.instance.instanceId,
    paths,
  });
  return currentStateInspectionSchema.parse({
    schemaVersion: 1,
    inspectionId: randomUUID(),
    installationId: input.record.installationId,
    gameInstanceId: input.instance.instanceId,
    stateHash,
    inspectedAt,
    paths,
    blocking: paths.some((item) =>
      ["modified", "replaced_by_managed_layer", "protected"].includes(
        item.state,
      ),
    ),
  });
}
