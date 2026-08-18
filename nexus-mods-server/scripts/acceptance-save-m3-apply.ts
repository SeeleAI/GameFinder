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
  const replacementPlanId = argument("--replacement-plan-id");
  const configuredManagerRoot = argument("--manager-root");
  if (!replacementPlanId) {
    throw new Error(
      "Usage: pnpm acceptance:save-m3-apply -- --replacement-plan-id <uuid> [--manager-root <absolute-path>]",
    );
  }
  if (configuredManagerRoot && !path.isAbsolute(configuredManagerRoot)) {
    throw new Error("--manager-root must be absolute.");
  }
  const managerRoot = configuredManagerRoot ?? resolveDefaultSaveManagerRoot();
  const service = await SaveService.create({ managerRoot });
  const plan = await service.getSaveReplacementPlan(replacementPlanId);
  const applied = await service.applySaveReplacement(replacementPlanId);
  const verified = await service.verifySaveReplacement(applied.record.recordId);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        acceptanceApplied: "ER-05-static",
        replacementPlanId: plan.replacementPlanId,
        planHash: plan.planHash,
        operations: plan.operations,
        payloadPolicies: plan.payloadPolicies,
        transactionId: verified.transactionId,
        operationRecordId: verified.recordId,
        rescueBackupId: applied.rescueBackupId,
        staticVerification: verified.staticVerification,
        runtimeVerification: "pending-user-offline-test",
        idempotentReplay: applied.idempotentReplay,
        nextAction:
          "Keep Steam offline. Launch Elden Ring offline, confirm the old save is visible and loadable, save/exit normally, then report the result before baseline restoration.",
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown acceptance error";
  console.error(`M3 save replacement apply failed: ${message}`);
  process.exitCode = 1;
});
