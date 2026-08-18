import { readdir } from "node:fs/promises";
import path from "node:path";

import { sha256CanonicalJson } from "../src/install/content-hash.js";
import { sha256File } from "../src/install/file-hash.js";
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

async function sourceHashes(
  saveRoot: string,
  managedPaths: ReadonlyArray<string>,
): Promise<Array<{ relativePath: string; sha256: string | null }>> {
  return await Promise.all(
    managedPaths.map(async (relativePath) => ({
      relativePath,
      sha256: await sha256File(
        path.join(saveRoot, ...relativePath.split("/")),
      ).catch(() => null),
    })),
  );
}

async function main(): Promise<void> {
  const gameRoot = argument("--game-root");
  if (!gameRoot || !path.isAbsolute(gameRoot)) {
    throw new Error(
      "Usage: pnpm acceptance:save-m2 -- --game-root <absolute-path> [--manager-root <absolute-path>]",
    );
  }
  const configuredManagerRoot = argument("--manager-root");
  if (configuredManagerRoot && !path.isAbsolute(configuredManagerRoot)) {
    throw new Error("--manager-root must be absolute.");
  }
  const managerRoot = configuredManagerRoot ?? resolveDefaultSaveManagerRoot();
  const service = await SaveService.create({ managerRoot });
  const install = await service.probeGameInstall({ gameRoot });
  const context = await service.resolveSaveLocations(install.installContextId);
  if (install.game.canonicalId !== "steam:1245620") {
    throw new Error(`Expected steam:1245620, received ${install.game.canonicalId}.`);
  }
  if (context.verification.state !== "confirmed") {
    throw new Error(`Expected confirmed Save Context, received ${context.verification.state}.`);
  }
  const primary = context.saveRoots.find((root) => root.role === "primary");
  const unit = context.saveUnits.find((candidate) => candidate.unitId === "vanilla-main");
  if (!primary || !unit) throw new Error("Elden Ring primary Save Unit is unavailable.");
  const before = await sourceHashes(primary.absolutePath, unit.managedPaths);
  const backup = await service.createSaveBackup({
    saveContextId: context.saveContextId,
    unitId: unit.unitId,
    reason: "acceptance_baseline",
  });
  const freshService = await SaveService.create({ managerRoot });
  const verifiedBackup = await freshService.verifySaveBackup(backup.backupId);
  const afterBackup = await sourceHashes(primary.absolutePath, unit.managedPaths);
  if (sha256CanonicalJson(before) !== sha256CanonicalJson(afterBackup)) {
    throw new Error("ER-02 failed: the source Save Unit changed during backup.");
  }
  const plan = await freshService.planSaveRestore({
    backupId: backup.backupId,
    saveContextId: context.saveContextId,
    mode: "exact_managed_snapshot",
    targetKind: "sandbox",
  });
  const first = await freshService.applySaveRestore(plan.restorePlanId);
  const verifiedRecord = await freshService.verifySaveRestore(first.record.recordId);
  const sandboxFiles = await readdir(plan.target.absolutePath, {
    recursive: true,
    withFileTypes: true,
  });
  const sandboxRelativeFiles = sandboxFiles
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(
          plan.target.absolutePath,
          path.join(entry.parentPath, entry.name),
        )
        .split(path.sep)
        .join("/"),
    )
    .sort();
  const restoredFiles = await Promise.all(
    verifiedBackup.files.map(async (file) => ({
      relativePath: file.relativePath,
      bytes: file.bytes,
      sha256: await sha256File(
        path.join(plan.target.absolutePath, ...file.relativePath.split("/")),
      ),
    })),
  );
  const restoredTreeHash = sha256CanonicalJson(restoredFiles);
  if (restoredTreeHash !== verifiedBackup.treeHash) {
    throw new Error("ER-04 failed: sandbox tree hash differs from the baseline.");
  }
  if (
    sha256CanonicalJson(sandboxRelativeFiles) !==
    sha256CanonicalJson(
      verifiedBackup.files.map((file) => file.relativePath).sort(),
    )
  ) {
    throw new Error("ER-04 failed: sandbox file set differs from the baseline.");
  }
  const replay = await freshService.applySaveRestore(plan.restorePlanId);
  if (!replay.idempotentReplay || replay.record.recordId !== first.record.recordId) {
    throw new Error("ER-04 failed: repeated restore was not idempotent.");
  }
  const afterRestore = await sourceHashes(primary.absolutePath, unit.managedPaths);
  if (sha256CanonicalJson(before) !== sha256CanonicalJson(afterRestore)) {
    throw new Error("ER-04 failed: sandbox restore changed the live Save Unit.");
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        acceptance: ["ER-02", "ER-04"],
        managerRoot,
        saveContextId: context.saveContextId,
        sourceRoot: primary.absolutePath,
        sourceHashes: before,
        backup: {
          backupId: verifiedBackup.backupId,
          backupRecordHash: verifiedBackup.backupRecordHash,
          treeHash: verifiedBackup.treeHash,
          files: verifiedBackup.files,
          sourceStable: verifiedBackup.sourcePreStateHash === verifiedBackup.sourcePostStateHash,
          verifiedInFreshService: true,
        },
        sandboxRestore: {
          restorePlanId: plan.restorePlanId,
          planHash: plan.planHash,
          transactionId: verifiedRecord.transactionId,
          recordId: verifiedRecord.recordId,
          targetAbsolutePath: plan.target.absolutePath,
          restoredTreeHash,
          staticVerification: verifiedRecord.staticVerification,
          idempotentReplay: replay.idempotentReplay,
        },
        writesToRealSaveFiles: false,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown acceptance error";
  console.error(`M2 save acceptance failed: ${message}`);
  process.exitCode = 1;
});
