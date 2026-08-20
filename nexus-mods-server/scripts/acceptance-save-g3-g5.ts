import { NexusError } from "../src/errors.js";
import { SaveService, resolveDefaultSaveManagerRoot } from "../src/save/save-service.js";
import type { SaveContextV2 } from "../src/save/v2/contracts.js";
import { verifySaveContextV2Hash } from "../src/save/v2/contracts.js";

async function main(): Promise<void> {
  const gameRoot = process.env.GAMEFINDER_ACCEPTANCE_GAME_ROOT?.trim();
  if (!gameRoot) throw new Error("GAMEFINDER_ACCEPTANCE_GAME_ROOT is required.");
  const service = await SaveService.create({ managerRoot: resolveDefaultSaveManagerRoot() });
  const install = await service.probeGameInstall({ gameRoot, resolverHint: "rune-steam-emulator" });
  const context = await service.resolveSaveLocations(install.installContextId) as unknown as SaveContextV2;
  if (!verifySaveContextV2Hash(context)) throw new Error("Save Context V2 hash verification failed.");
  const unit = context.saveUnits.find((candidate) => candidate.unitId === "main-saves");
  if (!unit) throw new Error("main-saves was not materialized.");
  const backup = await service.createSaveBackup({
    saveContextId: context.saveContextId,
    unitId: unit.unitId,
    reason: "acceptance_baseline",
  });
  await service.verifySaveBackup(backup.backupId);
  const plan = await service.planSaveRestore({
    backupId: backup.backupId,
    saveContextId: context.saveContextId,
    mode: "exact_managed_snapshot",
    targetKind: "sandbox",
  });
  if (plan.review?.nextAction !== "apply_now") throw new Error("Sandbox Restore Plan was not auto-safe.");
  const applied = await service.applySaveRestore(plan.restorePlanId);
  const record = await service.verifySaveRestore(applied.record.recordId);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    acceptance: ["GOT-02", "GOT-03", "GOT-04", "GOT-05"],
    installContext: {
      id: install.installContextId,
      hash: install.contextHash,
      schemaVersion: install.schemaVersion,
    },
    saveContext: {
      id: context.saveContextId,
      hash: context.contextHash,
      root: context.saveRoots[0]?.absolutePath,
      accountIdentity: context.accountIdentity,
      files: unit.materializedFiles,
    },
    backup: {
      id: backup.backupId,
      recordHash: backup.backupRecordHash,
      treeHash: backup.treeHash,
      files: backup.files.map(({ relativePath, bytes, sha256 }) => ({ relativePath, bytes, sha256 })),
    },
    sandboxRestore: {
      planId: plan.restorePlanId,
      planHash: plan.planHash,
      target: applied.targetAbsolutePath,
      recordId: record.recordId,
      recordHash: record.recordHash,
      staticVerification: record.staticVerification,
    },
    liveSaveChanged: false,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const output = error instanceof NexusError
    ? { ok: false, code: error.code, message: error.message, details: error.details ?? null }
    : { ok: false, code: "UNEXPECTED", message: error instanceof Error ? error.message : String(error) };
  process.stderr.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = 1;
});
