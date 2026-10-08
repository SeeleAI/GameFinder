import { z } from "zod/v4";

import { sha256CanonicalJson } from "../install/content-hash.js";
import { planReviewSchema } from "../plan-review.js";

export const SAVE_CONTRACT_VERSION = 1 as const;
export const SAVE_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

const schemaVersion = z.literal(SAVE_CONTRACT_VERSION);
const identifier = z.string().trim().min(1).max(200);
const absolutePath = z.string().trim().min(3).max(32_767);
const relativePath = z.string().trim().min(1).max(1_024);
const sha256 = z.string().regex(SAVE_SHA256_PATTERN);
const md5 = z.string().regex(/^[a-f0-9]{32}$/);
const timestamp = z.string().regex(ISO_TIMESTAMP_PATTERN);

export const saveEvidenceSchema = z.object({
  kind: z.enum([
    "steam-appmanifest",
    "pe-version",
    "executable-anchor",
    "profile-rule",
    "filesystem",
    "differential-probe",
    "learned-profile",
  ]),
  path: absolutePath.nullable(),
  detail: z.string().trim().min(1).max(2_000),
  observedAt: timestamp,
});

export const gameIdentitySchema = z.object({
  canonicalId: identifier,
  displayName: identifier,
  storeAppId: identifier.nullable(),
});

export const gameInstallContextSchema = z.object({
  schemaVersion,
  installContextId: z.string().uuid(),
  gameRoot: absolutePath,
  platform: z.literal("windows"),
  store: z.enum(["steam", "manual", "unknown"]),
  game: gameIdentitySchema,
  storeMetadata: z.object({
    steam: z
      .object({
        appId: identifier,
        buildId: identifier.nullable(),
        lastOwner: z.string().regex(/^\d{17}$/).nullable(),
        installDir: identifier,
        manifestPath: absolutePath,
      })
      .nullable(),
  }),
  installEvidence: z.array(saveEvidenceSchema).min(1).max(100),
  confidence: z.enum(["confirmed", "probable"]),
  createdAt: timestamp,
  contextHash: sha256,
});

export const saveFileRoleSchema = z.enum([
  "essential",
  "companion",
  "auxiliary",
]);

export const saveUnitSchema = z.object({
  unitId: identifier,
  essential: z.array(relativePath).min(1).max(100),
  companions: z.array(relativePath).max(100),
  auxiliary: z.array(relativePath).max(100),
  managedPaths: z.array(relativePath).min(1).max(300),
});

export const saveRootSchema = z.object({
  rootId: identifier,
  absolutePath,
  role: z.enum(["primary", "secondary", "variant"]),
});

export const saveContextSchema = z.object({
  schemaVersion,
  saveContextId: z.string().uuid(),
  installContextId: z.string().uuid(),
  windowsUserSidHash: sha256.nullable(),
  windowsUserIdentityHash: sha256,
  profile: z.object({
    profileId: identifier,
    profileVersion: identifier,
    source: z.enum(["built-in", "learned"]),
  }),
  storeAccount: z
    .object({
      kind: z.enum(["steam_id64", "unknown"]),
      value: z.string().trim().min(1).max(200).nullable(),
    })
    .nullable(),
  saveRoots: z.array(saveRootSchema).min(1).max(20),
  saveUnits: z.array(saveUnitSchema).min(1).max(50),
  format: z.object({
    kind: z.enum([
      "single-file",
      "directory-tree",
      "game-specific-container",
      "unknown",
    ]),
    adapterId: identifier.nullable(),
  }),
  evidence: z.array(saveEvidenceSchema).min(1).max(200),
  verification: z.object({
    state: z.enum(["confirmed", "probable", "ambiguous", "not_found"]),
    method: z.enum([
      "profile+filesystem",
      "differential-probe",
      "learned-profile",
      "manual",
    ]),
  }),
  createdAt: timestamp,
  contextHash: sha256,
});

export const saveFileSnapshotSchema = z.object({
  relativePath,
  role: saveFileRoleSchema,
  backupObjectId: z.string().uuid(),
  bytes: z.number().int().nonnegative(),
  sha256,
  modifiedAt: timestamp,
  attributes: z.array(identifier).max(20),
});

