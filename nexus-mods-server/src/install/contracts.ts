import { z } from "zod/v4";

import { planReviewSchema } from "../plan-review.js";

export const INSTALL_CONTRACT_VERSION = 1 as const;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

const schemaVersion = z.literal(INSTALL_CONTRACT_VERSION);
const identifier = z.string().trim().min(1).max(200);
const absolutePath = z.string().trim().min(3);
const relativePath = z.string().trim().min(1).max(1_024);
const sha256 = z.string().regex(SHA256_PATTERN);
const timestamp = z.string().regex(ISO_TIMESTAMP_PATTERN);

export const installOperationKindSchema = z.enum([
  "ensure_directory",
  "install_new_file",
  "replace_file",
  "install_tree",
  "replace_managed_tree",
  "remove_empty_directory"
]);

export const archiveIdentitySchema = z.object({
  absolutePath,
  fileName: z.string().trim().min(1).max(260),
  bytes: z.number().int().nonnegative(),
  sha256
});

export const packageIdentitySchema = z.object({
  uniqueId: identifier.nullable(),
  name: identifier.nullable(),
  version: z.string().trim().min(1).max(100).nullable()
});

export const packageDependencySchema = z.object({
  dependencyId: identifier,
  kind: z.enum(["required", "optional", "recommended", "incompatible", "external"]),
  versionConstraint: z.string().trim().min(1).max(200).nullable(),
  evidence: z.array(z.string().trim().min(1).max(500)).max(20)
});

export const packageUnitSchema = z.object({
  packageUnitId: identifier,
  packageType: z.enum([
    "self-contained-folder",
    "loader-plugin",
    "content-pack",
    "root-overlay",
    "script-package",
    "mod-manager-package",
    "fomod",
    "binary-patcher",
    "executable-installer",
    "unknown"
  ]),
  packageRoot: relativePath,
  identity: packageIdentitySchema,
  entryFiles: z.array(relativePath).max(100),
  dependencies: z.array(packageDependencySchema).max(200),
  positiveSignals: z.array(z.string().trim().min(1).max(500)).max(100),
  negativeSignals: z.array(z.string().trim().min(1).max(500)).max(100)
});

export const packageAmbiguitySchema = z.object({
  code: z.enum([
    "multiple-package-roots",
    "multiple-variants",
    "conflicting-identities",
    "unknown-package-type",
    "missing-entry-file",
    "other"
  ]),
  message: z.string().trim().min(1).max(1_000),
  packageUnitIds: z.array(identifier).max(100)
});

export const packageAnalysisSchema = z.object({
  schemaVersion,
  analysisId: z.string().uuid(),
  analysisHash: sha256,
  analyzerVersion: identifier,
  archive: archiveIdentitySchema,
  packages: z.array(packageUnitSchema).max(500),
  ambiguities: z.array(packageAmbiguitySchema).max(100),
  analyzedAt: timestamp
});

export const gameProfileSchema = z.object({
  schemaVersion,
  profileId: identifier,
  profileVersion: identifier,
  gameName: identifier,
  nexusDomainName: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
  supportedOperatingSystems: z
    .array(z.enum(["win32", "linux", "darwin"]))
    .min(1)
    .max(3),
  discovery: z.object({
    executableAnchors: z.array(relativePath).min(1).max(50),
    steamAppIds: z.array(z.number().int().positive()).max(20)
  }),
  filesystem: z.object({
    writableRoots: z.array(relativePath).min(1).max(100),
    protectedRoots: z.array(relativePath).max(100),
    liveModRoots: z.array(relativePath).max(100),
    stateLocationPolicy: z.enum(["local-app-data", "game-root-hidden"])
  }),
  loaders: z
    .array(
      z.object({
        loaderId: identifier,
        detectionPaths: z.array(relativePath).min(1).max(100),
        modRoots: z.array(relativePath).min(1).max(100),
        logLocations: z.array(z.string().trim().min(1).max(1_024)).max(100)
      })
    )
    .max(50),
  runtime: z.object({
    processNames: z.array(z.string().trim().min(1).max(260)).max(100),
    lockSensitiveProcessNames: z.array(z.string().trim().min(1).max(260)).max(100)
  })
});

