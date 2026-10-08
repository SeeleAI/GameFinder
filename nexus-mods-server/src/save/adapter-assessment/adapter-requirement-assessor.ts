import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import { sha256File } from "../../install/file-hash.js";
import { FormatAdapterRegistry, type FormatAdapterDescriptor } from "../adapters/format-adapter-registry.js";
import type { SavePackageNormalizer } from "../package/package-normalizer.js";
import type { GameSaveRecipeRegistryV2 } from "../recipes/recipe-registry.js";
import type { GameInstallContextV2Store } from "../storage/install-context-v2-store.js";
import type { SaveContextV2Store } from "../storage/save-context-v2-store.js";
import type {
  AdapterDevelopmentBrief,
  AdapterRequirementAssessment,
  StandardSavePackageV2,
} from "../v2/contracts.js";
import {
  adapterDevelopmentBriefSchema,
  adapterRequirementAssessmentSchema,
  computeAdapterDevelopmentBriefHash,
  computeAdapterRequirementAssessmentHash,
} from "../v2/contracts.js";
import { AdapterDevelopmentBriefStore } from "./adapter-development-brief-store.js";
import { AdapterRequirementAssessmentStore } from "./adapter-requirement-store.js";

export type AdapterIntendedOperation = AdapterRequirementAssessment["intendedOperation"];

export interface AdapterRequirementAssessmentResult {
  assessment: Readonly<AdapterRequirementAssessment>;
  developmentBrief: Readonly<AdapterDevelopmentBrief> | null;
}

const MAX_STATIC_SAMPLE_BYTES = 64 * 1024 * 1024;
const ASSESSOR_ID = "adapter-requirement-assessor";
const ASSESSOR_VERSION = "1.1.0";

function joinManagedPath(root: string, relativePath: string): string {
  const resolved = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(path.resolve(root), resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new NexusError("SAVE_PATH_INVALID", "A materialized save path escaped its frozen root.");
  }
  return resolved;
}

function findByteSequence(haystack: Buffer, needle: Buffer): boolean {
  return needle.length > 0 && haystack.indexOf(needle) >= 0;
}

function accountEncodings(value: string): Buffer[] {
  const encodings = [Buffer.from(value, "ascii"), Buffer.from(value, "utf16le")];
  if (/^\d{1,20}$/.test(value)) {
    try {
      const numeric = BigInt(value);
      if (numeric <= 0xffff_ffff_ffff_ffffn) {
        const littleEndian = Buffer.alloc(8);
        littleEndian.writeBigUInt64LE(numeric);
        encodings.push(littleEndian);
      }
    } catch {
      // The textual encodings still remain valid evidence probes.
    }
  }
  return encodings;
}

async function readBounded(filePath: string): Promise<Buffer | null> {
  const bytes = await readFile(filePath);
  return bytes.length <= MAX_STATIC_SAMPLE_BYTES ? bytes : null;
}

export class AdapterRequirementAssessor {
  private constructor(
    private readonly contexts: SaveContextV2Store,
    private readonly installs: GameInstallContextV2Store,
    private readonly packages: SavePackageNormalizer,
    private readonly recipes: GameSaveRecipeRegistryV2,
    private readonly adapters: FormatAdapterRegistry,
    private readonly assessments: AdapterRequirementAssessmentStore,
    private readonly briefs: AdapterDevelopmentBriefStore,
  ) {}

  static async create(options: {
    managerRoot: string;
    contexts: SaveContextV2Store;
    installs: GameInstallContextV2Store;
    packages: SavePackageNormalizer;
    recipes: GameSaveRecipeRegistryV2;
    adapters?: FormatAdapterRegistry;
  }): Promise<AdapterRequirementAssessor> {
    const [assessments, briefs] = await Promise.all([
      AdapterRequirementAssessmentStore.create(options.managerRoot),
      AdapterDevelopmentBriefStore.create(options.managerRoot),
    ]);
    return new AdapterRequirementAssessor(
      options.contexts,
      options.installs,
      options.packages,
      options.recipes,
      options.adapters ?? new FormatAdapterRegistry(),
      assessments,
      briefs,
    );
  }

