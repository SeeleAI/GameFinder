import { SaveService, resolveDefaultSaveManagerRoot } from "../src/save/save-service.js";
import {
  verifyAdapterRequirementAssessmentHash,
  verifySaveCompatibilityAssessmentV2Hash,
} from "../src/save/v2/contracts.js";

const SAVE_CONTEXT_ID = "87b12429-3704-4238-ba22-63da37095cca";
const PACKAGE_ID = "savepkg-0a377996fc096ba26d7483beedbba0f62bf61818d42b5a08734057c8b9be0b36";

async function main(): Promise<void> {
  const service = await SaveService.create({ managerRoot: resolveDefaultSaveManagerRoot() });
  const backup = await service.assessSaveAdapterRequirement({
    saveContextId: SAVE_CONTEXT_ID,
    intendedOperation: "backup",
  });
  const restore = await service.assessSaveAdapterRequirement({
    saveContextId: SAVE_CONTEXT_ID,
    intendedOperation: "restore-exact-bytes",
  });
  const replacement = await service.assessSaveAdapterRequirement({
    saveContextId: SAVE_CONTEXT_ID,
    packageId: PACKAGE_ID,
    intendedOperation: "replace-whole-unit",
  });
  const compatibility = await service.assessSavePackageCompatibility({
    saveContextId: SAVE_CONTEXT_ID,
    packageId: PACKAGE_ID,
  }) as never;
  if (!verifyAdapterRequirementAssessmentHash(backup.assessment)) throw new Error("Backup assessment hash failed.");
  if (!verifyAdapterRequirementAssessmentHash(restore.assessment)) throw new Error("Restore assessment hash failed.");
  if (!verifyAdapterRequirementAssessmentHash(replacement.assessment)) throw new Error("Replacement assessment hash failed.");
  if (!verifySaveCompatibilityAssessmentV2Hash(compatibility)) throw new Error("Compatibility assessment hash failed.");
  if (replacement.assessment.requirement !== "undetermined" || replacement.assessment.replacementPlanAllowed) {
    throw new Error("The real GoT source must remain blocked while account/checksum evidence is unknown.");
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    acceptance: ["GOT-08", "GOT-09"],
    backup: backup.assessment,
    restore: restore.assessment,
    replacement: replacement.assessment,
    compatibility,
    liveSaveChanged: false,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
