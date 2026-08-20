import path from "node:path";

import {
  resolveDefaultSaveManagerRoot,
  SaveService,
} from "../src/save/save-service.js";

const REPLACEMENT_RECORD_ID = "97387d28-2693-43d0-a210-66b917864f43";
// The G7 pre-replacement rescue is byte-identical to the earlier acceptance
// baseline, but is bound to the current V2 Save Context and Recipe version.
const BASELINE_BACKUP_ID = "a1b60d2d-1334-4c09-99a8-00f7484815df";
const SAVE_CONTEXT_ID = "c001417d-3042-41bf-bd4e-991ba0638d5f";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1]?.trim();
  return value || null;
}

async function main(): Promise<void> {
  const configuredManagerRoot = argument("--manager-root");
  const existingRuntimeVerificationId = argument("--runtime-verification-id");
  if (configuredManagerRoot && !path.isAbsolute(configuredManagerRoot)) {
    throw new Error("--manager-root must be absolute.");
  }

  const managerRoot = configuredManagerRoot ?? resolveDefaultSaveManagerRoot();
  const service = await SaveService.create({ managerRoot });
  const [baseline, context] = await Promise.all([
    service.verifySaveBackup(BASELINE_BACKUP_ID),
    service.getSaveContext(SAVE_CONTEXT_ID),
  ]);
  if (baseline.saveContextId !== context.saveContextId) {
    throw new Error("G7 baseline and Save Context identities do not match.");
  }

  const runtimeVerification = existingRuntimeVerificationId
    ? await service.getSaveRuntimeVerification(existingRuntimeVerificationId)
    : await service.recordSaveRuntimeVerification({
        operationRecordId: REPLACEMENT_RECORD_ID,
        outcome: "passed",
        notes:
          "User confirmed the imported Ghost of Tsushima save was visible, loaded successfully, and could be played normally. GhostOfTsushima.exe was confirmed stopped before baseline restore planning.",
      });
  if (
    runtimeVerification.operationRecordId !== REPLACEMENT_RECORD_ID ||
    runtimeVerification.outcome !== "passed"
  ) {
    throw new Error("Runtime verification does not prove the G7 replacement passed.");
  }

  const restorePlan = await service.planSaveRestore({
    backupId: BASELINE_BACKUP_ID,
    saveContextId: SAVE_CONTEXT_ID,
    mode: "exact_managed_snapshot",
    reviewMode: "auto_safe",
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    acceptanceCompleted: ["GOT-10-runtime"],
    acceptancePlanned: ["GOT-11-baseline-restore"],
    replacementOperationRecordId: REPLACEMENT_RECORD_ID,
    runtimeVerification,
    baseline: {
      backupId: baseline.backupId,
      recordHash: baseline.backupRecordHash,
      treeHash: baseline.treeHash,
      files: baseline.files.map(({ relativePath, bytes, sha256 }) => ({
        relativePath,
        bytes,
        sha256,
      })),
    },
    restorePlan,
    review: restorePlan.review,
    liveSaveChanged: false,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