  async assess(input: {
    saveContextId: string;
    packageId?: string;
    intendedOperation: AdapterIntendedOperation;
    sourceSlot?: number;
    targetSlot?: number;
    allowWholeUnitFallback?: boolean;
  }): Promise<AdapterRequirementAssessmentResult> {
    const context = await this.contexts.get(input.saveContextId);
    const install = await this.installs.get(context.installContextId);
    const recipe = this.recipes.findById(context.recipe.recipeId);
    if (!recipe || recipe.recipeHash !== context.recipe.recipeHash) {
      throw new NexusError("SAVE_CONTEXT_STALE", "The Save Context Recipe is unavailable or changed.");
    }
    const savePackage = input.packageId ? await this.packages.getV2(input.packageId) : null;
    if (savePackage && input.packageId !== savePackage.packageId) {
      throw new NexusError("SAVE_PACKAGE_INVALID", "The requested package identity changed.");
    }

    const reasonCodes: string[] = [];
    const satisfied = ["confirmed-save-context", "frozen-managed-paths"];
    const missing: string[] = [];
    const evidence: AdapterRequirementAssessment["evidence"] = [
      {
        kind: "save-context",
        detail: `Save Context ${context.saveContextId} is confirmed with hash ${context.contextHash}.`,
        confidence: "confirmed",
      },
      {
        kind: "recipe",
        detail: `Recipe ${recipe.recipeId}@${recipe.recipeVersion} declares binding policy ${recipe.binding.policy} and format ${recipe.format.kind}.`,
        confidence: "confirmed",
      },
    ];

    let requirement: AdapterRequirementAssessment["requirement"] = "undetermined";
    let adapterAvailability: AdapterRequirementAssessment["adapterAvailability"] = "not_applicable";
    let extensionTarget: AdapterRequirementAssessment["extensionTarget"] = "none";
    let matchedAdapterId: string | null = null;
    let compatibilityAssessmentAllowed = savePackage !== null;
    let replacementPlanAllowed = false;
    let nextAction = "Review the missing evidence before planning a live save change.";

    if (input.intendedOperation === "backup" || input.intendedOperation === "restore-exact-bytes") {
      if (savePackage) {
        throw new NexusError("SAVE_CONTRACT_INVALID", `${input.intendedOperation} does not accept a Standard Save Package.`);
      }
      requirement = "not_required";
      adapterAvailability = "not_applicable";
      reasonCodes.push(input.intendedOperation === "backup" ? "OPAQUE_BACKUP" : "EXACT_BYTES_RESTORE");
      satisfied.push("opaque-byte-preservation");
      compatibilityAssessmentAllowed = false;
      nextAction = input.intendedOperation === "backup"
        ? "Proceed through the verified backup workflow."
        : "Proceed through the immutable Restore Plan workflow.";
    } else if (!savePackage) {
      extensionTarget = "game-recipe";
      reasonCodes.push("PACKAGE_REQUIRED");
      missing.push("standard-save-package");
      compatibilityAssessmentAllowed = false;
      nextAction = "Inspect and normalize the source into a Standard Save Package V2, then reassess.";
    } else if (savePackage.recipe.recipeHash !== context.recipe.recipeHash) {
      extensionTarget = "game-recipe";
      reasonCodes.push("RECIPE_IDENTITY_MISMATCH");
      missing.push("matching-game-recipe");
      evidence.push({ kind: "package", detail: "Package and target Recipe hashes differ.", confidence: "confirmed" });
      nextAction = "Select or create a package for the target Recipe; do not develop a format Adapter for a game-identity mismatch.";
    } else {
      satisfied.push("recipe-identity");
      const unit = context.saveUnits.find((candidate) => candidate.unitId === savePackage.unitId);
      if (!unit || unit.layoutFamily !== savePackage.layoutFamily) {
        extensionTarget = "layout-family";
        reasonCodes.push(unit ? "LAYOUT_FAMILY_MISMATCH" : "SAVE_UNIT_MISSING");
        missing.push(unit ? "matching-layout-family" : "target-save-unit");
        nextAction = "Fix or extend the declarative Layout Family and rematerialize the Save Context; a format Adapter is not yet indicated.";
      } else {
        satisfied.push("save-unit", "layout-family", "exact-target-mapping");
        evidence.push(...await this.staticEvidence(context, savePackage));
        const adapterId = context.format.adapterId ?? savePackage.format.adapterHint;
        const matchedAdapter = this.adapters.match({ adapterId, recipe, operation: input.intendedOperation });
        const adapterValidation = matchedAdapter?.validateBytes
          ? await this.validateAdapterScope(context, savePackage, matchedAdapter)
          : { valid: true, evidence: [] as AdapterRequirementAssessment["evidence"] };
        evidence.push(...adapterValidation.evidence);
        const adapterMatched = matchedAdapter !== null && adapterValidation.valid;
        if (matchedAdapter) {
          matchedAdapterId = matchedAdapter.adapterId;
          adapterAvailability = "matched";
          evidence.push({
            kind: "adapter-contract",
            detail: `Matched ${matchedAdapter.adapterId}@${matchedAdapter.adapterVersion} for ${input.intendedOperation} with capabilities ${matchedAdapter.capabilities.join(", ")}.`,
            confidence: "confirmed",
          });
        }

        if (matchedAdapter && !adapterValidation.valid) {
          requirement = "undetermined";
          adapterAvailability = "missing";
          extensionTarget = "format-adapter";
          reasonCodes.push("ADAPTER_SCOPE_MISMATCH");
          missing.push("adapter-supported-format-scope");
          nextAction = "The declared Adapter does not validate every source and target fixture; stop and update its format scope before reassessment.";
        } else if (input.intendedOperation === "version-conversion") {
          requirement = "required";
          extensionTarget = "format-adapter";
          reasonCodes.push("VERSION_CONVERSION_REQUIRED");
          missing.push("version-migration", "post-migration-format-verification");
        } else if (input.intendedOperation === "import-container-slot" && input.allowWholeUnitFallback !== true) {
          requirement = "required";
          extensionTarget = "format-adapter";
          reasonCodes.push("PARTIAL_CONTAINER_IMPORT");
          missing.push("container-parse", "slot-transform", "container-rebuild", "checksum-verification");
        } else if (savePackage.layoutFamily !== "slot-file-set" && input.intendedOperation === "import-slot-file") {
          requirement = "required";
          extensionTarget = "format-adapter";
          reasonCodes.push("SLOT_NOT_INDEPENDENT_FILE");
          missing.push("slot-extraction", "slot-transform", "format-verification");
        } else if (
          input.intendedOperation === "cross-account-import" &&
          savePackage.binding.value !== null &&
          context.accountIdentity.value !== null &&
          savePackage.binding.value === context.accountIdentity.value
        ) {
          requirement = "undetermined";
          extensionTarget = "format-adapter";
          reasonCodes.push("OPERATION_ACCOUNT_RELATION_CONFLICT");
          missing.push("cross-account-source-evidence");
          nextAction = "Resolve the conflicting source/target account evidence and reassess the cross-account operation.";
        } else if (
          matchedAdapter?.capabilities.includes("account-neutral-exact-file-replacement") === true
        ) {
          requirement = "required";
          extensionTarget = "format-adapter";
          reasonCodes.push("FORMAT_ADAPTER_VALIDATED_EXACT_REPLACEMENT");
          satisfied.push("pc-format-validation", "checksum-verification", "scoped-account-neutral-replacement");
        } else if (recipe.binding.policy === "none" && recipe.binding.evidenceScope !== null) {
          requirement = "not_required";
          adapterAvailability = "not_applicable";
          reasonCodes.push("NO_BINDING_POLICY_VERIFIED");
          satisfied.push("account-binding-policy", "format-policy");
          nextAction = "Proceed to Compatibility Assessment and exact target mapping.";
        } else if (recipe.binding.policy === "directory-scoped" && recipe.binding.evidenceScope !== null) {
          requirement = "not_required";
          adapterAvailability = "not_applicable";
          reasonCodes.push("DIRECTORY_SCOPED_BINDING_VERIFIED");
          satisfied.push("external-account-binding", "format-policy");
          nextAction = "Proceed to Compatibility Assessment; keep the source bytes mapped only into the target account directory.";
        } else if (
          savePackage.binding.value !== null &&
          context.accountIdentity.value !== null &&
          savePackage.binding.kind === context.accountIdentity.kind &&
          savePackage.binding.value === context.accountIdentity.value
        ) {
          requirement = "not_required";
          adapterAvailability = "not_applicable";
          reasonCodes.push("ACCOUNT_BINDING_MATCHED");
          satisfied.push("account-binding-match");
          nextAction = "Proceed to Compatibility Assessment and exact target mapping.";
        } else if (
          savePackage.binding.value !== null &&
          context.accountIdentity.value !== null &&
          savePackage.binding.value !== context.accountIdentity.value
        ) {
          requirement = "required";
          extensionTarget = "format-adapter";
          reasonCodes.push("CROSS_ACCOUNT_TRANSFORM_REQUIRED");
          missing.push("account-rebind", "checksum-or-signature-update", "post-transform-verification");
        } else {
          requirement = "undetermined";
          extensionTarget = "format-adapter";
          adapterAvailability = adapterMatched ? "matched" : "not_applicable";
          reasonCodes.push("ACCOUNT_BINDING_UNKNOWN", "CHECKSUM_POLICY_UNKNOWN");
          missing.push("positive-account-binding-evidence", "checksum-policy-evidence");
          nextAction = "Obtain scoped format evidence or runtime evidence; absence of a visible account ID does not prove that generic replacement is safe.";
        }

        if (requirement === "required") {
          adapterAvailability = adapterMatched ? "matched" : "missing";
          matchedAdapterId = matchedAdapter?.adapterId ?? null;
          replacementPlanAllowed = adapterMatched;
          nextAction = adapterMatched
            ? `Use the matched ${matchedAdapter?.adapterId} Adapter workflow; generic direct replacement remains disallowed.`
            : "Use the generated Development Brief to implement and verify the missing format Adapter, then reassess.";
        } else if (["not_required", "recommended"].includes(requirement)) {
          if (input.intendedOperation === "import-container-slot" && input.allowWholeUnitFallback === true) {
            requirement = "recommended";
            reasonCodes.push("WHOLE_UNIT_FALLBACK_BROADENS_SCOPE");
            missing.push("fine-grained-container-slot-import");
            nextAction = "Generic whole-unit replacement is available only as an explicitly accepted broader-impact fallback; prefer a scoped Adapter for one-slot import.";
          }
          replacementPlanAllowed = true;
        }
      }
    }

    const withoutHash: Omit<AdapterRequirementAssessment, "assessmentHash"> = {
      schemaVersion: 2,
      assessmentId: randomUUID(),
      saveContextId: context.saveContextId,
      saveContextHash: context.contextHash,
      packageId: savePackage?.packageId ?? null,
      packageManifestHash: savePackage?.manifestHash ?? null,
      intendedOperation: input.intendedOperation,
      selection: {
        sourceSlot: input.sourceSlot ?? null,
        targetSlot: input.targetSlot ?? null,
        allowWholeUnitFallback: input.allowWholeUnitFallback ?? false,
      },
      requirement,
      adapterAvailability,
      extensionTarget,
      matchedAdapterId,
      evaluator: { assessorId: ASSESSOR_ID, assessorVersion: ASSESSOR_VERSION },
      scope: {
        gameCanonicalId: install.game.canonicalId,
        recipeId: recipe.recipeId,
        recipeHash: recipe.recipeHash,
        distributionKind: context.distributionKind,
        installContextId: install.installContextId,
        installContextHash: install.contextHash,
        accountKind: context.accountIdentity.kind,
        accountValue: context.accountIdentity.value,
        sourceKind: savePackage?.source.kind ?? null,
      },
      reasonCodes: [...new Set(reasonCodes)],
      genericCapabilitiesSatisfied: [...new Set(satisfied)],
      missingCapabilities: [...new Set(missing)],
      evidence,
      compatibilityAssessmentAllowed,
      replacementPlanAllowed,
      nextAction,
      assessedAt: new Date().toISOString(),
    };
    const assessment = await this.assessments.save(adapterRequirementAssessmentSchema.parse({
      ...withoutHash,
      assessmentHash: computeAdapterRequirementAssessmentHash(withoutHash),
    }));
    const developmentBrief = assessment.requirement === "required" && assessment.adapterAvailability === "missing"
      ? await this.createBrief(assessment, context, install.game, recipe, savePackage)
      : null;
    return { assessment, developmentBrief };
  }

