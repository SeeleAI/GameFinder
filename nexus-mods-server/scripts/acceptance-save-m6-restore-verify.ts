import path from "node:path";

import {
  resolveDefaultSaveManagerRoot,
  SaveService,
} from "../src/save/save-service.js";

const RESTORE_OPERATION_RECORD_ID = "ee5f4a6d-4b91-4dfb-b85c-932deecd30f9";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1]?.trim();
  return value || null;
}

async function main(): Promise<void> {
  const configuredManagerRoot = argument("--manager-root");
  if (configuredManagerRoot && !path.isAbsolute(configuredManagerRoot)) {
    throw new Error("--manager-root must be absolute.");
  }
  const managerRoot = configuredManagerRoot ?? resolveDefaultSaveManagerRoot();
  const service = await SaveService.create({ managerRoot });
  const operation = await service.verifySaveRestore(RESTORE_OPERATION_RECORD_ID);
  const runtimeVerification = await service.recordSaveRuntimeVerification({
    operationRecordId: RESTORE_OPERATION_RECORD_ID,
    outcome: "original_restored",
    notes:
      "User confirmed the original WhiteFur save was visible after baseline restoration. The user did not report loading or playing it. Afterward Elden Ring and Steam were confirmed stopped, and post-launch static verification showed every managed file still matched the ER-02 baseline.",
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    acceptanceCompleted: ["ER-09", "M6"],
    operationRecordId: operation.recordId,
    staticVerification: operation.staticVerification,
    runtimeVerification,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown M6 restore verification error";
  console.error(`M6 baseline restore verification failed: ${message}`);
  process.exitCode = 1;
});