export const detectedLoaderSchema = z.object({
  loaderId: identifier,
  state: z.enum(["detected", "not-detected", "ambiguous"]),
  version: z.string().trim().min(1).max(100).nullable(),
  absolutePath: absolutePath.nullable(),
  modRoots: z.array(absolutePath).max(100),
  evidence: z.array(z.string().trim().min(1).max(1_000)).max(100)
});

export const gameInstanceSchema = z.object({
  schemaVersion,
  instanceId: z.string().uuid(),
  profileId: identifier,
  profileVersion: identifier,
  gameRoot: absolutePath,
  platform: z.enum(["steam", "gog", "epic", "xbox", "manual", "unknown"]),
  platformAppId: z.string().trim().min(1).max(100).nullable(),
  gameVersion: z.string().trim().min(1).max(100).nullable(),
  anchorFingerprints: z.array(sha256).max(100),
  detectedLoaders: z.array(detectedLoaderSchema).max(50),
  verifiedAt: timestamp
});

export const pathStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }),
  z.object({
    kind: z.literal("file"),
    bytes: z.number().int().nonnegative(),
    sha256
  }),
  z.object({
    kind: z.literal("directory"),
    treeHash: sha256.nullable(),
    entries: z.number().int().nonnegative().nullable()
  })
]);

const operationBase = z.object({
  operationId: z.string().uuid(),
  targetRelativePath: relativePath,
  expectedPreState: pathStateSchema,
  expectedPostState: pathStateSchema
});

export const installOperationSchema = z.discriminatedUnion("kind", [
  operationBase.extend({
    kind: z.literal("ensure_directory")
  }),
  operationBase.extend({
    kind: z.literal("install_new_file"),
    sourceRelativePath: relativePath,
    sourceSha256: sha256
  }),
  operationBase.extend({
    kind: z.literal("replace_file"),
    sourceRelativePath: relativePath,
    sourceSha256: sha256
  }),
  operationBase.extend({
    kind: z.literal("install_tree"),
    sourceRelativePath: relativePath,
    sourceTreeHash: sha256,
    ownershipMode: z.enum(["installed_file_set", "exclusive_tree"])
  }),
  operationBase.extend({
    kind: z.literal("replace_managed_tree"),
    sourceRelativePath: relativePath,
    sourceTreeHash: sha256,
    previousOwnerInstallationId: z.string().uuid(),
    ownershipMode: z.enum(["installed_file_set", "exclusive_tree", "layered_path"])
  }),
  operationBase.extend({
    kind: z.literal("remove_empty_directory")
  })
]);

export const installConflictSchema = z.object({
  targetRelativePath: relativePath,
  kind: z.enum([
    "new_path",
    "same_content",
    "managed_same_mod",
    "managed_other_mod",
    "unmanaged_existing",
    "protected_path",
    "case_collision",
    "dirty_managed_path"
  ]),
  blocking: z.boolean(),
  message: z.string().trim().min(1).max(1_000)
});

export const installPlanSchema = z.object({
  schemaVersion,
  planId: z.string().uuid(),
  planHash: sha256,
  status: z.enum(["planned", "stale", "applying", "committed", "failed", "canceled"]),
  createdAt: timestamp,
  expiresAt: timestamp,
  archive: archiveIdentitySchema,
  analysisId: z.string().uuid(),
  analysisHash: sha256,
  gameInstanceId: z.string().uuid(),
  gameProfileId: identifier,
  gameProfileVersion: identifier,
  adapterId: identifier,
  adapterVersion: identifier,
  staging: z.object({
    stagingId: z.string().uuid(),
    packageRoot: relativePath,
    sourceTreeHash: sha256
  }),
  operations: z.array(installOperationSchema).min(1).max(100_000),
  conflicts: z.array(installConflictSchema).max(100_000),
  preconditionStateHash: sha256,
  review: planReviewSchema.optional()
});

