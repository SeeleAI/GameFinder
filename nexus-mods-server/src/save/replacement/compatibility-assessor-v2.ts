import { randomUUID } from "node:crypto";

import { NexusError } from "../../errors.js";
import type { SavePackageNormalizer } from "../package/package-normalizer.js";
import type { SaveContextV2Store } from "../storage/save-context-v2-store.js";
import type { SaveCompatibilityAssessmentV2 } from "../v2/contracts.js";
import { computeSaveCompatibilityAssessmentV2Hash, saveCompatibilityAssessmentV2Schema, verifySaveCompatibilityAssessmentV2Hash } from "../v2/contracts.js";
import { ensureRealStoreDirectory, publishJsonExclusive, readStoredJson } from "../storage/json-store.js";
import path from "node:path";
import type { AdapterRequirementAssessor } from "../adapter-assessment/adapter-requirement-assessor.js";
import type { GameSaveRecipeRegistryV2 } from "../recipes/recipe-registry.js";
import { matchesRecipePathPattern } from "../layout-families/materializer.js";

export class SaveCompatibilityAssessorV2 {
  private constructor(
    private readonly contexts: SaveContextV2Store,
    private readonly packages: SavePackageNormalizer,
    private readonly storeRoot: string,
    private readonly adapterRequirements: AdapterRequirementAssessor,
    private readonly recipes: GameSaveRecipeRegistryV2,
  ) {}

  static async create(options: { managerRoot: string; contexts: SaveContextV2Store; packages: SavePackageNormalizer; adapterRequirements: AdapterRequirementAssessor; recipes: GameSaveRecipeRegistryV2 }): Promise<SaveCompatibilityAssessorV2> {
    return new SaveCompatibilityAssessorV2(
      options.contexts,
      options.packages,
      await ensureRealStoreDirectory(options.managerRoot, "save-compatibility-assessments-v2"),
      options.adapterRequirements,
      options.recipes,
    );
  }