  async get(assessmentId: string): Promise<Readonly<AdapterRequirementAssessment>> {
    return await this.assessments.get(assessmentId);
  }

  assertCurrent(assessment: Readonly<AdapterRequirementAssessment>): void {
    if (
      assessment.evaluator?.assessorId !== ASSESSOR_ID ||
      assessment.evaluator.assessorVersion !== ASSESSOR_VERSION
    ) {
      throw new NexusError("SAVE_ADAPTER_UNSUPPORTED", "Adapter Requirement Assessment predates the current deterministic ruleset; reassess the operation.");
    }
  }

  async getBrief(briefId: string): Promise<Readonly<AdapterDevelopmentBrief>> {
    return await this.briefs.get(briefId);
  }

  private async staticEvidence(
    context: Awaited<ReturnType<SaveContextV2Store["get"]>>,
    savePackage: Readonly<StandardSavePackageV2>,
  ): Promise<AdapterRequirementAssessment["evidence"]> {
    const unit = context.saveUnits.find((candidate) => candidate.unitId === savePackage.unitId);
    if (!unit) return [];
    const root = context.saveRoots.find((candidate) => candidate.rootId === unit.rootId);
    if (!root) return [];
    const result: AdapterRequirementAssessment["evidence"] = [];
    for (const source of savePackage.payload.files.slice(0, 20)) {
      const target = unit.materializedFiles.find(
        (candidate) => candidate.relativePath.toLocaleLowerCase("en-US") === source.relativePath.toLocaleLowerCase("en-US"),
      );
      if (!target) continue;
      const object = await this.packages.objectStore.get(source.objectId);
      const targetPath = joinManagedPath(root.absolutePath, target.relativePath);
      const [sourceBytes, targetBytes] = await Promise.all([
        readBounded(object.absolutePath),
        readBounded(targetPath).catch(() => null),
      ]);
      if (!sourceBytes || !targetBytes) {
        result.push({
          kind: "static-size",
          detail: `${source.relativePath}: source ${source.bytes} bytes; target was unavailable or exceeded the bounded static-analysis limit.`,
          confidence: "confirmed",
        });
        continue;
      }
      let prefix = 0;
      const comparable = Math.min(sourceBytes.length, targetBytes.length);
      while (prefix < comparable && sourceBytes[prefix] === targetBytes[prefix]) prefix += 1;
      let suffix = 0;
      while (
        suffix < comparable - prefix &&
        sourceBytes[sourceBytes.length - 1 - suffix] === targetBytes[targetBytes.length - 1 - suffix]
      ) suffix += 1;
      result.push({
        kind: "static-structure",
        detail: `${source.relativePath}: source ${sourceBytes.length} bytes, target ${targetBytes.length} bytes, common prefix ${prefix} bytes, common suffix ${suffix} bytes; size or marker similarity is not compatibility proof.`,
        confidence: "confirmed",
      });
      if (
        sourceBytes.length >= 8 && targetBytes.length >= 8 &&
        sourceBytes.readUInt32LE(4) === sourceBytes.length &&
        targetBytes.readUInt32LE(4) === targetBytes.length
      ) {
        result.push({
          kind: "static-length-field",
          detail: `${source.relativePath}: both samples encode their exact file length as UInt32LE at offset 4; checksum or account semantics remain unknown.`,
          confidence: "confirmed",
        });
      }
      const pathNumericTokens = source.sourcePath.split("/").filter((segment) => /^\d{17}$/.test(segment));
      const candidateValues = [savePackage.binding.value, context.accountIdentity.value, ...pathNumericTokens]
        .filter((value): value is string => value !== null);
      if (candidateValues.length > 0) {
        const found = candidateValues.some((value) => accountEncodings(value).some(
          (encoding) => findByteSequence(sourceBytes, encoding) || findByteSequence(targetBytes, encoding),
        ));
        result.push({
          kind: "account-marker-scan",
          detail: found
            ? `${source.relativePath}: a scoped account/path candidate value was found in a common text/integer encoding; a trusted Adapter must determine its semantics.`
            : `${source.relativePath}: scoped account/path candidate values were not found in common ASCII, UTF-16LE, or UInt64LE encodings; this does not prove absence of binding.`,
          confidence: "confirmed",
        });
      }
    }
    return result;
  }

