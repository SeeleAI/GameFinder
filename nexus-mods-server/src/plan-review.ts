import { z } from "zod/v4";

import { sha256CanonicalJson } from "./install/content-hash.js";

export const PLAN_REVIEW_POLICY_VERSION = "2026-08-auto-safe-v1";

export const planReviewModeSchema = z
  .enum(["auto_safe", "always_review"])
  .describe(
    "Review policy mode. auto_safe is the default and still performs risk classification; always_review forces request_confirmation for an otherwise executable Plan.",
  );
export const planReviewClassificationSchema = z
  .enum(["auto_safe", "review_required", "blocked"])
  .describe(
    "Deterministic risk result: auto_safe may apply now, review_required needs confirmation, and blocked must not apply.",
  );
export const planReviewNextActionSchema = z
  .enum(["apply_now", "request_confirmation", "stop"])
  .describe("The only permitted next action for the classified Plan.");
export const planReviewActionSchema = z.enum([
  "install",
  "uninstall",
  "restore",
  "replace",
]);
export const planReviewReasonCodeSchema = z.enum([
  "BOUNDED_REVERSIBLE_FILE_OPERATION",
  "CONTROLLED_INSTALLER",
  "REPLACE_EXISTING_FILE",
  "HIGH_RISK_PLAN",
  "MANUAL_RECOVERY",
  "BLOCKING_CONFLICT",
  "USER_REQUESTED_REVIEW",
  "MANAGED_UNINSTALL",
  "SANDBOX_SAVE_TRANSACTION",
  "LIVE_SAVE_TRANSACTION",
  "LEGACY_PLAN_REQUIRES_REVIEW",
]);

export const planReviewSchema = z.object({
  classification: planReviewClassificationSchema,
  reasonCodes: z.array(planReviewReasonCodeSchema).min(1).max(100),
  policyVersion: z.string().trim().min(1).max(100),
  reviewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  nextAction: planReviewNextActionSchema,
  requestScope: z.object({
    mode: planReviewModeSchema,
    action: planReviewActionSchema,
    targetIds: z.array(z.string().trim().min(1).max(1_024)).min(1).max(100),
  }),
});

export type PlanReviewMode = z.infer<typeof planReviewModeSchema>;
export type PlanReviewClassification = z.infer<
  typeof planReviewClassificationSchema
>;
export type PlanReviewReasonCode = z.infer<typeof planReviewReasonCodeSchema>;
export type PlanReviewAction = z.infer<typeof planReviewActionSchema>;
export type PlanReview = z.infer<typeof planReviewSchema>;

function nextAction(
  classification: PlanReviewClassification,
): PlanReview["nextAction"] {
  if (classification === "auto_safe") return "apply_now";
  if (classification === "review_required") return "request_confirmation";
  return "stop";
}

export function createPlanReview(input: {
  classification: PlanReviewClassification;
  reasonCodes: ReadonlyArray<PlanReviewReasonCode>;
  mode?: PlanReviewMode;
  action: PlanReviewAction;
  targetIds: ReadonlyArray<string>;
  decisionInputs: unknown;
}): PlanReview {
  const requestScope = {
    mode: input.mode ?? "auto_safe",
    action: input.action,
    targetIds: [...new Set(input.targetIds)],
  };
  const reasonCodes = [...new Set(input.reasonCodes)];
  return planReviewSchema.parse({
    classification: input.classification,
    reasonCodes,
    policyVersion: PLAN_REVIEW_POLICY_VERSION,
    reviewDigest: sha256CanonicalJson({
      classification: input.classification,
      reasonCodes,
      policyVersion: PLAN_REVIEW_POLICY_VERSION,
      requestScope,
      decisionInputs: input.decisionInputs,
    }),
    nextAction: nextAction(input.classification),
    requestScope,
  });
}

export function legacyPlanReview(input: {
  action: PlanReviewAction;
  targetIds: ReadonlyArray<string>;
  planHash: string;
}): PlanReview {
  return planReviewSchema.parse({
    classification: "review_required",
    reasonCodes: ["LEGACY_PLAN_REQUIRES_REVIEW"],
    policyVersion: "legacy",
    reviewDigest: input.planHash,
    nextAction: "request_confirmation",
    requestScope: {
      mode: "always_review",
      action: input.action,
      targetIds: [...new Set(input.targetIds)],
    },
  });
}

export function effectivePlanReview(
  review: PlanReview | undefined,
  legacy: Parameters<typeof legacyPlanReview>[0],
): PlanReview {
  return review ?? legacyPlanReview(legacy);
}