export const saveBackupRecordSchema = z.object({
  schemaVersion,
  backupId: z.string().uuid(),
  saveContextId: z.string().uuid(),
  unitId: identifier,
  reason: z.enum([
    "manual",
    "pre_restore_rescue",
    "pre_replacement_rescue",
    "acceptance_baseline",
  ]),
  sourceRoot: absolutePath,
  files: z.array(saveFileSnapshotSchema).min(1).max(10_000),
  treeHash: sha256,
  sourcePreStateHash: sha256,
  sourcePostStateHash: sha256,
  profileId: identifier,
  profileVersion: identifier,
  adapterId: identifier.nullable(),
  createdAt: timestamp,
  integrity: z.literal("verified"),
  backupRecordHash: sha256,
});

export const standardSavePackageSchema = z.object({
  schemaVersion,
  packageId: identifier,
  game: gameIdentitySchema,
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
    root: relativePath,
    files: z
      .array(
        z.object({
          relativePath,
          objectId: z.string().uuid(),
          bytes: z.number().int().nonnegative(),
          sha256,
        }),
      )
      .min(1)
      .max(10_000),
    treeHash: sha256,
  }),
  binding: z.object({
    kind: z.enum([
      "steam_id64",
      "account_bound_unknown",
      "none",
      "unknown",
    ]),
    value: z.string().trim().min(1).max(200).nullable(),
  }),
  format: z.object({
    kind: z.enum([
      "single-file",
      "directory-tree",
      "game-specific-container",
      "unknown",
    ]),
    adapterHint: identifier.nullable(),
  }),
  safety: z.object({
    archiveInspection: z.enum(["passed", "not-applicable"]),
    containsExecutable: z.boolean(),
    warnings: z.array(z.string().trim().min(1).max(2_000)).max(100),
  }),
  createdAt: timestamp,
  manifestHash: sha256,
});

const saveSourceClaimsSchema = z.object({
  progress: z.string().trim().max(4_000).nullable(),
  gameVersion: z.string().trim().max(200).nullable(),
  dlc: z.array(identifier).max(100),
  onlineSafety: z.enum(["author-claimed", "unknown"]),
});

const nexusSaveSelectionSchema = z.object({
  kind: z.literal("nexus"),
  domainName: identifier,
  modId: z.number().int().positive(),
  fileId: z.number().int().positive(),
  fileName: identifier,
  fileVersion: z.string().trim().max(200),
  categoryName: identifier,
  sizeInBytes: z.number().int().nonnegative().nullable(),
  isPrimary: z.boolean(),
  contentPreviewLink: z.string().url().nullable(),
});

const speedrunSaveSelectionSchema = z.object({
  kind: z.literal("speedrun"),
  gameSlug: identifier,
  resourceUrl: z.string().url(),
  resourceId: identifier.nullable(),
  downloadUrl: z.string().url().nullable(),
});

export const saveSourceCandidateSchema = z.object({
  schemaVersion,
  candidateId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  stableKey: z.string().trim().min(1).max(1_000),
  source: z.enum(["nexus", "speedrun"]),
  game: gameIdentitySchema,
  title: identifier,
  summary: z.string().trim().max(20_000),
  author: z.string().trim().max(500).nullable(),
  manager: z.string().trim().max(500).nullable(),
  pageUrl: z.string().url(),
  status: z.enum(["available", "manual-handoff", "unavailable"]),
  claims: saveSourceClaimsSchema,
  metrics: z.object({
    totalDownloads: z.number().int().nonnegative().nullable(),
    uniqueDownloads: z.number().int().nonnegative().nullable(),
    endorsements: z.number().int().nonnegative().nullable(),
  }),
  updatedAt: timestamp.nullable(),
  selection: z.discriminatedUnion("kind", [
    nexusSaveSelectionSchema,
    speedrunSaveSelectionSchema,
  ]),
  rank: z.object({
    score: z.number().finite(),
    reasons: z.array(z.string().trim().min(1).max(2_000)).min(1).max(100),
  }),
  sourceMetadataHash: sha256,
  candidateHash: sha256,
});

