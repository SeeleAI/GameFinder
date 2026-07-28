import { z } from "zod/v4";

import {
  archiveIdentitySchema,
  detectedLoaderSchema,
  installOperationSchema,
  packageUnitSchema,
  pathStateSchema,
} from "../contracts.js";
import { sha256CanonicalJson } from "../content-hash.js";

export const INSTALL_CONTRACT_V2_VERSION = 2 as const;

const schemaVersion = z.literal(INSTALL_CONTRACT_V2_VERSION);
const identifier = z.string().trim().min(1).max(200);
const absolutePath = z.string().trim().min(3).max(32_768);
const relativePath = z.string().trim().min(1).max(1_024);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/);
const boundedText = z.string().trim().min(1).max(2_000);
const operatingSystemSchema = z.enum(["win32", "linux", "darwin"]);

export const methodStateSchema = z.enum([
  "draft",
  "session_approved",
  "local_verified",
  "promoted",
  "quarantined",
  "deprecated",
]);

export const evidenceReferenceSchema = z.object({
  evidenceId: z.string().uuid(),
  kind: z.enum([
    "archive_manifest",
    "archive_readme",
    "archive_inventory",
    "nexus_metadata",
    "nexus_requirement",
    "author_documentation",
    "official_documentation",
    "game_instance",
    "loader_probe",
    "installation_record",
    "user_confirmation",
    "community_documentation",
  ]),
  uri: z.string().trim().min(1).max(4_096),
  capturedAt: timestamp,
  contentSha256: sha256,
  summary: boundedText,
});

export const evidencePackSchema = z.object({
  schemaVersion,
  evidencePackId: z.string().uuid(),
  evidencePackHash: sha256,
  createdAt: timestamp,
  source: z.object({
    archive: archiveIdentitySchema,
    receiptPath: absolutePath,
    nexus: z
      .object({
        domainName: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
        modId: z.number().int().positive(),
        fileId: z.number().int().positive(),
        canonicalModUrl: z.string().url(),
      })
      .nullable(),
    bundle: z
      .object({
        bundleId: z.string().uuid(),
        bundlePath: absolutePath,
        bundleHash: sha256,
        nodeId: identifier,
        installOrderIndex: z.number().int().nonnegative(),
      })
      .nullable(),
  }),
  archive: z.object({
    inventoryHash: sha256,
    entryCount: z.number().int().nonnegative(),
    entries: z
      .array(
        z.object({
          relativePath,
          kind: z.enum(["file", "directory"]),
          bytes: z.number().int().nonnegative().nullable(),
          sha256: sha256.nullable(),
        }),
      )
      .max(100_000),
  }),
  packageUnits: z.array(packageUnitSchema).max(500),
  dependencies: z
    .array(
      z.object({
        nodeId: identifier,
        kind: z.enum([
          "nexus_mod",
          "loader_runtime",
          "manual_requirement",
          "external_requirement",
        ]),
        required: z.boolean(),
        satisfied: z.boolean(),
        evidence: z.array(boundedText).max(50),
      }),
    )
    .max(500),
  gameContextBinding: z
    .object({
      gameContextId: z.string().uuid(),
      gameContextHash: sha256,
    })
    .nullable(),
  evidence: z.array(evidenceReferenceSchema).max(1_000),
});

export const scopedPathSchema = z.object({
  scope: z.enum(["game_root", "manager_root", "absolute_observed"]),
  path: z.string().trim().min(1).max(32_768),
  evidenceIds: z.array(z.string().uuid()).max(100),
});

