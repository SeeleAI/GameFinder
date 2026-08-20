import { z } from "zod/v4";

import { sha256CanonicalJson } from "../../install/content-hash.js";

export const SAVE_CONTRACT_V2 = 2 as const;

const identifier = z.string().trim().min(1).max(200);
const absolutePath = z.string().trim().min(3).max(32_767);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime({ offset: false });

function isSafeRecipePattern(value: string): boolean {
  if (value.includes("\\") || value.includes("\0") || value.includes("**")) return false;
  if (/^(?:[a-z]:|\/)/i.test(value)) return false;
  const segments = value.split("/");
  return segments.length > 0 && segments.every((segment) => (
    segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("?")
  ));
}

export const recipePathPatternSchema = z.string().trim().min(1).max(1_024)
  .refine(isSafeRecipePattern, "Recipe path patterns must be bounded portable relative paths.");

export const saveDistributionKindSchema = z.enum([
  "steam-library",
  "rune-steam-emulator",
  "manual-pe",
  "unknown",
]);

export const saveAccountKindSchema = z.enum([
  "steam_id64",
  "emulator_account_id",
  "platform_account_id",
  "opaque_directory_key",
  "unknown",
  "none",
]);

export type SaveDistributionKind = z.infer<typeof saveDistributionKindSchema>;
export type SaveAccountKind = z.infer<typeof saveAccountKindSchema>;

export const saveLayoutFamilyIdSchema = z.enum([
  "single-file",
  "slot-file-set",
  "container-with-companions",
  "directory-tree",
  "profile-plus-slots",
]);

export const recipeEvidenceSchema = z.object({
  kind: z.enum([
    "built-in",
    "imported-catalog",
    "local-probe",
    "executable-anchor",
    "pe-version",
    "filesystem",
    "runtime-verification",
  ]),
  detail: z.string().trim().min(1).max(2_000),
  source: z.string().trim().min(1).max(2_048).nullable(),
  observedAt: timestamp,
});