export const saveSourceSnapshotSchema = z.object({
  schemaVersion,
  snapshotId: z.string().uuid(),
  source: z.enum(["nexus", "speedrun"]),
  game: gameIdentitySchema,
  pageUrl: z.string().url(),
  query: z.string().trim().max(500).nullable(),
  fetchedAt: timestamp,
  fetchMode: z.enum(["api", "html", "fixture"]),
  candidateIds: z.array(z.string().uuid()).max(500),
  sourceContentHash: sha256,
  previousSnapshotId: z.string().uuid().nullable(),
  drift: z.array(z.object({
    stableKey: z.string().trim().min(1).max(1_000),
    state: z.enum(["new", "unchanged", "changed", "removed"]),
    previousMetadataHash: sha256.nullable(),
    currentMetadataHash: sha256.nullable(),
  })).max(1_000),
  warnings: z.array(z.string().trim().min(1).max(2_000)).max(100),
  snapshotHash: sha256,
});

export const saveDownloadReceiptSchema = z.object({
  schemaVersion,
  receiptId: z.string().uuid(),
  candidateId: z.string().uuid(),
  candidateHash: sha256,
  source: z.enum(["nexus", "speedrun"]),
  sourceSnapshotId: z.string().uuid(),
  sourceSnapshotHash: sha256,
  pageUrl: z.string().url(),
  selectionKey: z.string().trim().min(1).max(1_000),
  backend: z.enum(["nexus-native", "nexus-persistent-chromium", "http", "manual"]),
  originalFileName: identifier,
  finalFileName: identifier,
  absolutePath,
  bytes: z.number().int().nonnegative(),
  sha256,
  contentType: z.string().trim().max(500).nullable(),
  finalUrl: z.string().url().nullable(),
  redirectChain: z.array(z.string().url()).max(20),
  archiveCheck: z.object({
    format: identifier,
    valid: z.boolean().nullable(),
    detail: z.string().trim().min(1).max(2_000),
  }),
  requestedAt: timestamp,
  completedAt: timestamp,
  status: z.literal("verified"),
  packageId: identifier.nullable(),
  receiptHash: sha256,
});

export const saveInputEntrySchema = z.object({
  originalPath: relativePath,
  normalizedPath: relativePath,
  kind: z.enum(["file", "directory"]),
  bytes: z.number().int().nonnegative(),
  packedBytes: z.number().int().nonnegative().nullable(),
  crc32: z.string().regex(/^[A-Fa-f0-9]{8}$/).nullable(),
});

export const savePayloadCandidateSchema = z.object({
  payloadSelectionId: z.string().uuid(),
  root: z.union([z.literal("."), relativePath]),
  game: gameIdentitySchema,
  unitId: identifier,
  recipe: z.object({
    recipeId: identifier,
    recipeVersion: identifier,
    recipeHash: sha256,
  }).optional(),
  layoutFamily: z.enum([
    "single-file",
    "slot-file-set",
    "container-with-companions",
    "directory-tree",
    "profile-plus-slots",
  ]).optional(),
  files: z
    .array(
      z.object({
        sourcePath: relativePath,
        relativePath,
        bytes: z.number().int().nonnegative(),
        slot: z.object({ kind: identifier, index: z.number().int().nonnegative().nullable() }).nullable().optional(),
      }),
    )
    .min(1)
    .max(10_000),
  binding: z.object({
    kind: z.enum(["steam_id64", "account_bound_unknown", "none", "unknown"]),
    value: z.string().trim().min(1).max(200).nullable(),
    evidence: z.string().trim().min(1).max(2_000).optional(),
  }),
  format: z.object({
    kind: z.enum([
      "single-file",
      "directory-tree",
      "game-specific-container",
      "unknown",
    ]),
    adapterHint: identifier.nullable(),
  }),
  confidence: z.enum(["confirmed", "probable"]),
});