  private async validateAdapterScope(
    context: Awaited<ReturnType<SaveContextV2Store["get"]>>,
    savePackage: Readonly<StandardSavePackageV2>,
    adapter: Readonly<FormatAdapterDescriptor>,
  ): Promise<{ valid: boolean; evidence: AdapterRequirementAssessment["evidence"] }> {
    if (!adapter.validateBytes) return { valid: true, evidence: [] };
    const unit = context.saveUnits.find((candidate) => candidate.unitId === savePackage.unitId);
    const root = unit ? context.saveRoots.find((candidate) => candidate.rootId === unit.rootId) : null;
    if (!unit || !root) return { valid: false, evidence: [] };
    let valid = true;
    const evidence: AdapterRequirementAssessment["evidence"] = [];
    for (const source of savePackage.payload.files) {
      const object = await this.packages.objectStore.get(source.objectId);
      const sourceBytes = await readBounded(object.absolutePath);
      const sourceResult = sourceBytes ? adapter.validateBytes(sourceBytes) : { valid: false, detail: "Source fixture exceeds the bounded analysis scope." };
      valid &&= sourceResult.valid;
      evidence.push({
        kind: "adapter-format-validation",
        detail: `${source.relativePath}: source ${sourceResult.detail}`,
        confidence: "confirmed",
      });
    }
    for (const target of unit.materializedFiles) {
      const targetBytes = await readBounded(joinManagedPath(root.absolutePath, target.relativePath)).catch(() => null);
      const targetResult = targetBytes ? adapter.validateBytes(targetBytes) : { valid: false, detail: "Target fixture is unavailable or exceeds the bounded analysis scope." };
      valid &&= targetResult.valid;
      evidence.push({
        kind: "adapter-format-validation",
        detail: `${target.relativePath}: target ${targetResult.detail}`,
        confidence: "confirmed",
      });
    }
    return { valid, evidence };
  }

