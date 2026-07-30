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
import { inspectDirectoryTree, inspectPathState } from "./tree-state.js";

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
): Promise<{
  state: "unchanged" | "missing" | "modified" | "unmanaged_extra";
  unmanagedFilePaths: string[];
  unmanagedDirectoryPaths: string[];
}> {
  if (actualState.kind === "absent") {
    return {
      state: "missing",
      unmanagedFilePaths: [],
      unmanagedDirectoryPaths: [],
    };
  }
  if (actualState.kind !== "directory") {
    return {
      state: "modified",
      unmanagedFilePaths: [],
      unmanagedDirectoryPaths: [],
    };
  }
  if (stateEquals(actualState, outcome.postState)) {
    return {
      state: "unchanged",
      unmanagedFilePaths: [],
      unmanagedDirectoryPaths: [],
    };
  }
  if (
    outcome.operationKind !== "install_tree" ||
    outcome.ownedFiles.length === 0
  ) {
    return {
      state: "modified",
      unmanagedFilePaths: [],
      unmanagedDirectoryPaths: [],
    };
  }

  const tree = await inspectDirectoryTree(targetAbsolutePath);
  const actualFiles = new Map(
    tree.files.map((file) => [file.relativePath.toLowerCase(), file] as const),
  );
  const ownedFiles = new Set(
    outcome.ownedFiles.map((file) => file.relativePath.toLowerCase()),
  );
  const unmanagedFilePaths = tree.files
    .filter((file) => !ownedFiles.has(file.relativePath.toLowerCase()))
    .map((file) => file.relativePath);
  const ownedDirectories = new Set(
    outcome.ownedDirectories.map((directory) => directory.toLowerCase()),
  );
  const unmanagedDirectoryPaths = tree.directories
    .filter(
      (directory) =>
        !ownedDirectories.has(directory.relativePath.toLowerCase()),
    )
    .map((directory) => directory.relativePath);
  let missing = false;
  for (const file of outcome.ownedFiles) {
    const actual = actualFiles.get(file.relativePath.toLowerCase());
    if (!actual) {
      missing = true;
      continue;
    }
    if (
      actual.bytes !== file.bytes ||
      actual.sha256 !== file.sha256
    ) {
      return {
        state: "modified",
        unmanagedFilePaths,
        unmanagedDirectoryPaths,
      };
    }
  }
  return {
    state: missing
      ? "missing"
      : unmanagedFilePaths.length > 0 ||
          unmanagedDirectoryPaths.length > 0
        ? "unmanaged_extra"
        : "modified",
    unmanagedFilePaths,
    unmanagedDirectoryPaths,
  };
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

function relativeManagedChild(
  parentRelativePath: string,
  candidateRelativePath: string,
): string | null {
  const parent = normalizeManagedRelativePath(parentRelativePath);
  const candidate = normalizeManagedRelativePath(candidateRelativePath);
  const prefix = `${parent.toLowerCase()}/`;
  if (!candidate.toLowerCase().startsWith(prefix)) return null;
  return candidate.slice(parent.length + 1);
}

function addDirectoryAncestors(
  directories: Set<string>,
  relativePath: string,
): void {
  const segments = relativePath.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    directories.add(segments.slice(0, index).join("/").toLowerCase());
  }
}

function managedDescendants(
  record: InstallationRecord,
  directoryOutcome: OperationOutcome,
): { files: Set<string>; directories: Set<string> } {
  const files = new Set<string>();
  const directories = new Set<string>();

  for (const outcome of record.operationOutcomes) {
    if (outcome.outcome !== "applied" || outcome === directoryOutcome) {
      continue;
    }
    const outcomeRoot = relativeManagedChild(
      directoryOutcome.targetRelativePath,
      outcome.targetRelativePath,
    );
    if (outcomeRoot === null) continue;

    switch (outcome.operationKind) {
      case "install_new_file":
      case "replace_file":
        files.add(outcomeRoot.toLowerCase());
        addDirectoryAncestors(directories, outcomeRoot);
        break;
      case "ensure_directory":
        directories.add(outcomeRoot.toLowerCase());
        addDirectoryAncestors(directories, outcomeRoot);
        break;
      case "install_tree":
      case "replace_managed_tree":
        directories.add(outcomeRoot.toLowerCase());
        addDirectoryAncestors(directories, outcomeRoot);
        for (const file of outcome.ownedFiles) {
          const relativePath = path.posix.join(outcomeRoot, file.relativePath);
          files.add(relativePath.toLowerCase());
          addDirectoryAncestors(directories, relativePath);
        }
        for (const directory of outcome.ownedDirectories) {
          const relativePath = path.posix.join(outcomeRoot, directory);
          directories.add(relativePath.toLowerCase());
          addDirectoryAncestors(directories, relativePath);
        }
        break;
      case "remove_empty_directory":
        break;
      default: {
        const exhaustive: never = outcome.operationKind;
        return exhaustive;
      }
    }
  }

  return { files, directories };
}

async function classifyCreatedDirectoryOutcome(
  record: InstallationRecord,
  outcome: OperationOutcome,
  targetAbsolutePath: string,
): Promise<{
  state: "unchanged" | "unmanaged_extra";
  unmanagedFilePaths: string[];
  unmanagedDirectoryPaths: string[];
}> {
  const tree = await inspectDirectoryTree(targetAbsolutePath);
  const managed = managedDescendants(record, outcome);
  const unmanagedFilePaths = tree.files
    .filter((file) => !managed.files.has(file.relativePath.toLowerCase()))
    .map((file) => file.relativePath);
  const unmanagedDirectoryPaths = tree.directories
    .filter(
      (directory) =>
        !managed.directories.has(directory.relativePath.toLowerCase()),
    )
    .map((directory) => directory.relativePath);
  return {
    state:
      unmanagedFilePaths.length > 0 || unmanagedDirectoryPaths.length > 0
        ? "unmanaged_extra"
        : "unchanged",
    unmanagedFilePaths,
    unmanagedDirectoryPaths,
  };
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
    let unmanagedFilePaths: string[] = [];
    let unmanagedDirectoryPaths: string[] = [];
    if (owner && owner.installationId !== input.record.installationId) {
      state = "replaced_by_managed_layer";
    } else if (
      outcome.operationKind === "ensure_directory" &&
      actualState.kind === "directory"
    ) {
      if (outcome.preState.kind === "absent") {
        const classified = await classifyCreatedDirectoryOutcome(
          input.record,
          outcome,
          targetAbsolutePath,
        );
        state = classified.state;
        unmanagedFilePaths = classified.unmanagedFilePaths.map((child) =>
          normalizeManagedRelativePath(
            path.posix.join(targetRelativePath, child),
          ),
        );
        unmanagedDirectoryPaths = classified.unmanagedDirectoryPaths.map(
          (child) =>
            normalizeManagedRelativePath(
              path.posix.join(targetRelativePath, child),
            ),
        );
      } else {
        state = "unchanged";
      }
    } else if (outcome.postState.kind === "directory") {
      const classified = await classifyTreeOutcome(
        outcome,
        targetAbsolutePath,
        actualState,
      );
      state = classified.state;
      unmanagedFilePaths = classified.unmanagedFilePaths.map((child) =>
        normalizeManagedRelativePath(
          path.posix.join(targetRelativePath, child),
        ),
      );
      unmanagedDirectoryPaths = classified.unmanagedDirectoryPaths.map(
        (child) =>
          normalizeManagedRelativePath(
            path.posix.join(targetRelativePath, child),
          ),
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
      unmanagedFilePaths,
      unmanagedDirectoryPaths,
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