export const dynamicGameContextSchema = z.object({
  schemaVersion,
  gameContextId: z.string().uuid(),
  gameContextHash: sha256,
  state: z.enum(["observed", "session_approved", "local_verified", "built_in"]),
  createdAt: timestamp,
  verifiedAt: timestamp,
  game: z.object({
    gameId: identifier,
    name: identifier,
    nexusDomainName: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{0,99}$/)
      .nullable(),
    version: z.string().trim().min(1).max(100).nullable(),
  }),
  instance: z.object({
    gameRoot: absolutePath,
    platform: z.enum(["steam", "gog", "epic", "xbox", "manual", "unknown"]),
    platformAppId: z.string().trim().min(1).max(100).nullable(),
    operatingSystem: operatingSystemSchema,
    anchorFingerprints: z.array(sha256).max(100),
  }),
  pathPolicy: z.object({
    writableRoots: z.array(scopedPathSchema).max(100),
    protectedRoots: z.array(scopedPathSchema).max(100),
    liveModRoots: z.array(scopedPathSchema).max(100),
    managedStateRoots: z.array(scopedPathSchema).max(20),
    observableRoots: z.array(scopedPathSchema).max(100),
    processSideEffectRoots: z.array(scopedPathSchema).max(100),
  }),
  detectedLoaders: z.array(detectedLoaderSchema).max(50),
  processes: z.object({
    knownProcessNames: z.array(z.string().trim().min(1).max(260)).max(100),
    lockSensitiveProcessNames: z
      .array(z.string().trim().min(1).max(260))
      .max(100),
  }),
  definitionBinding: z
    .object({
      definitionId: identifier,
      definitionRevision: z.number().int().positive(),
      definitionHash: sha256,
    })
    .nullable(),
  legacyProfileBinding: z
    .object({
      profileId: identifier,
      profileVersion: identifier,
    })
    .nullable(),
  evidence: z.array(evidenceReferenceSchema).max(1_000),
});

export const gameDefinitionV2Schema = z.object({
  schemaVersion,
  definitionId: identifier,
  revision: z.number().int().positive(),
  definitionHash: sha256,
  origin: z.enum(["built_in", "local_verified", "v1_compat"]),
  game: z.object({
    gameId: identifier,
    name: identifier,
    nexusDomainName: z.string().trim().min(1).max(100).nullable(),
  }),
  supportedOperatingSystems: z.array(operatingSystemSchema).min(1).max(3),
  discovery: z.object({
    executableAnchors: z.array(relativePath).max(100),
    platformAppIds: z.array(z.string().trim().min(1).max(100)).max(100),
  }),
  pathPolicyTemplate: z.object({
    writableRoots: z.array(relativePath).max(100),
    protectedRoots: z.array(relativePath).max(100),
    liveModRoots: z.array(relativePath).max(100),
  }),
  loaders: z
    .array(
      z.object({
        loaderId: identifier,
        detectionPaths: z.array(relativePath).max(100),
        modRoots: z.array(relativePath).max(100),
        logLocations: z.array(z.string().trim().min(1).max(1_024)).max(100),
      }),
    )
    .max(50),
  legacyProfileBinding: z
    .object({
      profileId: identifier,
      profileVersion: identifier,
    })
    .nullable(),
});

export const methodSignalSchema = z.object({
  signalId: identifier,
  kind: z.enum([
    "package_type",
    "path_exists",
    "path_pattern",
    "file_name",
    "manifest_field",
    "source_identity",
    "loader_state",
    "game_identity",
    "archive_layout",
  ]),
  subject: z.string().trim().min(1).max(1_024),
  operator: z.enum(["equals", "contains", "matches", "exists", "not_exists"]),
  expected: z.string().max(2_000).nullable(),
  required: z.boolean(),
});

export const methodCheckSchema = z.object({
  checkId: identifier,
  kind: z.enum([
    "path_exists",
    "path_absent",
    "file_hash",
    "tree_hash",
    "manifest_field",
    "loader_detected",
    "process_not_running",
    "process_exit",
    "version_constraint",
    "log_contains",
  ]),
  subject: z.string().trim().min(1).max(2_000),
  expected: z.string().max(2_000).nullable(),
  required: z.boolean(),
  evidenceIds: z.array(z.string().uuid()).max(100),
});

const methodFileOperationTemplateSchema = z.object({
  templateId: identifier,
  kind: z.enum([
    "ensure_directory",
    "install_new_file",
    "replace_file",
    "install_tree",
    "replace_managed_tree",
    "remove_empty_directory",
  ]),
  sourceTemplate: z.string().trim().min(1).max(1_024).nullable(),
  targetTemplate: z.string().trim().min(1).max(1_024),
  ownershipMode: z
    .enum(["installed_file_set", "exclusive_tree", "layered_path"])
    .nullable(),
});

