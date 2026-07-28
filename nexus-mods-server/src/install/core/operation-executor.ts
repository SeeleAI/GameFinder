import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import type {
  GameInstance,
  GameProfile,
  InstallOperation,
  OperationOutcome,
  PathState,
} from "../contracts.js";
import type { BackupStore } from "../storage/backup-store.js";
import {
  assertNoReparsePointTraversal,
  normalizeManagedRelativePath,
  resolveManagedTarget,
} from "../path-policy.js";
import { inspectDirectoryTree, inspectPathState } from "./tree-state.js";

function stateEquals(left: PathState, right: PathState): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "absent" || right.kind === "absent") return true;
  if (left.kind === "file" && right.kind === "file") {
    return left.bytes === right.bytes && left.sha256 === right.sha256;
  }
  if (left.kind === "directory" && right.kind === "directory") {
    return (
      left.treeHash === right.treeHash &&
      (left.entries === null ||
        right.entries === null ||
        left.entries === right.entries)
    );
  }
  return false;
}

async function assertRealDirectory(directory: string): Promise<void> {
  const info = await stat(directory).catch((error: unknown) => {
    throw new NexusError(
      "APPLY_FAILED",
      "A planned target parent directory does not exist.",
      { cause: error, details: { directory } },
    );
  });
  if (!info.isDirectory()) {
    throw new NexusError(
      "APPLY_FAILED",
      "A planned target parent is not a directory.",
      { details: { directory } },
    );
  }
}

function resolveStagedSource(stagingRoot: string, relativePath: string): string {
  if (relativePath === ".") {
    return path.resolve(stagingRoot);
  }
  const normalized = normalizeManagedRelativePath(relativePath);
  const absolutePath = path.resolve(stagingRoot, ...normalized.split("/"));
  const relative = path.relative(stagingRoot, absolutePath);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new NexusError(
      "PROTECTED_PATH",
      "A planned staging source escapes its staging root.",
      { details: { stagingRoot, relativePath } },
    );
  }
  return absolutePath;
}

