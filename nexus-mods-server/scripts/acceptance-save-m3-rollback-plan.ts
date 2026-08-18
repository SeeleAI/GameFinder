import path from "node:path";

import {
  resolveDefaultSaveManagerRoot,
  SaveService,
} from "../src/save/save-service.js";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1]?.trim();
  return value || null;
}

async function main(): Promise<void> {
  const operationRecordId = argument("--operation-record-id");
  const baselineBackupId = argument("--baseline-backup-id");
  const saveContextId = argument("--save-context-id");
  const existingRuntimeVerificationId = argument("--runtime-verification-id");
  const configuredManagerRoot = argument("--manager-root");
  if (!operationRecordId || !baselineBackupId || !saveContextId) {
    throw new Error(
      "Usage: pnpm acceptance:save-m3-rollback-plan -- --operation-record-id <uuid> --baseline-backup-id <uuid> --save-context-id <uuid> [--manager-root <absolute-path>]",
    );
  }
  if (configuredManagerRoot && !path.isAbsolute(configuredManagerRoot)) {
    throw new Error("--manager-root must be absolute.");
  }
  const managerRoot = configuredManagerRoot ?? resolveDefaultSaveManagerRoot();
  const service = await SaveService.create({ managerRoot });
  const [baseline, context] = await Promise.all([
    service.verifySaveBackup(baselineBackupId),
    service.getSaveContext(saveContextId),
  ]);
  if (baseline.saveContextId !== context.saveContextId) {
    throw new Error("Baseline and Save Context identities do not match.");
  }
  const runtimeVerification = existingRuntimeVerificationId
    ? await service.getSaveRuntimeVerification(existingRuntimeVerificationId)
    : await service.recordSaveRuntimeVerification({
        operationRecordId,
        outcome: "passed",
        notes:
          "User confirmed the old Elden Ring save was visible and loadable, played for about ten seconds, and exited normally after the game auto-saved.",
      });
  if (
    runtimeVerification.operationRecordId !== operationRecordId ||
    runtimeVerification.outcome !== "passed"
  ) {
    throw new Error("The supplied runtime verification does not prove this replacement passed.");
  }
  const restorePlan = await service.planSaveRestore({
    backupId: baselineBackupId,
    saveContextId,
    mode: "exact_managed_snapshot",
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        acceptanceCompleted: ["ER-05"],
        acceptancePlanned: ["ER-09"],
        runtimeVerification,
        baseline: {
          backupId: baseline.backupId,
          treeHash: baseline.treeHash,
          files: baseline.files,
        },
        restorePlan,
        writesToRealSaveFiles: false,
        nextAction:
          "Review and explicitly approve this exact restorePlanId. Apply requires Elden Ring and Steam processes stopped.",
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown acceptance error";
  console.error(`M3 baseline rollback planning failed: ${message}`);
  process.exitCode = 1;
});