const methodInstallerOperationTemplateSchema = z.object({
  templateId: identifier,
  kind: z.literal("run_bundled_installer"),
  entryTemplate: z.string().trim().min(1).max(1_024),
  runtime: z.enum(["native", "dotnet", "fixed-script-runner"]),
  terminalMode: z
    .enum(["redirected_stdio", "pseudoterminal"])
    .optional(),
  argumentTemplates: z.array(z.string().max(2_000)).max(100),
  workingDirectoryTemplate: z.string().trim().min(1).max(1_024),
  declaredWriteRootTemplates: z
    .array(z.string().trim().min(1).max(1_024))
    .max(100),
  timeoutMs: z.number().int().min(1_000).max(3_600_000),
});

export const methodOperationTemplateSchema = z.discriminatedUnion("kind", [
  methodFileOperationTemplateSchema,
  methodInstallerOperationTemplateSchema,
]);

export const installationMethodSchema = z.object({
  schemaVersion,
  methodId: z.string().uuid(),
  revision: z.number().int().positive(),
  methodHash: sha256,
  state: methodStateSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
  name: identifier,
  scope: z.object({
    operatingSystems: z.array(operatingSystemSchema).min(1).max(3),
    gameSelectors: z.array(methodSignalSchema).max(100),
    loaderSelectors: z.array(methodSignalSchema).max(100),
    sourceSelectors: z.array(methodSignalSchema).max(100),
    packageSignals: z.array(methodSignalSchema).max(500),
    negativeSignals: z.array(methodSignalSchema).max(500),
  }),
  resolution: z.object({
    packageRootRules: z.array(boundedText).max(100),
    componentSelectionRules: z.array(boundedText).max(100),
    targetMappings: z
      .array(
        z.object({
          mappingId: identifier,
          sourceTemplate: z.string().trim().min(1).max(1_024),
          targetTemplate: z.string().trim().min(1).max(1_024),
        }),
      )
      .max(500),
  }),
  operationTemplates: z.array(methodOperationTemplateSchema).min(1).max(10_000),
  preconditions: z.array(methodCheckSchema).max(1_000),
  verificationTemplate: z.object({
    staticChecks: z.array(methodCheckSchema).max(1_000),
    runtimeChecks: z.array(methodCheckSchema).max(1_000),
    dependentMinimumLevel: z.enum([
      "material_verified",
      "plan_validated",
      "transaction_committed",
      "static_verified",
      "runtime_verified",
    ]),
  }),
  reversibilityRequirements: z
    .array(
      z.object({
        operationKind: z.enum([
          "ensure_directory",
          "install_new_file",
          "replace_file",
          "install_tree",
          "replace_managed_tree",
          "remove_empty_directory",
          "run_bundled_installer",
        ]),
        level: z.enum(["full", "bounded", "manual_recovery"]),
        requirement: boundedText,
      }),
    )
    .max(100),
  provenance: z.object({
    origin: z.enum(["agent_learned", "built_in", "imported"]),
    evidenceRefs: z.array(z.string().uuid()).max(1_000),
    derivedFromInstallationIds: z.array(z.string().uuid()).max(1_000),
    legacyAdapterBinding: z
      .object({
        adapterId: identifier,
        adapterVersion: identifier,
      })
      .nullable(),
  }),
  confidence: z.object({
    deterministicSignals: z.array(identifier).max(500),
    successfulApplications: z.number().int().nonnegative(),
    failedApplications: z.number().int().nonnegative(),
    lastVerifiedAt: timestamp.nullable(),
  }),
});

const proposalFileOperationSchema = z.object({
  operationId: z.string().uuid(),
  kind: z.enum([
    "ensure_directory",
    "install_new_file",
    "replace_file",
    "install_tree",
    "replace_managed_tree",
    "remove_empty_directory",
  ]),
  sourceRelativePath: relativePath.nullable(),
  targetRelativePath: relativePath,
  ownershipMode: z
    .enum(["installed_file_set", "exclusive_tree", "layered_path"])
    .nullable(),
});

export const bundledInstallerOperationSchema = z.object({
  operationId: z.string().uuid(),
  kind: z.literal("run_bundled_installer"),
  entry: z.object({
    source: z.literal("verified_staging"),
    relativePath,
    runtime: z.enum(["native", "dotnet", "fixed-script-runner"]),
    sha256,
  }),
  terminalMode: z
    .enum(["redirected_stdio", "pseudoterminal"])
    .optional(),
  arguments: z.array(z.string().max(2_000)).max(100),
  workingDirectory: relativePath,
  environmentPolicy: z.literal("minimal"),
  timeoutMs: z.number().int().min(1_000).max(3_600_000),
  allowedExitCodes: z.array(z.number().int()).min(1).max(100),
  declaredWriteRoots: z.array(scopedPathSchema).min(1).max(100),
  preStateSnapshots: z
    .array(
      z.object({
        root: scopedPathSchema,
        expectedPreState: pathStateSchema,
      }),
    )
    .max(100),
  postConditions: z.array(methodCheckSchema).min(1).max(1_000),
  reversibilityLevel: z.enum(["full", "bounded", "manual_recovery"]),
});

