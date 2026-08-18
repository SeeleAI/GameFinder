import path from "node:path";

import {
  resolveDefaultSaveManagerRoot,
  SaveService,
} from "../src/save/save-service.js";

const REPLACEMENT_RECORD_ID = "610e9dbc-82ab-4d84-af27-5884e4f721e6";
const BASELINE_BACKUP_ID = "331f2735-3169-4c17-8d53-b49fcb0aa522";
const SAVE_CONTEXT_ID = "2e2bc97b-8f70-41a4-8288-f8507b52ec72";

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
    throw new Error("ER-02 baseline and Save Context identities do not match.");
  }

  const runtimeVerification = existingRuntimeVerificationId
    ? await service.getSaveRuntimeVerification(existingRuntimeVerificationId)
    : await service.recordSaveRuntimeVerification({
        operationRecordId: REPLACEMENT_RECORD_ID,
        outcome: "passed",
        notes:
          "User confirmed the imported Elden Ring character Bly was visible, loaded successfully, and could be played normally before Steam was fully exited.",
      });
  if (
    runtimeVerification.operationRecordId !== REPLACEMENT_RECORD_ID ||
    runtimeVerification.outcome !== "passed"
  ) {
    throw new Error("The runtime verification does not prove the ER-08 replacement passed.");
  }

  const restorePlan = await service.planSaveRestore({
    backupId: BASELINE_BACKUP_ID,
    saveContextId: SAVE_CONTEXT_ID,
    mode: "exact_managed_snapshot",
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    acceptanceCompleted: ["ER-08"],
    acceptancePlanned: ["ER-09"],
    replacementOperationRecordId: REPLACEMENT_RECORD_ID,
    runtimeVerification,
    baseline: {
      backupId: baseline.backupId,
      treeHash: baseline.treeHash,
      files: baseline.files,
    },
    restorePlan,
    writesToRealSaveFiles: false,
    nextAction:
      "Review and explicitly approve this exact restorePlanId. Applying it requires Elden Ring and Steam processes to remain stopped.",
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown M6 restore planning error";
  console.error(`M6 baseline restore planning failed: ${message}`);
  process.exitCode = 1;
});
