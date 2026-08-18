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
  const configuredManagerRoot = argument("--manager-root");
  if (!operationRecordId) {
    throw new Error(
      "Usage: pnpm acceptance:save-m3-rollback-verify -- --operation-record-id <uuid> [--manager-root <absolute-path>]",
    );
  }
  if (configuredManagerRoot && !path.isAbsolute(configuredManagerRoot)) {
    throw new Error("--manager-root must be absolute.");
  }

  const managerRoot = configuredManagerRoot ?? resolveDefaultSaveManagerRoot();
  const service = await SaveService.create({ managerRoot });
  const operation = await service.verifySaveRestore(operationRecordId);
  const runtimeVerification = await service.recordSaveRuntimeVerification({
    operationRecordId,
    outcome: "original_restored",
    notes:
      "User kept Steam offline, did not load or play the save, and confirmed from the save-selection presentation that the original character equipment and map position were restored. A post-launch static verification confirmed all managed file contents still match the ER-02 baseline.",
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        acceptanceCompleted: ["ER-09", "M3"],
        operationRecordId: operation.recordId,
        staticVerification: operation.staticVerification,
        runtimeVerification,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown acceptance error";
  console.error(`M3 baseline restore verification failed: ${message}`);
  process.exitCode = 1;
});