export const transactionPhaseSchema = z.enum([
  "planned",
  "preflight",
  "locked",
  "staging",
  "backing_up",
  "applying",
  "static_verifying",
  "committed",
  "preflight_failed",
  "apply_failed",
  "verification_failed",
  "rolling_back",
  "rolled_back",
  "recovery_required",
  "uninstall_planned",
  "backing_up_current_dirty_state",
  "applying_inverse",
  "verifying_absence_or_restore",
  "uninstalled",
  "uninstall_failed",
  "rolling_back_uninstall",
  "installed_restored"
]);

export const transactionEntrySchema = z.object({
  sequence: z.number().int().nonnegative(),
  recordedAt: timestamp,
  phase: transactionPhaseSchema,
  operationId: z.string().uuid().nullable(),
  event: identifier,
  preState: pathStateSchema.nullable(),
  postState: pathStateSchema.nullable(),
  backupId: z.string().uuid().nullable(),
  message: z.string().trim().min(1).max(2_000)
});

export const transactionJournalSchema = z.object({
  schemaVersion,
  transactionId: z.string().uuid(),
  transactionKind: z.enum(["install", "update", "uninstall", "rollback"]),
  planId: z.string().uuid(),
  gameInstanceId: z.string().uuid(),
  state: transactionPhaseSchema,
  startedAt: timestamp,
  completedAt: timestamp.nullable(),
  entries: z.array(transactionEntrySchema).max(1_000_000)
});

export const backupObjectSchema = z.object({
  schemaVersion,
  backupId: z.string().uuid(),
  objectKind: z.enum(["file", "directory-tree"]),
  sha256,
  bytes: z.number().int().nonnegative(),
  absolutePath,
  createdAt: timestamp,
  referenceCount: z.number().int().nonnegative()
});

export const operationOutcomeSchema = z.object({
  operationId: z.string().uuid(),
  operationKind: installOperationKindSchema,
  targetRelativePath: relativePath,
  outcome: z.enum(["applied", "skipped_same_content", "failed", "rolled_back"]),
  preState: pathStateSchema,
  postState: pathStateSchema,
  ownershipMode: z
    .enum(["none", "installed_file_set", "exclusive_tree", "layered_path"])
    .nullable(),
  ownedFiles: z
    .array(
      z.object({
        relativePath,
        bytes: z.number().int().nonnegative(),
        sha256
      })
    )
    .max(100_000),
  ownedDirectories: z.array(relativePath).max(100_000),
  backupId: z.string().uuid().nullable(),
  previousOwnerInstallationId: z.string().uuid().nullable()
});

export const installationRecordSchema = z.object({
  schemaVersion,
  installationId: z.string().uuid(),
  revision: z.number().int().positive(),
  state: z.enum([
    "installed",
    "runtime_unverified",
    "runtime_verified",
    "runtime_failed",
    "dirty",
    "uninstalled",
    "uninstalled_with_retained_data"
  ]),
  transactionId: z.string().uuid(),
  sourcePlanId: z.string().uuid(),
  sourcePlanHash: sha256,
  gameInstanceId: z.string().uuid(),
  gameProfileId: identifier,
  gameProfileVersion: identifier,
  adapterId: identifier,
  adapterVersion: identifier,
  archive: archiveIdentitySchema,
  nexus: z.object({
    domainName: identifier,
    modId: z.number().int().positive(),
    fileId: z.number().int().positive(),
    receiptPath: absolutePath
  }),
  packageSummary: z.object({
    analysisHash: sha256,
    packageUnitId: identifier,
    packageRoot: relativePath,
    identity: packageIdentitySchema
  }),
  operationOutcomes: z.array(operationOutcomeSchema).max(100_000),
  staticVerification: z.enum(["passed", "failed", "not-run"]),
  runtimeVerification: z.enum(["passed", "failed", "not-run"]),
  installedAt: timestamp,
  updatedAt: timestamp,
  uninstallTransactionId: z.string().uuid().nullable()
});

export const inspectedPathSchema = z.object({
  targetRelativePath: relativePath,
  state: z.enum([
    "unchanged",
    "missing",
    "modified",
    "replaced_by_managed_layer",
    "unmanaged_extra",
    "protected"
  ]),
  expectedPostState: pathStateSchema.nullable(),
  actualState: pathStateSchema,
  currentOwnerInstallationId: z.string().uuid().nullable(),
  unmanagedFilePaths: z.array(relativePath).max(100_000).optional(),
  unmanagedDirectoryPaths: z.array(relativePath).max(100_000).optional()
});

