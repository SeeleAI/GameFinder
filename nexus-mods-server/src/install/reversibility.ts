import { NexusError } from "../errors.js";
import type {
  InstallOperation,
  InstallOperationKind,
  OperationOutcome,
  PathState
} from "./contracts.js";

export interface ReversibilityContract {
  operationKind: InstallOperationKind;
  requiredPreState: ReadonlyArray<PathState["kind"]>;
  requiredPostState: ReadonlyArray<PathState["kind"]>;
  rollbackStrategy: string;
  uninstallStrategy: string;
  blockingConditions: ReadonlyArray<string>;
}

function freezeContract(
  contract: ReversibilityContract,
): Readonly<ReversibilityContract> {
  return Object.freeze(contract);
}

export const REVERSIBILITY_CONTRACTS: Readonly<
  Record<InstallOperationKind, ReversibilityContract>
> = Object.freeze({
  ensure_directory: freezeContract({
    operationKind: "ensure_directory",
    requiredPreState: ["absent", "directory"],
    requiredPostState: ["directory"],
    rollbackStrategy: "Remove the directory only when this operation created it and it is empty.",
    uninstallStrategy: "Remove the directory only after owned children are removed and it is empty.",
    blockingConditions: ["The directory contains unmanaged entries."]
  }),
  install_new_file: freezeContract({
    operationKind: "install_new_file",
    requiredPreState: ["absent"],
    requiredPostState: ["file"],
    rollbackStrategy: "Delete the installed file when its hash still matches the operation post-state.",
    uninstallStrategy: "Delete the installed file when its current hash still matches the recorded post-state.",
    blockingConditions: ["The file is missing.", "The file hash changed after installation."]
  }),
  replace_file: freezeContract({
    operationKind: "replace_file",
    requiredPreState: ["file"],
    requiredPostState: ["file"],
    rollbackStrategy: "Restore the verified preimage backup after validating the installed post-state.",
    uninstallStrategy: "Restore the verified preimage or previous ownership layer.",
    blockingConditions: [
      "The installed file hash changed.",
      "The preimage backup is missing or invalid.",
      "A higher managed ownership layer exists."
    ]
  }),
  install_tree: freezeContract({
    operationKind: "install_tree",
    requiredPreState: ["absent"],
    requiredPostState: ["directory"],
    rollbackStrategy: "Remove only the files actually installed by the transaction.",
    uninstallStrategy: "Remove unchanged owned files and preserve unknown or generated files.",
    blockingConditions: ["Owned files were modified.", "The target contains unmanaged entries."]
  }),
  replace_managed_tree: freezeContract({
    operationKind: "replace_managed_tree",
    requiredPreState: ["directory"],
    requiredPostState: ["directory"],
    rollbackStrategy: "Restore the previous managed tree from verified backup objects.",
    uninstallStrategy: "Restore the previous ownership layer and preserve unknown generated files.",
    blockingConditions: [
      "The current tree is dirty.",
      "The previous ownership record is missing.",
      "A required backup object is invalid."
    ]
  }),
  remove_empty_directory: freezeContract({
    operationKind: "remove_empty_directory",
    requiredPreState: ["directory"],
    requiredPostState: ["absent"],
    rollbackStrategy: "Recreate the directory when this operation removed it.",
    uninstallStrategy: "Recreate the directory only when the installation record requires its prior existence.",
    blockingConditions: ["The directory is not empty at apply time."]
  })
});

function contractError(operation: InstallOperation, message: string): never {
  throw new NexusError("INSTALL_CONTRACT_INVALID", message, {
    details: {
      operationId: operation.operationId,
      operationKind: operation.kind,
      targetRelativePath: operation.targetRelativePath
    }
  });
}

export function getReversibilityContract(kind: InstallOperationKind): ReversibilityContract {
  return REVERSIBILITY_CONTRACTS[kind];
}

export function validateOperationReversibility(operation: InstallOperation): void {
  const contract = getReversibilityContract(operation.kind);
  if (!contract.requiredPreState.includes(operation.expectedPreState.kind)) {
    contractError(
      operation,
      `${operation.kind} requires pre-state ${contract.requiredPreState.join(
        " or "
      )}, not ${operation.expectedPreState.kind}.`
    );
  }
  if (!contract.requiredPostState.includes(operation.expectedPostState.kind)) {
    contractError(
      operation,
      `${operation.kind} requires post-state ${contract.requiredPostState.join(
        " or "
      )}, not ${operation.expectedPostState.kind}.`
    );
  }

  switch (operation.kind) {
    case "install_new_file":
    case "replace_file":
      if (
        operation.expectedPostState.kind !== "file" ||
        operation.expectedPostState.sha256 !== operation.sourceSha256
      ) {
        contractError(operation, `${operation.kind} post-state hash must match sourceSha256.`);
      }
      return;
    case "install_tree":
    case "replace_managed_tree":
      if (
        operation.expectedPostState.kind !== "directory" ||
        operation.expectedPostState.treeHash !== operation.sourceTreeHash
      ) {
        contractError(operation, `${operation.kind} post-state treeHash must match sourceTreeHash.`);
      }
      return;
    case "ensure_directory":
    case "remove_empty_directory":
      return;
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

export type InverseCandidate =
  | { kind: "none"; reason: string }
  | { kind: "delete_file"; targetRelativePath: string; expectedCurrentState: PathState }
  | {
      kind: "restore_backup";
      targetRelativePath: string;
      backupId: string;
      expectedCurrentState: PathState;
    }
  | { kind: "remove_owned_tree"; targetRelativePath: string; expectedCurrentState: PathState }
  | {
      kind: "restore_managed_tree";
      targetRelativePath: string;
      backupId: string;
      expectedCurrentState: PathState;
    }
  | { kind: "remove_empty_directory"; targetRelativePath: string }
  | { kind: "ensure_directory"; targetRelativePath: string };

export function deriveInverseCandidate(outcome: OperationOutcome): InverseCandidate {
  if (outcome.outcome !== "applied") {
    return { kind: "none", reason: `Operation outcome is ${outcome.outcome}.` };
  }

  switch (outcome.operationKind) {
    case "install_new_file":
      return {
        kind: "delete_file",
        targetRelativePath: outcome.targetRelativePath,
        expectedCurrentState: outcome.postState
      };
    case "replace_file":
      if (!outcome.backupId) {
        return { kind: "none", reason: "The applied replacement has no backup reference." };
      }
      return {
        kind: "restore_backup",
        targetRelativePath: outcome.targetRelativePath,
        backupId: outcome.backupId,
        expectedCurrentState: outcome.postState
      };
    case "install_tree":
      return {
        kind: "remove_owned_tree",
        targetRelativePath: outcome.targetRelativePath,
        expectedCurrentState: outcome.postState
      };
    case "replace_managed_tree":
      if (!outcome.backupId) {
        return { kind: "none", reason: "The applied managed-tree replacement has no backup reference." };
      }
      return {
        kind: "restore_managed_tree",
        targetRelativePath: outcome.targetRelativePath,
        backupId: outcome.backupId,
        expectedCurrentState: outcome.postState
      };
    case "ensure_directory":
      return { kind: "remove_empty_directory", targetRelativePath: outcome.targetRelativePath };
    case "remove_empty_directory":
      return { kind: "ensure_directory", targetRelativePath: outcome.targetRelativePath };
    default: {
      const exhaustive: never = outcome.operationKind;
      return exhaustive;
    }
  }
}