async function copyTreeToNewTarget(
  sourceRoot: string,
  targetAbsolutePath: string,
): Promise<Awaited<ReturnType<typeof inspectDirectoryTree>>> {
  const sourceTree = await inspectDirectoryTree(sourceRoot);
  const temporaryPath = `${targetAbsolutePath}.${randomUUID()}.installing`;
  await mkdir(temporaryPath, { recursive: false });
  try {
    for (const directory of sourceTree.directories) {
      await mkdir(
        path.join(temporaryPath, ...directory.relativePath.split("/")),
        { recursive: true },
      );
    }
    for (const file of sourceTree.files) {
      const targetFile = path.join(
        temporaryPath,
        ...file.relativePath.split("/"),
      );
      await mkdir(path.dirname(targetFile), { recursive: true });
      await copyFile(file.absolutePath, targetFile, constants.COPYFILE_EXCL);
    }
    const copied = await inspectDirectoryTree(temporaryPath);
    if (copied.treeHash !== sourceTree.treeHash) {
      throw new NexusError(
        "VERIFY_FAILED",
        "The copied directory tree differs from its staged source.",
      );
    }
    await rename(temporaryPath, targetAbsolutePath);
    return copied;
  } finally {
    await rm(temporaryPath, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

export interface AppliedInstallOperation {
  operation: InstallOperation;
  outcome: OperationOutcome;
}

export interface OperationExecutionHooks {
  beforeBackup?(operation: InstallOperation): Promise<void>;
  afterBackup?(operation: InstallOperation, backupId: string): Promise<void>;
  beforeTargetWrite?(operation: InstallOperation): Promise<void>;
  afterTargetWrite?(operation: InstallOperation): Promise<void>;
}

export async function applyInstallOperation(input: {
  operation: InstallOperation;
  profile: GameProfile;
  instance: GameInstance;
  stagingRoot: string;
  backupStore: BackupStore;
  hooks?: OperationExecutionHooks;
}): Promise<AppliedInstallOperation> {
  const resolved = resolveManagedTarget({
    gameRoot: input.instance.gameRoot,
    targetRelativePath: input.operation.targetRelativePath,
    writableRoots: input.profile.filesystem.writableRoots,
    protectedRoots: input.profile.filesystem.protectedRoots,
  });
  await assertNoReparsePointTraversal(
    resolved.gameRoot,
    resolved.targetAbsolutePath,
  );
  const preState = await inspectPathState(resolved.targetAbsolutePath);
  if (!stateEquals(preState, input.operation.expectedPreState)) {
    throw new NexusError(
      "PLAN_STALE",
      "An operation pre-state changed after planning.",
      {
        details: {
          operationId: input.operation.operationId,
          targetRelativePath: input.operation.targetRelativePath,
          expectedPreState: input.operation.expectedPreState,
          actualPreState: preState,
        },
      },
    );
  }

  let backupId: string | null = null;
  let ownershipMode: OperationOutcome["ownershipMode"] = "none";
  let ownedFiles: OperationOutcome["ownedFiles"] = [];
  let ownedDirectories: OperationOutcome["ownedDirectories"] = [];
  let outcome: OperationOutcome["outcome"] = "applied";

  switch (input.operation.kind) {
    case "ensure_directory":
      if (preState.kind === "directory") {
        outcome = "skipped_same_content";
      } else {
        await assertRealDirectory(path.dirname(resolved.targetAbsolutePath));
        await input.hooks?.beforeTargetWrite?.(input.operation);
        await mkdir(resolved.targetAbsolutePath, { recursive: false });
        await input.hooks?.afterTargetWrite?.(input.operation);
      }
      break;

    case "install_new_file": {
      await assertRealDirectory(path.dirname(resolved.targetAbsolutePath));
      const source = resolveStagedSource(
        input.stagingRoot,
        input.operation.sourceRelativePath,
      );
      await assertNoReparsePointTraversal(input.stagingRoot, source);
      const sourceState = await inspectPathState(source);
      if (
        sourceState.kind !== "file" ||
        sourceState.sha256 !== input.operation.sourceSha256
      ) {
        throw new NexusError(
          "PLAN_STALE",
          "A staged source file changed after planning.",
          { details: { sourceRelativePath: input.operation.sourceRelativePath } },
        );
      }
      const temporaryPath = `${resolved.targetAbsolutePath}.${randomUUID()}.installing`;
      await input.hooks?.beforeTargetWrite?.(input.operation);
      await copyFile(source, temporaryPath, constants.COPYFILE_EXCL);
      try {
        const temporaryState = await inspectPathState(temporaryPath);
        if (!stateEquals(temporaryState, input.operation.expectedPostState)) {
          throw new NexusError(
            "VERIFY_FAILED",
            "A copied source file failed pre-publication verification.",
          );
        }
        await rename(temporaryPath, resolved.targetAbsolutePath);
        await input.hooks?.afterTargetWrite?.(input.operation);
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
      ownershipMode = "installed_file_set";
      break;
    }

    case "replace_file": {
      await assertRealDirectory(path.dirname(resolved.targetAbsolutePath));
      await input.hooks?.beforeBackup?.(input.operation);
      const backup = await input.backupStore.backupFile(
        resolved.targetAbsolutePath,
      );
      backupId = backup.backupId;
      await input.hooks?.afterBackup?.(input.operation, backup.backupId);
      const source = resolveStagedSource(
        input.stagingRoot,
        input.operation.sourceRelativePath,
      );
      await assertNoReparsePointTraversal(input.stagingRoot, source);
      const sourceState = await inspectPathState(source);
      if (
        sourceState.kind !== "file" ||
        sourceState.sha256 !== input.operation.sourceSha256
      ) {
        throw new NexusError(
          "PLAN_STALE",
          "A staged replacement file changed after planning.",
        );
      }
      const temporaryPath = `${resolved.targetAbsolutePath}.${randomUUID()}.installing`;
      await input.hooks?.beforeTargetWrite?.(input.operation);
      await copyFile(source, temporaryPath, constants.COPYFILE_EXCL);
      try {
        await rm(resolved.targetAbsolutePath, { force: false });
        await rename(temporaryPath, resolved.targetAbsolutePath);
        await input.hooks?.afterTargetWrite?.(input.operation);
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
      ownershipMode = "layered_path";
      break;
    }

    case "install_tree": {
      await assertRealDirectory(path.dirname(resolved.targetAbsolutePath));
      const source = resolveStagedSource(
        input.stagingRoot,
        input.operation.sourceRelativePath,
      );
      await assertNoReparsePointTraversal(input.stagingRoot, source);
      const sourceTree = await inspectDirectoryTree(source);
      if (sourceTree.treeHash !== input.operation.sourceTreeHash) {
        throw new NexusError(
          "PLAN_STALE",
          "The staged source tree changed after planning.",
        );
      }
      await input.hooks?.beforeTargetWrite?.(input.operation);
      const copied = await copyTreeToNewTarget(
        source,
        resolved.targetAbsolutePath,
      );
      await input.hooks?.afterTargetWrite?.(input.operation);
      ownershipMode = input.operation.ownershipMode;
      ownedFiles = copied.files.map((file) => ({
        relativePath: file.relativePath,
        bytes: file.bytes,
        sha256: file.sha256,
      }));
      ownedDirectories = copied.directories.map(
        (directory) => directory.relativePath,
      );
      break;
    }

    case "replace_managed_tree": {
      await assertRealDirectory(path.dirname(resolved.targetAbsolutePath));
      await input.hooks?.beforeBackup?.(input.operation);
      const backup = await input.backupStore.backupTree(
        resolved.targetAbsolutePath,
      );
      backupId = backup.backupId;
      await input.hooks?.afterBackup?.(input.operation, backup.backupId);
      const source = resolveStagedSource(
        input.stagingRoot,
        input.operation.sourceRelativePath,
      );
      await assertNoReparsePointTraversal(input.stagingRoot, source);
      const sourceTree = await inspectDirectoryTree(source);
      if (sourceTree.treeHash !== input.operation.sourceTreeHash) {
        throw new NexusError(
          "PLAN_STALE",
          "The staged replacement tree changed after planning.",
        );
      }
      await input.hooks?.beforeTargetWrite?.(input.operation);
      await rm(resolved.targetAbsolutePath, { recursive: true, force: false });
      const copied = await copyTreeToNewTarget(
        source,
        resolved.targetAbsolutePath,
      );
      await input.hooks?.afterTargetWrite?.(input.operation);
      ownershipMode = input.operation.ownershipMode;
      ownedFiles = copied.files.map((file) => ({
        relativePath: file.relativePath,
        bytes: file.bytes,
        sha256: file.sha256,
      }));
      ownedDirectories = copied.directories.map(
        (directory) => directory.relativePath,
      );
      break;
    }

    case "remove_empty_directory":
      await input.hooks?.beforeTargetWrite?.(input.operation);
      await rmdir(resolved.targetAbsolutePath);
      await input.hooks?.afterTargetWrite?.(input.operation);
      break;

    default: {
      const exhaustive: never = input.operation;
      return exhaustive;
    }
  }

  const postState = await inspectPathState(resolved.targetAbsolutePath);
  if (!stateEquals(postState, input.operation.expectedPostState)) {
    throw new NexusError(
      "VERIFY_FAILED",
      "An operation did not produce its declared post-state.",
      {
        details: {
          operationId: input.operation.operationId,
          expectedPostState: input.operation.expectedPostState,
          actualPostState: postState,
        },
      },
    );
  }
  return {
    operation: input.operation,
    outcome: {
      operationId: input.operation.operationId,
      operationKind: input.operation.kind,
      targetRelativePath: input.operation.targetRelativePath,
      outcome,
      preState,
      postState,
      ownershipMode,
      ownedFiles,
      ownedDirectories,
      backupId,
      previousOwnerInstallationId:
        input.operation.kind === "replace_managed_tree"
          ? input.operation.previousOwnerInstallationId
          : null,
    },
  };
}

export async function rollbackInstallOperation(input: {
  applied: AppliedInstallOperation;
  profile: GameProfile;
  instance: GameInstance;
  backupStore: BackupStore;
}): Promise<void> {
  if (input.applied.outcome.outcome === "skipped_same_content") return;
  const operation = input.applied.operation;
  const outcome = input.applied.outcome;
  const resolved = resolveManagedTarget({
    gameRoot: input.instance.gameRoot,
    targetRelativePath: operation.targetRelativePath,
    writableRoots: input.profile.filesystem.writableRoots,
    protectedRoots: input.profile.filesystem.protectedRoots,
  });
  const currentState = await inspectPathState(resolved.targetAbsolutePath);
  if (!stateEquals(currentState, outcome.postState)) {
    throw new NexusError(
      "ROLLBACK_FAILED",
      "Rollback refused to overwrite a target that changed after apply.",
      {
        details: {
          operationId: operation.operationId,
          expectedCurrentState: outcome.postState,
          actualCurrentState: currentState,
        },
      },
    );
  }

  switch (operation.kind) {
    case "ensure_directory":
      if (outcome.preState.kind === "absent") {
        await rmdir(resolved.targetAbsolutePath);
      }
      return;
    case "install_new_file":
      await rm(resolved.targetAbsolutePath, { force: false });
      return;
    case "replace_file":
      if (!outcome.backupId) {
        throw new NexusError(
          "ROLLBACK_FAILED",
          "Replacement rollback has no file backup.",
        );
      }
      await rm(resolved.targetAbsolutePath, { force: false });
      await input.backupStore.restoreFile(
        outcome.backupId,
        resolved.targetAbsolutePath,
      );
      return;
    case "install_tree":
      await rm(resolved.targetAbsolutePath, {
        recursive: true,
        force: false,
      });
      return;
    case "replace_managed_tree":
      if (!outcome.backupId) {
        throw new NexusError(
          "ROLLBACK_FAILED",
          "Managed-tree rollback has no backup.",
        );
      }
      await rm(resolved.targetAbsolutePath, {
        recursive: true,
        force: false,
      });
      await input.backupStore.restoreTree(
        outcome.backupId,
        resolved.targetAbsolutePath,
      );
      return;
    case "remove_empty_directory":
      await mkdir(resolved.targetAbsolutePath, { recursive: false });
      return;
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}