  private async createBrief(
    assessment: Readonly<AdapterRequirementAssessment>,
    context: Awaited<ReturnType<SaveContextV2Store["get"]>>,
    game: { canonicalId: string; displayName: string },
    recipe: ReturnType<GameSaveRecipeRegistryV2["findById"]> & {},
    savePackage: Readonly<StandardSavePackageV2> | null,
  ): Promise<Readonly<AdapterDevelopmentBrief>> {
    const fixtureReferences: AdapterDevelopmentBrief["fixtureReferences"] = [];
    if (savePackage) {
      for (const file of savePackage.payload.files.slice(0, 25)) {
        const object = await this.packages.objectStore.get(file.objectId);
        fixtureReferences.push({ role: "source", absolutePath: object.absolutePath, sha256: file.sha256 });
      }
    }
    for (const unit of context.saveUnits) {
      const root = context.saveRoots.find((candidate) => candidate.rootId === unit.rootId);
      if (!root) continue;
      for (const file of unit.materializedFiles.slice(0, 25)) {
        const absolutePath = joinManagedPath(root.absolutePath, file.relativePath);
        const hash = await sha256File(absolutePath).catch(() => null);
        if (hash) fixtureReferences.push({ role: "target", absolutePath, sha256: hash });
      }
    }
    const withoutHash: Omit<AdapterDevelopmentBrief, "briefHash"> = {
      schemaVersion: 2,
      briefId: randomUUID(),
      assessmentId: assessment.assessmentId,
      assessmentHash: assessment.assessmentHash,
      game: { canonicalId: game.canonicalId, displayName: game.displayName },
      distributionKind: context.distributionKind,
      recipe: { recipeId: recipe.recipeId, recipeVersion: recipe.recipeVersion, recipeHash: recipe.recipeHash },
      target: { saveContextId: context.saveContextId, saveContextHash: context.contextHash },
      source: savePackage ? { packageId: savePackage.packageId, packageManifestHash: savePackage.manifestHash } : null,
      intendedOperation: assessment.intendedOperation,
      reasonCodes: assessment.reasonCodes,
      requiredCapabilities: assessment.missingCapabilities,
      knownEvidence: assessment.evidence.map((item) => `${item.kind}: ${item.detail}`),
      unknowns: assessment.missingCapabilities.map((item) => `The ${item} capability or evidence is not yet established.`),
      fixtureReferences: fixtureReferences.slice(0, 50),
      acceptanceRequirements: [
        "Parse every supported source and target without modifying the fixture bytes.",
        "Transform only the intended account, slot, version, or checksum fields and prove all other protected bytes unchanged.",
        "Reject unsupported build, format, truncated input, ambiguous account binding, and invalid checksum/signature states.",
        "Cover backup/rescue failure, staging failure, post-state mismatch, and rollback through fault-injection tests.",
        "Complete offline runtime validation and restore the verified original baseline after acceptance.",
      ],
      createdAt: new Date().toISOString(),
    };
    return await this.briefs.save(adapterDevelopmentBriefSchema.parse({
      ...withoutHash,
      briefHash: computeAdapterDevelopmentBriefHash(withoutHash),
    }));
  }
}