export const proposalOperationSchema = z.union([
  proposalFileOperationSchema,
  bundledInstallerOperationSchema.omit({
    preStateSnapshots: true,
  }),
]);

export const installOperationV2Schema = z.union([
  installOperationSchema,
  bundledInstallerOperationSchema,
]);

export const proposalStrategyBindingSchema = z.object({
  origin: z.enum(["built_in_method", "learned_method", "agent_proposal"]),
  methodId: z.string().uuid().nullable(),
  methodRevision: z.number().int().positive().nullable(),
  methodHash: sha256.nullable(),
  legacyAdapterBinding: z
    .object({
      adapterId: identifier,
      adapterVersion: identifier,
    })
    .nullable(),
});

export const installProposalSchema = z.object({
  schemaVersion,
  proposalId: z.string().uuid(),
  proposalHash: sha256,
  createdAt: timestamp,
  evidenceBinding: z.object({
    evidencePackId: z.string().uuid(),
    evidencePackHash: sha256,
  }),
  gameBinding: z.object({
    gameContextId: z.string().uuid(),
    gameContextHash: sha256,
  }),
  strategyBinding: proposalStrategyBindingSchema,
  selection: z.object({
    packageUnitId: identifier,
    packageRoot: relativePath,
    selectedComponents: z.array(identifier).max(500),
  }),
  operations: z.array(proposalOperationSchema).min(1).max(100_000),
  preconditions: z.array(methodCheckSchema).max(1_000),
  verificationRequirements: z.array(methodCheckSchema).max(2_000),
  unresolvedChoices: z
    .array(
      z.object({
        choiceId: identifier,
        question: boundedText,
        options: z.array(identifier).min(2).max(100),
      }),
    )
    .max(100),
  risk: z.object({
    level: z.enum(["low", "medium", "high"]),
    reasons: z.array(boundedText).max(100),
  }),
});

export const installProposalDraftSchema = installProposalSchema.omit({
  schemaVersion: true,
  proposalId: true,
  proposalHash: true,
  createdAt: true,
  evidenceBinding: true,
  gameBinding: true,
});

export const installPlanV2Schema = z.object({
  schemaVersion,
  planId: z.string().uuid(),
  planHash: sha256,
  status: z.enum([
    "planned",
    "stale",
    "applying",
    "committed",
    "failed",
    "canceled",
  ]),
  createdAt: timestamp,
  expiresAt: timestamp,
  source: z.object({
    archive: archiveIdentitySchema,
    receiptPath: absolutePath,
    bundleId: z.string().uuid().nullable(),
    bundleNodeId: identifier.nullable(),
  }),
  evidenceBinding: z.object({
    evidencePackId: z.string().uuid(),
    evidencePackHash: sha256,
  }),
  gameBinding: z.object({
    gameContextId: z.string().uuid(),
    gameContextHash: sha256,
    gameRoot: absolutePath,
  }),
  strategyBinding: proposalStrategyBindingSchema.extend({
    proposalId: z.string().uuid(),
    proposalHash: sha256,
  }),
  selection: z.object({
    packageUnitId: identifier,
    packageRoot: relativePath,
    selectedComponents: z.array(identifier).max(500),
  }),
  operations: z.array(installOperationV2Schema).min(1).max(100_000),
  conflicts: z
    .array(
      z.object({
        target: z.string().trim().min(1).max(32_768),
        kind: identifier,
        blocking: z.boolean(),
        message: boundedText,
      }),
    )
    .max(100_000),
  preconditions: z.array(methodCheckSchema).max(1_000),
  verificationRequirements: z.array(methodCheckSchema).max(2_000),
  reversibility: z.object({
    level: z.enum(["full", "bounded", "manual_recovery"]),
    backupRequirements: z.array(boundedText).max(1_000),
  }),
  risk: z.object({
    level: z.enum(["low", "medium", "high"]),
    reasons: z.array(boundedText).max(100),
  }),
  approval: z.object({
    requiresExplicitConfirmation: z.literal(true),
    approvalDigest: sha256,
  }),
  preconditionStateHash: sha256,
});

