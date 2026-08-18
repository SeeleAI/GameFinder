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
  const restorePlanId = argument("--restore-plan-id");
  const baselineBackupId = argument("--baseline-backup-id");
  const configuredManagerRoot = argument("--manager-root");
  if (!restorePlanId || !baselineBackupId) {
    throw new Error(
      "Usage: pnpm acceptance:save-m3-rollback-apply -- --restore-plan-id <uuid> --baseline-backup-id <uuid> [--manager-root <absolute-path>]",
    );
  }
  if (configuredManagerRoot && !path.isAbsolute(configuredManagerRoot)) {
    throw new Error("--manager-root must be absolute.");
  }

  const managerRoot = configuredManagerRoot ?? resolveDefaultSaveManagerRoot();
  const service = await SaveService.create({ managerRoot });
  const plan = await service.getSaveRestorePlan(restorePlanId);
  if (plan.backupId !== baselineBackupId) {
    throw new Error("The approved Restore Plan does not target the expected baseline backup.");
  }

  const baseline = await service.verifySaveBackup(baselineBackupId);
  const applied = await service.applySaveRestore(restorePlanId);
  const verified = await service.verifySaveRestore(applied.record.recordId);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        acceptanceApplied: "ER-09-static",
        restorePlanId: plan.restorePlanId,
        planHash: plan.planHash,
        baselineBackupId: baseline.backupId,
        baselineTreeHash: baseline.treeHash,
        baselineFiles: baseline.files,
        operations: plan.operations,
        preservedPaths: plan.preservedPaths ?? [],
        transactionId: verified.transactionId,
        operationRecordId: verified.recordId,
        staticVerification: verified.staticVerification,
        runtimeVerification: "pending-user-offline-test",
        idempotentReplay: applied.idempotentReplay,
        nextAction:
          "Keep Steam offline. Launch Elden Ring only far enough to confirm the original save/character is visible, then quit without loading or playing and report the result.",
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown acceptance error";
  console.error(`M3 baseline restore apply failed: ${message}`);
  process.exitCode = 1;
});
