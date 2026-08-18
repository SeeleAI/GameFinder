import path from "node:path";

import { sha256File } from "../src/install/file-hash.js";
import {
  resolveDefaultSaveManagerRoot,
  SaveService,
} from "../src/save/save-service.js";

const EXPECTED_RAR_SHA256 =
  "4e357c3209d44a0d457e17c4a9ae03c8276aff4cefa73720443c428541fc5dfa";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1]?.trim();
  return value || null;
}

async function main(): Promise<void> {
  const inputPath = argument("--input-path");
  const saveContextId = argument("--save-context-id");
  const baselineBackupId = argument("--baseline-backup-id");
  const configuredManagerRoot = argument("--manager-root");
  if (!inputPath || !path.isAbsolute(inputPath) || !saveContextId || !baselineBackupId) {
    throw new Error(
      "Usage: pnpm acceptance:save-m3-plan -- --input-path <absolute-rar> --save-context-id <uuid> --baseline-backup-id <uuid> [--manager-root <absolute-path>]",
    );
  }
  if (configuredManagerRoot && !path.isAbsolute(configuredManagerRoot)) {
    throw new Error("--manager-root must be absolute.");
  }
  const managerRoot = configuredManagerRoot ?? resolveDefaultSaveManagerRoot();
  const service = await SaveService.create({ managerRoot });
  const [context, baseline] = await Promise.all([
    service.getSaveContext(saveContextId),
    service.verifySaveBackup(baselineBackupId),
  ]);
  if (baseline.saveContextId !== context.saveContextId) {
    throw new Error("The ER-02 baseline does not belong to the requested Save Context.");
  }
  const beforeSha256 = await sha256File(inputPath);
  if (beforeSha256 !== EXPECTED_RAR_SHA256) {
    throw new Error(
      `ER-03 fixed RAR SHA-256 mismatch: expected ${EXPECTED_RAR_SHA256}, received ${beforeSha256}.`,
    );
  }
  const inspection = await service.inspectSaveInput(inputPath);
  if (inspection.input.kind !== "rar" || inspection.payloadCandidates.length !== 1) {
    throw new Error("ER-03 expected one unambiguous RAR payload candidate.");
  }
  const candidate = inspection.payloadCandidates[0]!;
  const savePackage = await service.normalizeSavePackage({
    inspectionId: inspection.inspectionId,
    payloadSelectionId: candidate.payloadSelectionId,
  });
  await service.verifyStandardSavePackage(savePackage.packageId);
  const afterSha256 = await sha256File(inputPath);
  if (afterSha256 !== beforeSha256) {
    throw new Error("ER-03 failed: the original RAR changed during normalization.");
  }
  const assessment = await service.assessSavePackageCompatibility({
    packageId: savePackage.packageId,
    saveContextId: context.saveContextId,
  });
  if (
    assessment.state !== "compatible_direct" ||
    assessment.recommendedStrategy !== "direct_replace"
  ) {
    throw new Error(`ER-05 cannot plan direct replacement: ${assessment.state}.`);
  }
  const plan = await service.planSaveReplacement({
    assessmentId: assessment.assessmentId,
    strategy: "direct_replace",
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        acceptanceCompleted: ["ER-03"],
        acceptancePlanned: ["ER-05"],
        managerRoot,
        baseline: {
          backupId: baseline.backupId,
          treeHash: baseline.treeHash,
          verified: true,
        },
        inspection: {
          inspectionId: inspection.inspectionId,
          inspectionHash: inspection.inspectionHash,
          input: inspection.input,
          archive: inspection.archive,
          payloadCandidate: candidate,
        },
        package: savePackage,
        compatibility: assessment,
        replacementPlan: plan,
        originalInputUnchanged: true,
        writesToRealSaveFiles: false,
        nextAction:
          "Review every operation and explicitly approve this exact replacementPlanId before apply_save_replacement.",
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown acceptance error";
  console.error(`M3 save plan acceptance failed: ${message}`);
  process.exitCode = 1;
});