export const installerExecutionContextSchema = z.object({
  schemaVersion,
  planId: z.string().uuid(),
  planHash: sha256,
  stagingId: z.string().uuid(),
  stagingRoot: absolutePath,
  stagingTreeHash: sha256,
  createdAt: timestamp,
});

export const installerInstallationRecordSchema = z.object({
  schemaVersion,
  installationId: z.string().uuid(),
  transactionId: z.string().uuid(),
  planId: z.string().uuid(),
  planHash: sha256,
  evidencePackId: z.string().uuid(),
  gameContextId: z.string().uuid(),
  gameRoot: absolutePath,
  bundle: z
    .object({
      bundleId: z.string().uuid(),
      nodeId: identifier,
    })
    .nullable(),
  state: z.enum([
    "installed",
    "rolled_back",
    "recovery_required",
    "failed_before_write",
  ]),
  process: z.object({
    runtime: z.enum(["native", "dotnet", "fixed-script-runner"]),
    terminalMode: z
      .enum(["redirected_stdio", "pseudoterminal"])
      .optional(),
    entryRelativePath: relativePath,
    entrySha256: sha256,
    arguments: z.array(z.string().max(2_000)).max(100),
    exitCode: z.number().int().nullable(),
    signal: z.string().max(100).nullable(),
    timedOut: z.boolean(),
    stdout: z.string().max(65_536),
    stderr: z.string().max(65_536),
  }),
  declaredRoots: z.array(
    z.object({
      root: scopedPathSchema,
      preState: pathStateSchema,
      postState: pathStateSchema,
      backupId: z.string().uuid().nullable(),
    }),
  ).max(100),
  observedChanges: z.array(relativePath).max(200_000),
  unexpectedChanges: z.array(relativePath).max(200_000),
  verification: z.object({
    static: z.enum(["passed", "failed", "not_run", "blocked"]),
    contextReprobed: z.boolean(),
  }),
  reversibilityLevel: z.enum(["full", "bounded", "manual_recovery"]),
  recovery: z.object({
    attempted: z.boolean(),
    completed: z.boolean(),
    message: z.string().max(2_000).nullable(),
  }),
  installedAt: timestamp,
});

export const methodOutcomeSchema = z
  .object({
    schemaVersion,
    outcomeId: z.string().uuid(),
    outcomeHash: sha256,
    methodId: z.string().uuid(),
    methodRevision: z.number().int().positive(),
    methodHash: sha256,
    evidencePackId: z.string().uuid(),
    evidencePackHash: sha256,
    gameContextId: z.string().uuid(),
    gameContextHash: sha256,
    installationId: z.string().uuid().nullable(),
    transactionId: z.string().uuid().nullable(),
    state: z.enum([
      "succeeded",
      "failed",
      "rolled_back",
      "recovery_required",
    ]),
    verification: z.object({
      static: z.enum(["passed", "failed", "not_run", "blocked"]),
      runtime: z.enum(["passed", "failed", "not_run", "blocked"]),
    }),
    operationDeviations: z.array(boundedText).max(1_000),
    failureAttribution: z
      .enum(["method", "environment", "version", "evidence", "user", "unknown"])
      .nullable(),
    createdAt: timestamp,
  })
  .superRefine((value, context) => {
    if (value.installationId === null && value.transactionId === null) {
      context.addIssue({
        code: "custom",
        message: "Method Outcome requires an installationId or transactionId.",
      });
    }
    if (value.state === "succeeded" && value.installationId === null) {
      context.addIssue({
        code: "custom",
        message: "A successful Method Outcome requires an installationId.",
      });
    }
  });