  async assess(input: { packageId: string; saveContextId: string }): Promise<Readonly<SaveCompatibilityAssessmentV2>> {
    const [savePackage, context] = await Promise.all([
      this.packages.getV2(input.packageId),
      this.contexts.get(input.saveContextId),
    ]);
    const adapterRequirement = (await this.adapterRequirements.assess({
      packageId: input.packageId,
      saveContextId: input.saveContextId,
      intendedOperation: "replace-whole-unit",
    })).assessment;
    const reasons: string[] = [];
    const warnings = ["Static compatibility does not replace offline in-game runtime verification."];
    let state: SaveCompatibilityAssessmentV2["state"] = "compatible_direct";
    let accountRelation: SaveCompatibilityAssessmentV2["accountRelation"] = "unknown";
    const unit = context.saveUnits.find((candidate) => candidate.unitId === savePackage.unitId);
    const recipe = this.recipes.findById(context.recipe.recipeId);
    const recipeUnit = recipe?.saveUnits.find((candidate) => candidate.unitId === savePackage.unitId);
    if (savePackage.recipe.recipeHash !== context.recipe.recipeHash) {
      state = "unsupported";
      reasons.push("Package Recipe identity does not match the target Save Context.");
    } else if (!unit) {
      state = "unsupported";
      reasons.push("Package unitId is absent from the target Save Context.");
    } else if (unit.layoutFamily !== savePackage.layoutFamily) {
      state = "conversion_required";
      reasons.push("Package and target Layout Families differ.");
    }
    const targetMappings = savePackage.payload.files.map((file) => ({
      sourcePath: file.sourcePath,
      packageRelativePath: file.relativePath,
      targetRelativePath: file.relativePath,
    }));
    if (
      state === "compatible_direct" &&
      (
        !recipe ||
        recipe.recipeHash !== context.recipe.recipeHash ||
        !recipeUnit ||
        targetMappings.some((mapping) =>
          !recipeUnit.managedPatterns.some((pattern) =>
            matchesRecipePathPattern(mapping.targetRelativePath, pattern),
          ),
        )
      )
    ) {
      state = "unsupported";
      reasons.push("At least one package file maps outside the Recipe-authorized Save Unit patterns.");
    }
    if (state === "compatible_direct") {
      if (adapterRequirement.requirement === "required") {
        if (
          adapterRequirement.adapterAvailability === "matched" &&
          adapterRequirement.reasonCodes.includes("FORMAT_ADAPTER_VALIDATED_EXACT_REPLACEMENT")
        ) {
          accountRelation = "none";
          reasons.push(`Matched ${adapterRequirement.matchedAdapterId} validated every source and target file for scoped exact replacement.`);
        } else {
          accountRelation = savePackage.binding.value !== null && context.accountIdentity.value !== null
            ? "different"
            : "unknown";
          state = "conversion_required";
          reasons.push(`Adapter Requirement Assessment requires ${adapterRequirement.matchedAdapterId ?? "a format Adapter"}.`);
        }
      } else if (adapterRequirement.requirement === "undetermined") {
        accountRelation = "unknown";
        state = "ambiguous";
        reasons.push("Adapter Requirement Assessment could not prove account binding or checksum safety.");
      } else if (
        adapterRequirement.reasonCodes.includes("NO_BINDING_POLICY_VERIFIED") ||
        adapterRequirement.reasonCodes.includes("DIRECTORY_SCOPED_BINDING_VERIFIED")
      ) {
        accountRelation = "none";
        reasons.push("The scoped Recipe evidence establishes no internal account transform is required.");
      } else if (
        savePackage.binding.value !== null &&
        context.accountIdentity.value !== null &&
        savePackage.binding.kind === context.accountIdentity.kind &&
        savePackage.binding.value === context.accountIdentity.value
      ) {
        accountRelation = "same";
        reasons.push("Package and target account identity match with the same semantic kind.");
      } else if (savePackage.binding.value !== null && context.accountIdentity.value !== null) {
        accountRelation = "different";
        reasons.push("Account directory values differ, but scoped Adapter Requirement evidence permits generic replacement.");
      } else {
        accountRelation = "unknown";
        reasons.push("Adapter Requirement Assessment positively permits generic whole-unit replacement.");
      }
    }
    if (reasons.length === 0) reasons.push("Recipe, unit, layout, exact target mapping, and account evidence match.");
    const withoutHash: Omit<SaveCompatibilityAssessmentV2, "assessmentHash"> = {
      schemaVersion: 2,
      assessmentId: randomUUID(),
      packageId: savePackage.packageId,
      packageManifestHash: savePackage.manifestHash,
      saveContextId: context.saveContextId,
      saveContextHash: context.contextHash,
      unitId: savePackage.unitId,
      state,
      accountRelation,
      targetMappings,
      reasons,
      warnings,
      adapterRequirementAssessmentId: adapterRequirement.assessmentId,
      adapterRequirementAssessmentHash: adapterRequirement.assessmentHash,
      replacementPlanAllowed: state === "compatible_direct" && adapterRequirement.replacementPlanAllowed,
      assessedAt: new Date().toISOString(),
    };
    const assessment = saveCompatibilityAssessmentV2Schema.parse({
      ...withoutHash,
      assessmentHash: computeSaveCompatibilityAssessmentV2Hash(withoutHash),
    });
    await publishJsonExclusive(path.join(this.storeRoot, `${assessment.assessmentId}.json`), assessment);
    return Object.freeze(assessment);
  }

  async get(assessmentId: string): Promise<Readonly<SaveCompatibilityAssessmentV2>> {
    const assessment = await readStoredJson(path.join(this.storeRoot, `${assessmentId}.json`), saveCompatibilityAssessmentV2Schema, "Save Compatibility Assessment V2 was not found.");
    if (assessment.assessmentId !== assessmentId || !verifySaveCompatibilityAssessmentV2Hash(assessment)) {
      throw new NexusError("SAVE_CONTEXT_STALE", "Stored Save Compatibility Assessment V2 is stale.");
    }
    return Object.freeze(assessment);
  }
}
