import {
  resolveDefaultSaveManagerRoot,
  SaveService,
} from "../src/save/save-service.js";

const RESTORE_PLAN_ID = "829e47f9-ea63-4825-82bb-91f0a8701bd5";

async function main(): Promise<void> {
  const service = await SaveService.create({
    managerRoot: resolveDefaultSaveManagerRoot(),
  });
  const frozen = await service.getSaveRestorePlan(RESTORE_PLAN_ID);
  const applied = await service.applySaveRestore(RESTORE_PLAN_ID);
  const verified = await service.verifySaveRestore(applied.record.recordId);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    acceptanceCompleted: ["GOT-11-baseline-restore-static"],
    plan: {
      id: frozen.restorePlanId,
      hash: frozen.planHash,
      target: frozen.target,
      backupId: frozen.backupId,
    },
    operation: verified,
    idempotentReplay: applied.idempotentReplay,
    staticVerification: verified.staticVerification,
    runtimeVerification: "not-run",
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