export const saveInputInspectionSchema = z.object({
  schemaVersion,
  inspectionId: z.string().uuid(),
  input: z.object({
    kind: z.enum(["file", "directory", "zip", "rar", "7z"]),
    absolutePath,
    bytes: z.number().int().nonnegative(),
    sha256,
    modifiedAt: timestamp,
  }),
  archive: z
    .object({
      format: z.enum(["zip", "rar", "7z"]),
      extractor: z
        .object({
          kind: z.enum(["builtin-zip", "unrar", "seven-zip", "bsdtar"]),
          executablePath: absolutePath.nullable(),
          version: identifier,
        })
        .nullable(),
      entries: z.array(saveInputEntrySchema).max(100_000),
      totalUncompressedBytes: z.number().int().nonnegative(),
      totalPackedBytes: z.number().int().nonnegative().nullable(),
      commonTopLevelDirectory: relativePath.nullable(),
    })
    .nullable(),
  entries: z.array(saveInputEntrySchema).min(1).max(100_000),
  payloadCandidates: z.array(savePayloadCandidateSchema).max(100),
  containsExecutable: z.boolean(),
  warnings: z.array(z.string().trim().min(1).max(2_000)).max(100),
  createdAt: timestamp,
  inspectionHash: sha256,
});

export const saveCompatibilityAssessmentSchema = z.object({
  schemaVersion,
  assessmentId: z.string().uuid(),
  packageId: identifier,
  packageManifestHash: sha256,
  saveContextId: z.string().uuid(),
  state: z.enum([
    "compatible_direct",
    "compatible_with_slot_import",
    "compatible_with_account_rebind",
    "conversion_required",
    "ambiguous",
    "unsupported",
  ]),
  recommendedStrategy: z
    .enum(["direct_replace", "slot_import", "account_rebind", "format_conversion"])
    .nullable(),
  reasons: z.array(z.string().trim().min(1).max(2_000)).min(1).max(100),
  warnings: z.array(z.string().trim().min(1).max(2_000)).max(100),
  assessedAt: timestamp,
  assessmentHash: sha256,
});

export const savePathStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }),
  z.object({
    kind: z.literal("file"),
    bytes: z.number().int().nonnegative(),
    sha256,
  }),
  z.object({
    kind: z.literal("directory"),
    treeHash: sha256,
  }),
]);

export const saveWriteOperationSchema = z.object({
  operationId: z.string().uuid(),
  kind: z.enum(["create-file", "replace-file", "delete-file"]),
  rootId: identifier,
  targetRelativePath: relativePath,
  sourceObjectId: identifier.nullable(),
  expectedPreState: savePathStateSchema,
  expectedPostState: savePathStateSchema,
});

const commonPlanFields = {
  schemaVersion,
  status: z.literal("planned"),
  createdAt: timestamp,
  expiresAt: timestamp,
  preconditionStateHash: sha256,
  operations: z.array(saveWriteOperationSchema).min(1).max(10_000),
  rescueUnitId: identifier,
  review: planReviewSchema.optional(),
};

export const saveRestorePlanSchema = z.object({
  ...commonPlanFields,
  restorePlanId: z.string().uuid(),
  backupId: z.string().uuid(),
  saveContextId: z.string().uuid(),
  target: z.object({
    kind: z.enum(["save-context", "sandbox"]),
    rootId: identifier,
    absolutePath,
  }),
  preservedPaths: z
    .array(
      z.object({
        relativePath,
        expectedState: savePathStateSchema,
      }),
    )
    .max(10_000)
    .optional(),
  mode: z.enum(["overlay", "exact_managed_snapshot"]),
  planHash: sha256,
});