export const methodProviderCandidateSchema = z.object({
  schemaVersion,
  candidateId: z.string().uuid(),
  providerId: identifier,
  providerKind: z.enum(["built_in_method", "legacy_v1_adapter"]),
  state: z.enum([
    "verified_match",
    "candidate_match",
    "ambiguous",
    "evidence_stale",
    "no_match",
  ]),
  confidence: z.number().min(0).max(1),
  methodBinding: z
    .object({
      methodId: z.string().uuid(),
      revision: z.number().int().positive(),
      methodHash: sha256,
    })
    .nullable(),
  legacyAdapterBinding: z
    .object({
      adapterId: identifier,
      adapterVersion: identifier,
      profileId: identifier,
      profileVersion: identifier,
    })
    .nullable(),
  packageUnitIds: z.array(identifier).max(500),
  positiveSignals: z.array(boundedText).max(500),
  negativeSignals: z.array(boundedText).max(500),
  missingEvidence: z.array(boundedText).max(500),
  requiresUserChoice: z.boolean(),
});

function hashWithout<T extends object, K extends keyof T>(
  value: T,
  key: K,
): string {
  const copy = { ...value };
  delete copy[key];
  return sha256CanonicalJson(copy);
}

export function computeEvidencePackHash(
  value: Omit<EvidencePack, "evidencePackHash">,
): string {
  return sha256CanonicalJson(value);
}

export function computeDynamicGameContextHash(
  value: Omit<DynamicGameContext, "gameContextHash">,
): string {
  return sha256CanonicalJson(value);
}

export function computeGameDefinitionHash(
  value: Omit<GameDefinitionV2, "definitionHash">,
): string {
  return sha256CanonicalJson(value);
}

export function computeInstallationMethodHash(
  value: Omit<InstallationMethod, "methodHash">,
): string {
  return sha256CanonicalJson(value);
}

export function computeInstallProposalHash(
  value: Omit<InstallProposal, "proposalHash">,
): string {
  return sha256CanonicalJson(value);
}

export function computeInstallPlanV2Hash(
  value: Omit<InstallPlanV2, "planHash">,
): string {
  return sha256CanonicalJson(value);
}

export function computeMethodOutcomeHash(
  value: Omit<MethodOutcome, "outcomeHash">,
): string {
  return sha256CanonicalJson(value);
}

export function verifyInstallationMethodHash(method: InstallationMethod): boolean {
  return hashWithout(method, "methodHash") === method.methodHash;
}

export function verifyEvidencePackHash(evidence: EvidencePack): boolean {
  return hashWithout(evidence, "evidencePackHash") === evidence.evidencePackHash;
}

export function verifyDynamicGameContextHash(
  context: DynamicGameContext,
): boolean {
  return hashWithout(context, "gameContextHash") === context.gameContextHash;
}

export function verifyInstallProposalHash(proposal: InstallProposal): boolean {
  return hashWithout(proposal, "proposalHash") === proposal.proposalHash;
}

export function verifyInstallPlanV2Hash(plan: InstallPlanV2): boolean {
  return hashWithout(plan, "planHash") === plan.planHash;
}

export function verifyMethodOutcomeHash(outcome: MethodOutcome): boolean {
  return hashWithout(outcome, "outcomeHash") === outcome.outcomeHash;
}

export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;
export type EvidencePack = z.infer<typeof evidencePackSchema>;
export type ScopedPath = z.infer<typeof scopedPathSchema>;
export type DynamicGameContext = z.infer<typeof dynamicGameContextSchema>;
export type GameDefinitionV2 = z.infer<typeof gameDefinitionV2Schema>;
export type MethodState = z.infer<typeof methodStateSchema>;
export type MethodSignal = z.infer<typeof methodSignalSchema>;
export type MethodCheck = z.infer<typeof methodCheckSchema>;
export type MethodOperationTemplate = z.infer<
  typeof methodOperationTemplateSchema
>;
export type InstallationMethod = z.infer<typeof installationMethodSchema>;
export type InstallProposal = z.infer<typeof installProposalSchema>;
export type InstallProposalDraft = z.infer<typeof installProposalDraftSchema>;
export type BundledInstallerOperation = z.infer<
  typeof bundledInstallerOperationSchema
>;
export type InstallOperationV2 = z.infer<typeof installOperationV2Schema>;
export type InstallPlanV2 = z.infer<typeof installPlanV2Schema>;
export type InstallerExecutionContext = z.infer<
  typeof installerExecutionContextSchema
>;
export type InstallerInstallationRecord = z.infer<
  typeof installerInstallationRecordSchema
>;
export type MethodOutcome = z.infer<typeof methodOutcomeSchema>;
export type MethodProviderCandidate = z.infer<
  typeof methodProviderCandidateSchema
>;