export const saveUnitRecipeSchema = z.object({
  unitId: identifier,
  layoutFamily: saveLayoutFamilyIdSchema,
  requiredAll: z.array(recipePathPatternSchema).max(100).default([]),
  requiredAnyOf: z.array(recipePathPatternSchema).max(100).default([]),
  companions: z.array(recipePathPatternSchema).max(100).default([]),
  auxiliary: z.array(recipePathPatternSchema).max(100).default([]),
  managedPatterns: z.array(recipePathPatternSchema).min(1).max(300),
  maximumMatches: z.number().int().min(1).max(10_000),
}).superRefine((unit, context) => {
  const managed = new Set(unit.managedPatterns.map((value) => value.toLowerCase()));
  for (const [field, patterns] of [
    ["requiredAll", unit.requiredAll],
    ["requiredAnyOf", unit.requiredAnyOf],
    ["companions", unit.companions],
    ["auxiliary", unit.auxiliary],
  ] as const) {
    for (const pattern of patterns) {
      if (!managed.has(pattern.toLowerCase())) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${pattern} must also be present in managedPatterns.`,
        });
      }
    }
  }
  if (unit.requiredAll.length === 0 && unit.requiredAnyOf.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["requiredAnyOf"],
      message: "A Save Unit must declare requiredAll or requiredAnyOf evidence.",
    });
  }
});

const recipeCoreSchema = z.object({
  schemaVersion: z.literal(SAVE_CONTRACT_V2),
  recipeId: identifier,
  recipeVersion: identifier,
  trust: z.enum(["built-in", "imported", "local_verified"]),
  game: z.object({
    canonicalId: identifier,
    displayName: identifier,
    aliases: z.array(identifier).max(100),
    platformAppIds: z.partialRecord(
      z.enum(["steam", "gog", "epic", "xbox", "manual"]),
      identifier,
    ),
  }),
  identity: z.object({
    executableAnchors: z.array(recipePathPatternSchema).min(1).max(50),
    productNames: z.array(identifier).min(1).max(50),
    fileDescriptions: z.array(identifier).max(50),
  }),
  installResolvers: z.array(identifier).min(1).max(20),
  locationStrategies: z.array(z.object({
    strategyId: identifier,
    parameters: z.record(z.string().trim().min(1).max(200), z.union([
      z.string().max(2_048),
      z.number().finite(),
      z.boolean(),
    ])),
  })).min(1).max(50),
  saveUnits: z.array(saveUnitRecipeSchema).min(1).max(50),
  binding: z.object({
    policy: z.enum(["none", "directory-scoped", "embedded", "unknown"]),
    evidenceScope: z.string().trim().min(1).max(2_000).nullable(),
  }),
  format: z.object({
    kind: z.enum(["opaque-files", "directory-tree", "game-specific-container", "unknown"]),
    adapterId: identifier.nullable(),
  }),
  runtime: z.object({
    processNames: z.array(identifier).max(50),
    lockSensitiveProcessNames: z.array(identifier).max(50),
  }),
  sources: z.object({
    nexusDomainName: identifier.nullable(),
    speedrunGameSlug: identifier.nullable(),
  }),
  evidence: z.array(recipeEvidenceSchema).min(1).max(200),
  createdAt: timestamp,
  verifiedAt: timestamp,
}).superRefine((recipe, context) => {
  const resolverIds = new Set(recipe.installResolvers);
  if (resolverIds.size !== recipe.installResolvers.length) {
    context.addIssue({ code: "custom", path: ["installResolvers"], message: "Resolver IDs must be unique." });
  }
  const unitIds = new Set(recipe.saveUnits.map((unit) => unit.unitId));
  if (unitIds.size !== recipe.saveUnits.length) {
    context.addIssue({ code: "custom", path: ["saveUnits"], message: "Save Unit IDs must be unique." });
  }
  if (recipe.binding.policy === "none" && recipe.binding.evidenceScope === null) {
    context.addIssue({
      code: "custom",
      path: ["binding", "evidenceScope"],
      message: "A no-binding policy requires positive scoped evidence.",
    });
  }
  if (recipe.format.adapterId !== null && recipe.format.kind !== "game-specific-container") {
    context.addIssue({
      code: "custom",
      path: ["format", "adapterId"],
      message: "A format Adapter is currently valid only for a game-specific container.",
    });
  }
});

export const gameSaveRecipeDefinitionSchema = recipeCoreSchema;
export const gameSaveRecipeSchema = recipeCoreSchema.safeExtend({
  recipeHash: sha256,
});

export type GameSaveRecipeDefinition = z.infer<typeof gameSaveRecipeDefinitionSchema>;
export type GameSaveRecipe = z.infer<typeof gameSaveRecipeSchema>;

export function materializeGameSaveRecipe(value: unknown): GameSaveRecipe {
  const definition = gameSaveRecipeDefinitionSchema.parse(value);
  return gameSaveRecipeSchema.parse({
    ...definition,
    recipeHash: sha256CanonicalJson(definition),
  });
}

export function verifyGameSaveRecipeHash(recipe: GameSaveRecipe): boolean {
  const { recipeHash, ...definition } = recipe;
  return recipeHash === sha256CanonicalJson(definition);
}

export const distributionResolverDescriptorSchema = z.object({
  schemaVersion: z.literal(SAVE_CONTRACT_V2),
  resolverId: identifier,
  resolverVersion: identifier,
  distributionKind: saveDistributionKindSchema,
  supportedPlatforms: z.array(z.literal("windows")).length(1),
  evidenceKinds: z.array(identifier).min(1).max(50),
});

export const saveLocationStrategyDescriptorSchema = z.object({
  schemaVersion: z.literal(SAVE_CONTRACT_V2),
  strategyId: identifier,
  strategyVersion: identifier,
  supportedVariables: z.array(z.enum([
    "USERPROFILE",
    "DOCUMENTS",
    "SAVED_GAMES",
    "APPDATA",
    "LOCALAPPDATA",
    "LOCALLOW",
    "PUBLIC_DOCUMENTS",
    "PLATFORM_APP_ID",
    "ACCOUNT_DIRECTORY",
    "PRODUCT_NAME",
    "PUBLISHER_NAME",
  ])).max(20),
  boundedProbeCapable: z.boolean(),
});

export const saveLayoutFamilyDescriptorSchema = z.object({
  schemaVersion: z.literal(SAVE_CONTRACT_V2),
  layoutFamily: saveLayoutFamilyIdSchema,
  layoutVersion: identifier,
  capabilities: z.array(z.enum([
    "fixed-files",
    "bounded-patterns",
    "slot-index-from-path",
    "wrapper-root",
    "directory-tree",
    "companions",
  ])).min(1).max(20),
});

export const installEvidenceV2Schema = z.object({
  kind: identifier,
  path: absolutePath.nullable(),
  detail: z.string().trim().min(1).max(2_000),
  observedAt: timestamp,
});

export const gameInstallContextV2Schema = z.object({
  schemaVersion: z.literal(SAVE_CONTRACT_V2),
  installContextId: z.string().uuid(),
  gameRoot: absolutePath,
  gameRootFingerprint: sha256,
  platform: z.literal("windows"),
  resolver: z.object({
    resolverId: identifier,
    resolverVersion: identifier,
  }),
  distributionKind: saveDistributionKindSchema,
  game: z.object({
    canonicalId: identifier,
    displayName: identifier,
    platformAppId: identifier.nullable(),
  }),
  recipe: z.object({
    recipeId: identifier,
    recipeVersion: identifier,
    recipeHash: sha256,
  }).nullable(),
  accountHints: z.array(z.object({
    kind: saveAccountKindSchema,
    value: z.string().trim().min(1).max(200).nullable(),
    confidence: z.enum(["confirmed", "probable", "unknown"]),
    evidence: z.string().trim().min(1).max(2_000),
  })).max(100),
  platformCandidateRoots: z.array(absolutePath).max(50),
  installEvidence: z.array(installEvidenceV2Schema).min(1).max(200),
  confidence: z.enum(["confirmed", "probable"]),
  createdAt: timestamp,
  contextHash: sha256,
});

export const materializedSaveFileSchema = z.object({
  relativePath: recipePathPatternSchema.refine((value) => !value.includes("*"), "Materialized paths cannot contain wildcards."),
  role: z.enum(["essential", "companion", "auxiliary"]),
  slot: z.object({
    kind: identifier,
    index: z.number().int().min(0).max(100_000).nullable(),
  }).nullable(),
});

export const saveContextV2Schema = z.object({
  schemaVersion: z.literal(SAVE_CONTRACT_V2),
  saveContextId: z.string().uuid(),
  installContextId: z.string().uuid(),
  installContextHash: sha256,
  recipe: z.object({
    recipeId: identifier,
    recipeVersion: identifier,
    recipeHash: sha256,
  }),
  resolverId: identifier,
  distributionKind: saveDistributionKindSchema,
  accountIdentity: z.object({
    kind: saveAccountKindSchema,
    value: z.string().trim().min(1).max(200).nullable(),
    evidence: z.string().trim().min(1).max(2_000),
  }),
  saveRoots: z.array(z.object({
    rootId: identifier,
    absolutePath,
    role: z.enum(["primary", "secondary", "variant"]),
    strategyId: identifier,
  })).min(1).max(20),
  saveUnits: z.array(z.object({
    unitId: identifier,
    rootId: identifier,
    layoutFamily: saveLayoutFamilyIdSchema,
    materializedFiles: z.array(materializedSaveFileSchema).min(1).max(10_000),
    materializationHash: sha256,
  })).min(1).max(50),
  binding: z.object({
    policy: z.enum(["none", "directory-scoped", "embedded", "unknown"]),
    evidenceScope: z.string().trim().min(1).max(2_000).nullable(),
  }),
  format: z.object({
    kind: z.enum(["opaque-files", "directory-tree", "game-specific-container", "unknown"]),
    adapterId: identifier.nullable(),
  }),
  verification: z.object({
    state: z.literal("confirmed"),
    method: z.enum(["recipe+filesystem", "differential-probe", "learned-recipe"]),
  }),
  evidence: z.array(installEvidenceV2Schema).min(1).max(200),
  createdAt: timestamp,
  contextHash: sha256,
});

export const standardSavePackageV2Schema = z.object({
  schemaVersion: z.literal(SAVE_CONTRACT_V2),
  packageId: identifier,
  recipe: z.object({
    recipeId: identifier,
    recipeVersion: identifier,
    recipeHash: sha256,
  }),
  game: z.object({
    canonicalId: identifier,
    displayName: identifier,
    platformAppId: identifier.nullable(),
  }),
  unitId: identifier,
  layoutFamily: saveLayoutFamilyIdSchema,
  source: z.object({
    kind: z.enum(["nexus", "speedrun", "manual"]),
    inspectionId: z.string().uuid(),
    pageUrl: z.string().url().nullable(),
    downloadReceiptId: z.string().uuid().nullable(),
    originalInputPath: absolutePath.nullable(),
    originalInputSha256: sha256,
  }),
  claims: z.object({
    progress: z.string().trim().max(4_000).nullable(),
    gameVersion: z.string().trim().max(200).nullable(),
    dlc: z.array(identifier).max(100),
    onlineSafety: z.enum(["author-claimed", "unknown"]),
  }),
  payload: z.object({
    files: z.array(z.object({
      sourcePath: recipePathPatternSchema.refine((value) => !value.includes("*")),
      relativePath: recipePathPatternSchema.refine((value) => !value.includes("*")),
      objectId: z.string().uuid(),
      bytes: z.number().int().nonnegative(),
      sha256,
      slot: z.object({
        kind: identifier,
        index: z.number().int().min(0).max(100_000).nullable(),
      }).nullable(),
    })).min(1).max(10_000),
    treeHash: sha256,
  }),
  binding: z.object({
    kind: saveAccountKindSchema,
    value: z.string().trim().min(1).max(200).nullable(),
    confidence: z.enum(["confirmed", "probable", "unknown"]),
    evidence: z.string().trim().min(1).max(2_000),
  }),
  format: z.object({
    kind: z.enum(["opaque-files", "directory-tree", "game-specific-container", "unknown"]),
    adapterHint: identifier.nullable(),
    evidence: z.array(z.string().trim().min(1).max(2_000)).max(100),
  }),
  safety: z.object({
    archiveInspection: z.enum(["passed", "not-applicable"]),
    containsExecutable: z.boolean(),
    warnings: z.array(z.string().trim().min(1).max(2_000)).max(100),
  }),
  createdAt: timestamp,
  manifestHash: sha256,
});

export const adapterRequirementSchema = z.enum([
  "not_required",
  "recommended",
  "required",
  "undetermined",
]);

export const saveCompatibilityAssessmentV2Schema = z.object({
  schemaVersion: z.literal(SAVE_CONTRACT_V2),
  assessmentId: z.string().uuid(),
  packageId: identifier,
  packageManifestHash: sha256,
  saveContextId: z.string().uuid(),
  saveContextHash: sha256,
  unitId: identifier,
  state: z.enum(["compatible_direct", "ambiguous", "unsupported", "conversion_required"]),
  accountRelation: z.enum(["same", "different", "none", "unknown"]),
  targetMappings: z.array(z.object({
    sourcePath: recipePathPatternSchema.refine((value) => !value.includes("*")),
    packageRelativePath: recipePathPatternSchema.refine((value) => !value.includes("*")),
    targetRelativePath: recipePathPatternSchema.refine((value) => !value.includes("*")),
  })).max(10_000),
  reasons: z.array(z.string().trim().min(1).max(2_000)).min(1).max(100),
  warnings: z.array(z.string().trim().min(1).max(2_000)).max(100),
  adapterRequirementAssessmentId: z.string().uuid().nullable().optional(),
  adapterRequirementAssessmentHash: sha256.nullable().optional(),
  replacementPlanAllowed: z.boolean(),
  assessedAt: timestamp,
  assessmentHash: sha256,
});

export const adapterRequirementAssessmentSchema = z.object({
  schemaVersion: z.literal(SAVE_CONTRACT_V2),
  assessmentId: z.string().uuid(),
  saveContextId: z.string().uuid(),
  saveContextHash: sha256,
  packageId: identifier.nullable(),
  packageManifestHash: sha256.nullable(),
  intendedOperation: z.enum([
    "backup",
    "restore-exact-bytes",
    "replace-whole-unit",
    "import-slot-file",
    "import-container-slot",
    "cross-account-import",
    "version-conversion",
  ]),
  selection: z.object({
    sourceSlot: z.number().int().min(0).max(100_000).nullable(),
    targetSlot: z.number().int().min(0).max(100_000).nullable(),
    allowWholeUnitFallback: z.boolean(),
  }).optional(),
  requirement: adapterRequirementSchema,
  adapterAvailability: z.enum(["matched", "missing", "not_applicable"]),
  extensionTarget: z.enum([
    "none",
    "distribution-resolver",
    "location-strategy",
    "layout-family",
    "game-recipe",
    "format-adapter",
  ]),
  matchedAdapterId: identifier.nullable(),
  evaluator: z.object({
    assessorId: identifier,
    assessorVersion: identifier,
  }).optional(),
  scope: z.object({
    gameCanonicalId: identifier,
    recipeId: identifier,
    recipeHash: sha256,
    distributionKind: saveDistributionKindSchema,
    installContextId: z.string().uuid(),
    installContextHash: sha256,
    accountKind: saveAccountKindSchema,
    accountValue: z.string().trim().min(1).max(200).nullable(),
    sourceKind: z.enum(["nexus", "speedrun", "manual"]).nullable(),
  }),
  reasonCodes: z.array(identifier).min(1).max(100),
  genericCapabilitiesSatisfied: z.array(identifier).max(100),
  missingCapabilities: z.array(identifier).max(100),
  evidence: z.array(z.object({
    kind: identifier,
    detail: z.string().trim().min(1).max(2_000),
    confidence: z.enum(["confirmed", "probable", "claim"]),
  })).min(1).max(200),
  compatibilityAssessmentAllowed: z.boolean(),
  replacementPlanAllowed: z.boolean(),
  nextAction: z.string().trim().min(1).max(2_000),
  assessedAt: timestamp,
  assessmentHash: sha256,
}).superRefine((assessment, context) => {
  if (assessment.requirement === "undetermined" && assessment.replacementPlanAllowed) {
    context.addIssue({ code: "custom", path: ["replacementPlanAllowed"], message: "Undetermined assessments cannot permit a Replacement Plan." });
  }
  if (assessment.requirement === "required" && assessment.adapterAvailability === "missing" && assessment.replacementPlanAllowed) {
    context.addIssue({ code: "custom", path: ["replacementPlanAllowed"], message: "A missing required Adapter cannot permit a Replacement Plan." });
  }
  if (assessment.extensionTarget === "format-adapter" && assessment.requirement === "not_required") {
    context.addIssue({ code: "custom", path: ["extensionTarget"], message: "A format Adapter cannot be the extension target when no Adapter is required." });
  }
});

export const adapterDevelopmentBriefSchema = z.object({
  schemaVersion: z.literal(SAVE_CONTRACT_V2),
  briefId: z.string().uuid(),
  assessmentId: z.string().uuid(),
  assessmentHash: sha256,
  game: z.object({ canonicalId: identifier, displayName: identifier }),
  distributionKind: saveDistributionKindSchema,
  recipe: z.object({
    recipeId: identifier,
    recipeVersion: identifier,
    recipeHash: sha256,
  }),
  target: z.object({ saveContextId: z.string().uuid(), saveContextHash: sha256 }),
  source: z.object({ packageId: identifier, packageManifestHash: sha256 }).nullable(),
  intendedOperation: adapterRequirementAssessmentSchema.shape.intendedOperation,
  reasonCodes: z.array(identifier).min(1).max(100),
  requiredCapabilities: z.array(identifier).min(1).max(100),
  knownEvidence: z.array(z.string().trim().min(1).max(2_000)).max(200),
  unknowns: z.array(z.string().trim().min(1).max(2_000)).max(200),
  fixtureReferences: z.array(z.object({
    role: z.enum(["source", "target", "baseline"]),
    absolutePath,
    sha256,
  })).max(50),
  acceptanceRequirements: z.array(z.string().trim().min(1).max(2_000)).min(1).max(100),
  createdAt: timestamp,
  briefHash: sha256,
});

export type GameInstallContextV2 = z.infer<typeof gameInstallContextV2Schema>;
export type SaveContextV2 = z.infer<typeof saveContextV2Schema>;
export type StandardSavePackageV2 = z.infer<typeof standardSavePackageV2Schema>;
export type AdapterRequirementAssessment = z.infer<typeof adapterRequirementAssessmentSchema>;
export type SaveCompatibilityAssessmentV2 = z.infer<typeof saveCompatibilityAssessmentV2Schema>;
export type AdapterDevelopmentBrief = z.infer<typeof adapterDevelopmentBriefSchema>;

export function computeGameInstallContextV2Hash(
  value: Omit<GameInstallContextV2, "contextHash">,
): string {
  return sha256CanonicalJson(value);
}

export function verifyGameInstallContextV2Hash(value: GameInstallContextV2): boolean {
  const { contextHash, ...payload } = value;
  return contextHash === computeGameInstallContextV2Hash(payload);
}

export function computeSaveContextV2Hash(
  value: Omit<SaveContextV2, "contextHash">,
): string {
  return sha256CanonicalJson(value);
}

export function verifySaveContextV2Hash(value: SaveContextV2): boolean {
  const { contextHash, ...payload } = value;
  return contextHash === computeSaveContextV2Hash(payload);
}

export function computeStandardSavePackageV2Hash(
  value: Omit<StandardSavePackageV2, "manifestHash">,
): string {
  return sha256CanonicalJson(value);
}

export function verifyStandardSavePackageV2Hash(value: StandardSavePackageV2): boolean {
  const { manifestHash, ...payload } = value;
  return manifestHash === computeStandardSavePackageV2Hash(payload);
}

export function computeAdapterRequirementAssessmentHash(
  value: Omit<AdapterRequirementAssessment, "assessmentHash">,
): string {
  return sha256CanonicalJson(value);
}

export function computeSaveCompatibilityAssessmentV2Hash(
  value: Omit<SaveCompatibilityAssessmentV2, "assessmentHash">,
): string {
  return sha256CanonicalJson(value);
}

export function verifySaveCompatibilityAssessmentV2Hash(value: SaveCompatibilityAssessmentV2): boolean {
  const { assessmentHash, ...payload } = value;
  return assessmentHash === computeSaveCompatibilityAssessmentV2Hash(payload);
}

export function verifyAdapterRequirementAssessmentHash(
  value: AdapterRequirementAssessment,
): boolean {
  const { assessmentHash, ...payload } = value;
  return assessmentHash === computeAdapterRequirementAssessmentHash(payload);
}

export function computeAdapterDevelopmentBriefHash(
  value: Omit<AdapterDevelopmentBrief, "briefHash">,
): string {
  return sha256CanonicalJson(value);
}

export function verifyAdapterDevelopmentBriefHash(value: AdapterDevelopmentBrief): boolean {
  const { briefHash, ...payload } = value;
  return briefHash === computeAdapterDevelopmentBriefHash(payload);
}