export const saveReplacementPlanSchema = z.object({
  ...commonPlanFields,
  replacementPlanId: z.string().uuid(),
  packageId: identifier,
  packageManifestHash: sha256,
  saveContextId: z.string().uuid(),
  compatibilityAssessmentId: z.string().uuid(),
  compatibilityHash: sha256,
  target: z.object({
    rootId: identifier,
    absolutePath,
  }),
  payloadPolicies: z.array(
    z.object({
      relativePath,
      action: z.enum(["create", "replace", "delete", "preserve-identical"]),
      expectedPreState: savePathStateSchema,
      expectedPostState: savePathStateSchema,
    }),
  ).min(1).max(10_000),
  strategy: z.enum([
    "direct_replace",
    "slot_import",
    "account_rebind",
    "format_conversion",
  ]),
  replacementMode: z.enum(["overlay", "exact-unit"]).optional(),
  adapterId: identifier,
  sourceSlot: z.number().int().min(0).max(999).nullable(),
  targetSlot: z.number().int().min(0).max(999).nullable(),
  stagedImportId: z.string().uuid().nullable().optional(),
  stagedImportRecordHash: sha256.nullable().optional(),
  slotImportPlanId: z.string().uuid().nullable().optional(),
  slotImportPlanHash: sha256.nullable().optional(),
  planHash: sha256,
});

export const saveTransactionEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  phase: z.enum([
    "planned",
    "locked",
    "rescue-backed-up",
    "staged",
    "applying",
    "verifying",
    "committed",
    "rolling-back",
    "rolled-back",
    "failed",
  ]),
  message: z.string().trim().min(1).max(2_000),
  observedAt: timestamp,
});

export const saveTransactionRecordSchema = z.object({
  schemaVersion,
  transactionId: z.string().uuid(),
  planKind: z.enum(["restore", "replacement"]),
  planId: z.string().uuid(),
  planHash: sha256,
  rescueBackupId: z.string().uuid().nullable(),
  state: z.enum(["committed", "rolled-back", "failed", "recovery-required"]),
  events: z.array(saveTransactionEventSchema).min(1).max(10_000),
  startedAt: timestamp,
  completedAt: timestamp.nullable(),
  transactionHash: sha256,
});

export const saveOperationRecordSchema = z.object({
  schemaVersion,
  recordId: z.string().uuid(),
  kind: z.enum(["restore", "replacement"]),
  planId: z.string().uuid(),
  transactionId: z.string().uuid(),
  saveContextId: z.string().uuid(),
  sourceId: identifier,
  staticVerification: z.enum(["passed", "failed"]),
  runtimeVerification: z.enum([
    "not-run",
    "passed",
    "failed",
    "original-restored",
  ]),
  completedAt: timestamp,
  recordHash: sha256,
});

export const saveRuntimeVerificationRecordSchema = z.object({
  schemaVersion,
  verificationId: z.string().uuid(),
  operationRecordId: z.string().uuid(),
  outcome: z.enum(["passed", "failed", "original_restored"]),
  notes: z.string().trim().min(1).max(4_000).nullable(),
  observedAt: timestamp,
  verificationHash: sha256,
});

export const eldenRingSlotSummarySchema = z.object({
  slotIndex: z.number().int().min(0).max(9),
  active: z.boolean(),
  characterName: z.string().max(32).nullable(),
  level: z.number().int().min(0).max(255),
  secondsPlayed: z.number().int().nonnegative(),
  checksum: md5,
  checksumValid: z.boolean(),
  accountIdOccurrences: z.number().int().nonnegative().max(100),
});

export const eldenRingSaveAnalysisSchema = z.object({
  schemaVersion,
  analysisId: z.string().uuid(),
  source: z.object({
    kind: z.enum(["package", "save-context", "path"]),
    referenceId: identifier.nullable(),
    absolutePath,
  }),
  fileSha256: sha256,
  bytes: z.literal(28_967_888),
  containerMagic: z.literal("BND4"),
  steamId64: z.string().regex(/^\d{17}$/),
  headerChecksum: md5,
  headerChecksumValid: z.boolean(),
  slots: z.array(eldenRingSlotSummarySchema).length(10),
  structureValid: z.literal(true),
  createdAt: timestamp,
  analysisHash: sha256,
});

const byteRangeSchema = z.object({
  start: z.number().int().nonnegative(),
  endExclusive: z.number().int().positive(),
  reason: identifier,
});

const changedByteRangeSchema = byteRangeSchema.extend({
  changedBytes: z.number().int().positive(),
});

