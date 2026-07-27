import { readdir } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../content-hash.js";
import type { InstallConflict, InstallOperation, PathState } from "../contracts.js";
import {
  assertNoReparsePointTraversal,
  normalizeManagedRelativePath,
  resolveManagedTarget,
} from "../path-policy.js";
import { inspectPathState } from "./tree-state.js";

export interface ManagedPathOwnership {
  targetRelativePath: string;
  installationId: string;
  modUniqueId: string | null;
  recordedPostState: PathState;
}

export interface ConflictInspection {
  operationId: string;
  targetRelativePath: string;
  targetAbsolutePath: string;
  actualPreState: PathState;
  conflict: InstallConflict;
}

function pathStateEquals(left: PathState, right: PathState): boolean {
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

async function hasCaseCollision(targetAbsolutePath: string): Promise<boolean> {
  const parent = path.dirname(targetAbsolutePath);
  const targetName = path.basename(targetAbsolutePath);
  try {
    const entries = await readdir(parent);
    return entries.some(
      (entry) =>
        entry !== targetName &&
        entry.toLowerCase() === targetName.toLowerCase(),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function ownershipForPath(
  ownership: ReadonlyArray<ManagedPathOwnership>,
  targetRelativePath: string,
): ManagedPathOwnership | undefined {
  const folded = targetRelativePath.toLowerCase();
  return ownership.find(
    (record) => record.targetRelativePath.toLowerCase() === folded,
  );
}

export async function inspectOperationConflict(input: {
  operation: InstallOperation;
  gameRoot: string;
  writableRoots: ReadonlyArray<string>;
  protectedRoots: ReadonlyArray<string>;
  ownership?: ReadonlyArray<ManagedPathOwnership>;
  installingModUniqueId?: string | null;
}): Promise<ConflictInspection> {
  let resolved;
  try {
    resolved = resolveManagedTarget({
      gameRoot: input.gameRoot,
      targetRelativePath: input.operation.targetRelativePath,
      writableRoots: input.writableRoots,
      protectedRoots: input.protectedRoots,
    });
  } catch (error) {
    if (!(error instanceof NexusError) || error.code !== "PROTECTED_PATH") {
      throw error;
    }
    const normalized = normalizeManagedRelativePath(
      input.operation.targetRelativePath,
    );
    const targetAbsolutePath = path.resolve(
      input.gameRoot,
      ...normalized.split("/"),
    );
    const actualPreState = await inspectPathState(targetAbsolutePath);
    return {
      operationId: input.operation.operationId,
      targetRelativePath: normalized,
      targetAbsolutePath,
      actualPreState,
      conflict: {
        targetRelativePath: normalized,
        kind: "protected_path",
        blocking: true,
        message: error.message,
      },
    };
  }
  await assertNoReparsePointTraversal(
    resolved.gameRoot,
    resolved.targetAbsolutePath,
  );

  const actualPreState = await inspectPathState(resolved.targetAbsolutePath);
  if (await hasCaseCollision(resolved.targetAbsolutePath)) {
    return {
      operationId: input.operation.operationId,
      targetRelativePath: input.operation.targetRelativePath,
      targetAbsolutePath: resolved.targetAbsolutePath,
      actualPreState,
      conflict: {
        targetRelativePath: input.operation.targetRelativePath,
        kind: "case_collision",
        blocking: true,
        message:
          "A sibling path differs only by letter case and would collide on Windows.",
      },
    };
  }

  if (actualPreState.kind === "absent") {
    return {
      operationId: input.operation.operationId,
      targetRelativePath: input.operation.targetRelativePath,
      targetAbsolutePath: resolved.targetAbsolutePath,
      actualPreState,
      conflict: {
        targetRelativePath: input.operation.targetRelativePath,
        kind: "new_path",
        blocking: false,
        message: "The target path does not exist.",
      },
    };
  }

  const owner = ownershipForPath(
    input.ownership ?? [],
    input.operation.targetRelativePath,
  );
  if (owner) {
    if (!pathStateEquals(actualPreState, owner.recordedPostState)) {
      return {
        operationId: input.operation.operationId,
        targetRelativePath: input.operation.targetRelativePath,
        targetAbsolutePath: resolved.targetAbsolutePath,
        actualPreState,
        conflict: {
          targetRelativePath: input.operation.targetRelativePath,
          kind: "dirty_managed_path",
          blocking: true,
          message:
            "The managed target differs from the post-state recorded by its owner.",
        },
      };
    }
    const sameMod =
      owner.modUniqueId !== null &&
      input.installingModUniqueId !== null &&
      input.installingModUniqueId !== undefined &&
      owner.modUniqueId === input.installingModUniqueId;
    return {
      operationId: input.operation.operationId,
      targetRelativePath: input.operation.targetRelativePath,
      targetAbsolutePath: resolved.targetAbsolutePath,
      actualPreState,
      conflict: {
        targetRelativePath: input.operation.targetRelativePath,
        kind: sameMod ? "managed_same_mod" : "managed_other_mod",
        blocking: true,
        message: sameMod
          ? "The same Mod already owns this path; transactional update is not enabled yet."
          : "Another managed Mod owns this path.",
      },
    };
  }

  if (pathStateEquals(actualPreState, input.operation.expectedPostState)) {
    return {
      operationId: input.operation.operationId,
      targetRelativePath: input.operation.targetRelativePath,
      targetAbsolutePath: resolved.targetAbsolutePath,
      actualPreState,
      conflict: {
        targetRelativePath: input.operation.targetRelativePath,
        kind: "same_content",
        blocking: true,
        message:
          "The unmanaged target already has the desired content; Phase 6B-2 will not silently claim ownership.",
      },
    };
  }

  return {
    operationId: input.operation.operationId,
    targetRelativePath: input.operation.targetRelativePath,
    targetAbsolutePath: resolved.targetAbsolutePath,
    actualPreState,
    conflict: {
      targetRelativePath: input.operation.targetRelativePath,
      kind: "unmanaged_existing",
      blocking: true,
      message: "An unmanaged target already exists at the planned path.",
    },
  };
}

export function preconditionStateHash(
  inspections: ReadonlyArray<ConflictInspection>,
): string {
  const normalized = inspections
    .map((inspection) => ({
      operationId: inspection.operationId,
      targetRelativePath: inspection.targetRelativePath,
      actualPreState: inspection.actualPreState,
    }))
    .sort((left, right) => left.operationId.localeCompare(right.operationId));
  return sha256CanonicalJson(normalized);
}
