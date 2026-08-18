import { describe, expect, it } from "vitest";

import {
  createPlanReview,
  effectivePlanReview,
  PLAN_REVIEW_POLICY_VERSION,
} from "../src/plan-review.js";

describe("Plan review policy", () => {
  it("defaults routine bounded work to auto_safe", () => {
    const review = createPlanReview({
      classification: "auto_safe",
      reasonCodes: ["BOUNDED_REVERSIBLE_FILE_OPERATION"],
      action: "install",
      targetIds: ["proposal-1", "package-1"],
      decisionInputs: {
        operationKinds: ["install_new_file"],
        targets: ["Mods/Example/example.dll"],
      },
    });

    expect(review).toMatchObject({
      classification: "auto_safe",
      nextAction: "apply_now",
      policyVersion: PLAN_REVIEW_POLICY_VERSION,
      requestScope: {
        mode: "auto_safe",
        action: "install",
        targetIds: ["proposal-1", "package-1"],
      },
    });
    expect(review.reviewDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("maps review_required and blocked to distinct next actions", () => {
    const reviewRequired = createPlanReview({
      classification: "review_required",
      reasonCodes: ["CONTROLLED_INSTALLER", "HIGH_RISK_PLAN"],
      action: "install",
      targetIds: ["proposal-2"],
      decisionInputs: { operationKind: "run_bundled_installer" },
    });
    const blocked = createPlanReview({
      classification: "blocked",
      reasonCodes: ["BLOCKING_CONFLICT"],
      action: "install",
      targetIds: ["proposal-3"],
      decisionInputs: { blocking: true },
    });

    expect(reviewRequired.nextAction).toBe("request_confirmation");
    expect(blocked.nextAction).toBe("stop");
  });

  it("treats an immutable legacy Plan without review metadata as review_required", () => {
    const planHash = "a".repeat(64);
    expect(
      effectivePlanReview(undefined, {
        action: "restore",
        targetIds: ["legacy-plan"],
        planHash,
      }),
    ).toEqual({
      classification: "review_required",
      reasonCodes: ["LEGACY_PLAN_REQUIRES_REVIEW"],
      policyVersion: "legacy",
      reviewDigest: planHash,
      nextAction: "request_confirmation",
      requestScope: {
        mode: "always_review",
        action: "restore",
        targetIds: ["legacy-plan"],
      },
    });
  });
});