export const eldenRingSlotImportPlanSchema = z.object({
  schemaVersion,
  slotImportPlanId: z.string().uuid(),
  status: z.literal("planned"),
  createdAt: timestamp,
  expiresAt: timestamp,
  packageId: identifier,
  packageManifestHash: sha256,
  saveContextId: z.string().uuid(),
  saveContextHash: sha256,
  sourceAnalysisId: z.string().uuid(),
  sourceAnalysisHash: sha256,
  targetAnalysisId: z.string().uuid(),
  targetAnalysisHash: sha256,
  sourceFileSha256: sha256,
  targetPreStateSha256: sha256,
  sourceSlot: z.number().int().min(0).max(9),
  targetSlot: z.number().int().min(0).max(9),
  overwriteOccupiedTarget: z.boolean(),
  sourceCharacterName: z.string().max(32).nullable(),
  replacedTargetCharacterName: z.string().max(32).nullable(),
  sourceSteamId64: z.string().regex(/^\d{17}$/),
  targetSteamId64: z.string().regex(/^\d{17}$/),
  transformations: z.array(z.enum([
    "copy-slot-data",
    "rebind-slot-steam-id",
    "copy-slot-summary",
    "mark-target-slot-active",
    "recompute-slot-md5",
    "recompute-header-md5",
  ])).length(6),
  allowedByteRanges: z.array(byteRangeSchema).length(4),
  preservedSlotIndexes: z.array(z.number().int().min(0).max(9)).length(9),
  planHash: sha256,
});

export const eldenRingStagedImportSchema = z.object({
  schemaVersion,
  stagedImportId: z.string().uuid(),
  slotImportPlanId: z.string().uuid(),
  planHash: sha256,
  stagedPath: absolutePath,
  bytes: z.literal(28_967_888),
  stagedSha256: sha256,
  sourceFileSha256: sha256,
  targetPreStateSha256: sha256,
  sourceSlot: z.number().int().min(0).max(9),
  targetSlot: z.number().int().min(0).max(9),
  reboundAccountOccurrences: z.number().int().positive().max(100),
  changedByteRanges: z.array(changedByteRangeSchema).min(1).max(4),
  allowedByteRangeVerification: z.literal("passed"),
  checksumVerification: z.literal("passed"),
  unselectedSlotsVerification: z.literal("passed"),
  createdAt: timestamp,
  recordHash: sha256,
});

export const gameSaveProfileSchema = z.object({
  schemaVersion,
  profileId: identifier,
  profileVersion: identifier,
  game: z.object({
    canonicalId: identifier,
    displayName: identifier,
    store: z.literal("steam"),
    storeAppId: identifier,
  }),
  supportedPlatforms: z.array(z.literal("windows")).length(1),
  sources: z.object({
    nexusDomainName: identifier.nullable(),
    speedrunGameSlug: identifier.nullable(),
  }).optional(),
  discovery: z.object({
    executableAnchors: z.array(relativePath).min(1).max(50),
    saveRootTemplates: z.array(z.string().trim().min(3).max(2_048)).min(1).max(50),
    probeRootTemplates: z.array(z.string().trim().min(3).max(2_048)).min(1).max(50),
    accountDirectoryPattern: z.string().trim().min(1).max(500).nullable(),
  }),
  saveUnits: z.array(saveUnitSchema).min(1).max(50),
  format: z.object({
    kind: z.enum([
      "single-file",
      "directory-tree",
      "game-specific-container",
      "unknown",
    ]),
    adapterId: identifier.nullable(),
  }),
  runtime: z.object({
    processNames: z.array(identifier).max(50),
    lockSensitiveProcessNames: z.array(identifier).max(50),
  }),
});

export const learnedSaveProfileSchema = z.object({
  schemaVersion,
  learnedProfileId: z.string().uuid(),
  gameCanonicalId: identifier,
  gameRootFingerprint: sha256,
  saveRoot: absolutePath,
  observedRelativePaths: z.array(relativePath).min(1).max(1_000),
  evidenceHash: sha256,
  state: z.literal("local_verified"),
  verifiedAt: timestamp,
  profileHash: sha256,
});