export const currentStateInspectionSchema = z.object({
  schemaVersion,
  inspectionId: z.string().uuid(),
  installationId: z.string().uuid(),
  gameInstanceId: z.string().uuid(),
  stateHash: sha256,
  inspectedAt: timestamp,
  paths: z.array(inspectedPathSchema).max(100_000),
  blocking: z.boolean()
});

export const uninstallActionSchema = z.discriminatedUnion("kind", [
  z.object({
    actionId: z.string().uuid(),
    kind: z.literal("delete_owned_file"),
    targetRelativePath: relativePath,
    expectedCurrentState: pathStateSchema
  }),
  z.object({
    actionId: z.string().uuid(),
    kind: z.literal("remove_empty_directory"),
    targetRelativePath: relativePath
  }),
  z.object({
    actionId: z.string().uuid(),
    kind: z.literal("ensure_directory"),
    targetRelativePath: relativePath
  }),
  z.object({
    actionId: z.string().uuid(),
    kind: z.literal("restore_backup"),
    targetRelativePath: relativePath,
    backupId: z.string().uuid(),
    expectedCurrentState: pathStateSchema
  }),
  z.object({
    actionId: z.string().uuid(),
    kind: z.literal("restore_managed_tree"),
    targetRelativePath: relativePath,
    backupId: z.string().uuid(),
    expectedCurrentState: pathStateSchema
  })
]);

export const uninstallPlanSchema = z.object({
  schemaVersion,
  uninstallPlanId: z.string().uuid(),
  uninstallPlanHash: sha256,
  status: z.enum(["planned", "stale", "applying", "committed", "failed", "canceled"]),
  installationId: z.string().uuid(),
  installationRevision: z.number().int().positive(),
  inspectionId: z.string().uuid(),
  inspectionStateHash: sha256,
  gameInstanceId: z.string().uuid(),
  gameProfileId: identifier,
  gameProfileVersion: identifier,
  createdAt: timestamp,
  expiresAt: timestamp,
  actions: z.array(uninstallActionSchema).max(200_000),
  retainedPaths: z.array(relativePath).max(100_000),
  retainedFilePaths: z.array(relativePath).max(100_000).optional(),
  review: planReviewSchema.optional()
});

export type ArchiveIdentity = z.infer<typeof archiveIdentitySchema>;
export type PackageIdentity = z.infer<typeof packageIdentitySchema>;
export type PackageDependency = z.infer<typeof packageDependencySchema>;
export type PackageUnit = z.infer<typeof packageUnitSchema>;
export type PackageAmbiguity = z.infer<typeof packageAmbiguitySchema>;
export type PackageAnalysis = z.infer<typeof packageAnalysisSchema>;
export type GameProfile = z.infer<typeof gameProfileSchema>;
export type GameInstance = z.infer<typeof gameInstanceSchema>;
export type PathState = z.infer<typeof pathStateSchema>;
export type InstallOperation = z.infer<typeof installOperationSchema>;
export type InstallOperationKind = InstallOperation["kind"];
export type InstallConflict = z.infer<typeof installConflictSchema>;
export type InstallPlan = z.infer<typeof installPlanSchema>;
export type TransactionPhase = z.infer<typeof transactionPhaseSchema>;
export type TransactionEntry = z.infer<typeof transactionEntrySchema>;
export type TransactionJournal = z.infer<typeof transactionJournalSchema>;
export type BackupObject = z.infer<typeof backupObjectSchema>;
export type OperationOutcome = z.infer<typeof operationOutcomeSchema>;
export type InstallationRecord = z.infer<typeof installationRecordSchema>;
export type CurrentStateInspection = z.infer<typeof currentStateInspectionSchema>;
export type UninstallAction = z.infer<typeof uninstallActionSchema>;
export type UninstallPlan = z.infer<typeof uninstallPlanSchema>;
