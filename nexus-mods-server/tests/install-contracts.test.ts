import { describe, expect, it } from "vitest";
import {
  backupObjectSchema,
  currentStateInspectionSchema,
  gameInstanceSchema,
  gameProfileSchema,
  installationRecordSchema,
  installPlanSchema,
  packageAnalysisSchema,
  transactionJournalSchema,
  uninstallPlanSchema
} from "../src/install/contracts.js";
import {
  deriveInverseCandidate,
  getReversibilityContract,
  validateOperationReversibility
} from "../src/install/reversibility.js";
import {
  backupObjectFixture,
  currentStateInspectionFixture,
  gameInstanceFixture,
  gameProfileFixture,
  installationRecordFixture,
  installFileOperation,
  installPlanFixture,
  packageAnalysisFixture,
  transactionJournalFixture,
  uninstallPlanFixture
} from "./fixtures/install-contract-fixtures.js";

describe("Phase 6B runtime contracts", () => {
  it("validates all six runtime objects plus profile and instance contracts", () => {
    expect(packageAnalysisSchema.parse(packageAnalysisFixture())).toEqual(packageAnalysisFixture());
    expect(installPlanSchema.parse(installPlanFixture())).toEqual(installPlanFixture());
    expect(transactionJournalSchema.parse(transactionJournalFixture())).toEqual(
      transactionJournalFixture()
    );
    expect(uninstallPlanSchema.parse(uninstallPlanFixture())).toEqual(
      uninstallPlanFixture()
    );
    expect(installationRecordSchema.parse(installationRecordFixture())).toEqual(
      installationRecordFixture()
    );
    expect(backupObjectSchema.parse(backupObjectFixture())).toEqual(backupObjectFixture());
    expect(currentStateInspectionSchema.parse(currentStateInspectionFixture())).toEqual(
      currentStateInspectionFixture()
    );
    expect(gameProfileSchema.parse(gameProfileFixture())).toEqual(gameProfileFixture());
    expect(gameInstanceSchema.parse(gameInstanceFixture())).toEqual(gameInstanceFixture());
  });

  it("rejects unknown schema versions and malformed hashes", () => {
    expect(
      packageAnalysisSchema.safeParse({ ...packageAnalysisFixture(), schemaVersion: 2 }).success
    ).toBe(false);
    expect(
      installPlanSchema.safeParse({
        ...installPlanFixture(),
        planHash: "not-a-sha256"
      }).success
    ).toBe(false);
  });

  it("keeps plans as desired intent and records as actual outcomes", () => {
    const plan = installPlanFixture();
    const record = installationRecordFixture();
    expect(plan.operations).toHaveLength(1);
    expect(record.operationOutcomes).toHaveLength(1);
    expect(record.sourcePlanId).toBe(plan.planId);
    expect(record.operationOutcomes[0]?.outcome).toBe("applied");
  });
});

describe("operation reversibility", () => {
  it("defines a reversibility contract for every operation kind", () => {
    const kinds = [
      "ensure_directory",
      "install_new_file",
      "replace_file",
      "install_tree",
      "replace_managed_tree",
      "remove_empty_directory"
    ] as const;
    for (const kind of kinds) {
      expect(getReversibilityContract(kind).operationKind).toBe(kind);
      expect(getReversibilityContract(kind).uninstallStrategy.length).toBeGreaterThan(10);
    }
  });

  it("accepts a valid install-new-file contract", () => {
    expect(() => validateOperationReversibility(installFileOperation())).not.toThrow();
  });

  it("rejects an irreversible pre-state and a mismatched post-state hash", () => {
    const invalidPreState = {
      ...installFileOperation(),
      expectedPreState: { kind: "file" as const, bytes: 1, sha256: "b".repeat(64) }
    };
    expect(() => validateOperationReversibility(invalidPreState)).toThrow(
      /requires pre-state absent/
    );

    const invalidPostState = {
      ...installFileOperation(),
      expectedPostState: { kind: "file" as const, bytes: 1, sha256: "b".repeat(64) }
    };
    expect(() => validateOperationReversibility(invalidPostState)).toThrow(
      /post-state hash must match/
    );
  });

  it("derives inverse candidates from actual applied outcomes, not skipped operations", () => {
    const applied = installationRecordFixture().operationOutcomes[0];
    expect(applied).toBeDefined();
    if (!applied) return;
    expect(deriveInverseCandidate(applied)).toMatchObject({
      kind: "delete_file",
      targetRelativePath: applied.targetRelativePath
    });

    expect(deriveInverseCandidate({ ...applied, outcome: "skipped_same_content" })).toEqual({
      kind: "none",
      reason: "Operation outcome is skipped_same_content."
    });
  });
});
