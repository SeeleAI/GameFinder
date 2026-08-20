import {
  resolveDefaultSaveManagerRoot,
  SaveService,
} from "../src/save/save-service.js";

const RESTORE_OPERATION_RECORD_ID = "3ee43ebb-9b05-42a0-b739-baa9a984f848";
const RESTORE_OPERATION_RECORD_HASH =
  "3a2dd91616087ad4a7d4e0cf45ebc29590d0a14a5b48b1dbf51b85eca2abe683";

async function main(): Promise<void> {
  const service = await SaveService.create({
    managerRoot: resolveDefaultSaveManagerRoot(),
  });
  const runtimeVerification = await service.recordSaveRuntimeVerification({
    operationRecordId: RESTORE_OPERATION_RECORD_ID,
    outcome: "original_restored",
    notes:
      "The restore passed static verification before launch. User then entered Ghost of Tsushima and confirmed the original save had been restored. GhostOfTsushima.exe was confirmed stopped afterward. The game updated auto.sav during launch/inspection while manual_0000.sav remained byte-identical to baseline; this expected post-launch drift was preserved and was not overwritten again.",
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    acceptanceCompleted: ["GOT-11-baseline-restore-runtime", "G7"],
    operationRecordId: RESTORE_OPERATION_RECORD_ID,
    operationRecordHash: RESTORE_OPERATION_RECORD_HASH,
    staticVerificationBeforeLaunch: "passed",
    postLaunchState: "auto-save-drift-preserved",
    runtimeVerification,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