export const saveProbeEntrySchema = z.object({
  relativePath,
  kind: z.enum(["file", "directory"]),
  bytes: z.number().int().nonnegative(),
  modifiedAtMs: z.number().int().nonnegative(),
  sha256: sha256.nullable(),
});

export const saveProbeSnapshotSchema = z.object({
  root: absolutePath,
  exists: z.boolean(),
  entries: z.array(saveProbeEntrySchema).max(20_000),
  truncated: z.boolean(),
  snapshotHash: sha256,
});

export const saveProbeChangeSchema = z.object({
  root: absolutePath,
  relativePath,
  kind: z.enum(["created", "modified", "deleted"]),
  before: saveProbeEntrySchema.nullable(),
  after: saveProbeEntrySchema.nullable(),
});

export const saveLocationProbeSchema = z.object({
  schemaVersion,
  probeId: z.string().uuid(),
  installContextId: z.string().uuid(),
  profileId: identifier,
  status: z.enum(["pending", "completed"]),
  observationRoots: z.array(absolutePath).min(1).max(20),
  before: z.array(saveProbeSnapshotSchema).min(1).max(20),
  after: z.array(saveProbeSnapshotSchema).max(20).nullable(),
  changes: z.array(saveProbeChangeSchema).max(20_000),
  learnedProfileId: z.string().uuid().nullable(),
  saveContextId: z.string().uuid().nullable(),
  startedAt: timestamp,
  expiresAt: timestamp,
  completedAt: timestamp.nullable(),
  probeHash: sha256,
});

export type GameInstallContext = z.infer<typeof gameInstallContextSchema>;
export type SaveContext = z.infer<typeof saveContextSchema>;
export type SaveBackupRecord = z.infer<typeof saveBackupRecordSchema>;
export type StandardSavePackage = z.infer<typeof standardSavePackageSchema>;
export type SaveSourceCandidate = z.infer<typeof saveSourceCandidateSchema>;
export type SaveSourceSnapshot = z.infer<typeof saveSourceSnapshotSchema>;
export type SaveDownloadReceipt = z.infer<typeof saveDownloadReceiptSchema>;
export type SaveInputInspection = z.infer<typeof saveInputInspectionSchema>;
export type SavePayloadCandidate = z.infer<typeof savePayloadCandidateSchema>;
export type SaveCompatibilityAssessment = z.infer<typeof saveCompatibilityAssessmentSchema>;
export type SaveRestorePlan = z.infer<typeof saveRestorePlanSchema>;
export type SaveReplacementPlan = z.infer<typeof saveReplacementPlanSchema>;
export type SaveTransactionRecord = z.infer<typeof saveTransactionRecordSchema>;
export type SaveOperationRecord = z.infer<typeof saveOperationRecordSchema>;
export type SaveRuntimeVerificationRecord = z.infer<typeof saveRuntimeVerificationRecordSchema>;
export type EldenRingSlotSummary = z.infer<typeof eldenRingSlotSummarySchema>;
export type EldenRingSaveAnalysis = z.infer<typeof eldenRingSaveAnalysisSchema>;
export type EldenRingSlotImportPlan = z.infer<typeof eldenRingSlotImportPlanSchema>;
export type EldenRingStagedImport = z.infer<typeof eldenRingStagedImportSchema>;
export type GameSaveProfile = z.infer<typeof gameSaveProfileSchema>;
export type LearnedSaveProfile = z.infer<typeof learnedSaveProfileSchema>;
export type SaveProbeSnapshot = z.infer<typeof saveProbeSnapshotSchema>;
export type SaveLocationProbe = z.infer<typeof saveLocationProbeSchema>;

export function hashWithoutField<T extends Record<string, unknown>>(
  value: T,
  field: keyof T,
): string {
  const copy = { ...value };
  delete copy[field];
  return sha256CanonicalJson(copy);
}

export function verifyHashedContract<T extends Record<string, unknown>>(
  value: T,
  field: keyof T,
): boolean {
  return value[field] === hashWithoutField(value, field);
}
