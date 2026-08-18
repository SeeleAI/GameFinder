import { randomUUID } from "node:crypto";

import { sha256CanonicalJson } from "../../src/install/content-hash.js";
import type {
  GameInstallContext,
  SaveBackupRecord,
  SaveContext,
  SaveOperationRecord,
  SaveReplacementPlan,
  SaveRestorePlan,
  SaveTransactionRecord,
  StandardSavePackage,
} from "../../src/save/contracts.js";

const NOW = "2026-07-30T00:00:00.000Z";
const LATER = "2026-07-30T00:30:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function withHash<T extends Record<string, unknown>, K extends string>(
  value: T,
  field: K,
): T & Record<K, string> {
  return {
    ...value,
    [field]: sha256CanonicalJson(value),
  } as T & Record<K, string>;
}

export function gameInstallContextFixture(
  overrides: Partial<GameInstallContext> = {},
): GameInstallContext {
  const withoutHash = {
    schemaVersion: 1 as const,
    installContextId: randomUUID(),
    gameRoot: "C:\\Steam\\steamapps\\common\\ELDEN RING\\Game",
    platform: "windows" as const,
    store: "steam" as const,
    game: {
      canonicalId: "steam:1245620",
      displayName: "ELDEN RING",
      storeAppId: "1245620",
    },
    storeMetadata: {
      steam: {
        appId: "1245620",
        buildId: "22984413",
        lastOwner: "76561198127396738",
        installDir: "ELDEN RING",
        manifestPath: "C:\\Steam\\steamapps\\appmanifest_1245620.acf",
      },
    },
    installEvidence: [
      {
        kind: "steam-appmanifest" as const,
        path: "C:\\Steam\\steamapps\\appmanifest_1245620.acf",
        detail: "Matched Steam appmanifest.",
        observedAt: NOW,
      },
    ],
    confidence: "confirmed" as const,
    createdAt: NOW,
    ...overrides,
  };
  return withHash(withoutHash, "contextHash") as GameInstallContext;
}

export function saveContextFixture(
  installContextId: GameInstallContext["installContextId"] = randomUUID(),
): SaveContext {
  const withoutHash = {
    schemaVersion: 1 as const,
    saveContextId: randomUUID(),
    installContextId,
    windowsUserSidHash: null,
    windowsUserIdentityHash: HASH_A,
    profile: {
      profileId: "elden-ring-steam-pc",
      profileVersion: "1.0.0",
      source: "built-in" as const,
    },
    storeAccount: {
      kind: "steam_id64" as const,
      value: "76561198127396738",
    },
    saveRoots: [
      {
        rootId: "primary",
        absolutePath:
          "C:\\Users\\fixture\\AppData\\Roaming\\EldenRing\\76561198127396738",
        role: "primary" as const,
      },
    ],
    saveUnits: [
      {
        unitId: "vanilla-main",
        essential: ["ER0000.sl2"],
        companions: ["ER0000.sl2.bak"],
        auxiliary: ["steam_autocloud.vdf"],
        managedPaths: [
          "ER0000.sl2",
          "ER0000.sl2.bak",
          "steam_autocloud.vdf",
        ],
      },
    ],
    format: {
      kind: "game-specific-container" as const,
      adapterId: "elden-ring-steam-pc",
    },
    evidence: [
      {
        kind: "profile-rule" as const,
        path:
          "C:\\Users\\fixture\\AppData\\Roaming\\EldenRing\\76561198127396738",
        detail: "Matched built-in profile.",
        observedAt: NOW,
      },
    ],
    verification: {
      state: "confirmed" as const,
      method: "profile+filesystem" as const,
    },
    createdAt: NOW,
  };
  return withHash(withoutHash, "contextHash") as SaveContext;
}

export function backupRecordFixture(): SaveBackupRecord {
  const withoutHash = {
    schemaVersion: 1 as const,
    backupId: randomUUID(),
    saveContextId: randomUUID(),
    unitId: "vanilla-main",
    reason: "acceptance_baseline" as const,
    sourceRoot:
      "C:\\Users\\fixture\\AppData\\Roaming\\EldenRing\\76561198127396738",
    files: [
      {
        relativePath: "ER0000.sl2",
        role: "essential" as const,
        backupObjectId: randomUUID(),
        bytes: 28_967_888,
        sha256: HASH_A,
        modifiedAt: NOW,
        attributes: ["archive"],
      },
    ],
    treeHash: HASH_B,
    sourcePreStateHash: HASH_C,
    sourcePostStateHash: HASH_C,
    profileId: "elden-ring-steam-pc",
    profileVersion: "1.0.0",
    adapterId: "elden-ring-steam-pc",
    createdAt: NOW,
    integrity: "verified" as const,
  };
  return withHash(withoutHash, "backupRecordHash") as SaveBackupRecord;
}

export function standardPackageFixture(): StandardSavePackage {
  const withoutHash = {
    schemaVersion: 1 as const,
    packageId: "savepkg-fixture",
    game: {
      canonicalId: "steam:1245620",
      displayName: "ELDEN RING",
      storeAppId: "1245620",
    },
    source: {
      kind: "manual" as const,
      inspectionId: "0b452b95-065a-4cf5-b9cb-a8360abebf7e",
      pageUrl: null,
      downloadReceiptId: null,
      originalInputPath: "C:\\fixtures\\save.rar",
      originalInputSha256: HASH_A,
    },
    claims: {
      progress: "100 percent",
      gameVersion: "1.16.1",
      dlc: ["Shadow of the Erdtree"],
      onlineSafety: "unknown" as const,
    },
    payload: {
      root: "payload",
      files: [
        {
          relativePath: "ER0000.sl2",
          objectId: "d5bfb58c-f9fa-4b8a-b3af-0818f8d39f8b",
          bytes: 28_967_888,
          sha256: HASH_A,
        },
      ],
      treeHash: HASH_B,
    },
    binding: {
      kind: "account_bound_unknown" as const,
      value: null,
    },
    format: {
      kind: "game-specific-container" as const,
      adapterHint: "elden-ring-steam-pc",
    },
    safety: {
      archiveInspection: "passed" as const,
      containsExecutable: false,
      warnings: [],
    },
    createdAt: NOW,
  };
  return withHash(withoutHash, "manifestHash") as StandardSavePackage;
}

function operation() {
  return {
    operationId: randomUUID(),
    kind: "replace-file" as const,
    rootId: "primary",
    targetRelativePath: "ER0000.sl2",
    sourceObjectId: "object-a",
    expectedPreState: {
      kind: "file" as const,
      bytes: 1,
      sha256: HASH_A,
    },
    expectedPostState: {
      kind: "file" as const,
      bytes: 2,
      sha256: HASH_B,
    },
  };
}

export function restorePlanFixture(): SaveRestorePlan {
  const withoutHash = {
    schemaVersion: 1 as const,
    status: "planned" as const,
    createdAt: NOW,
    expiresAt: LATER,
    preconditionStateHash: HASH_A,
    operations: [operation()],
    rescueUnitId: "vanilla-main",
    restorePlanId: randomUUID(),
    backupId: randomUUID(),
    saveContextId: randomUUID(),
    target: {
      kind: "save-context" as const,
      rootId: "primary",
      absolutePath:
        "C:\\Users\\fixture\\AppData\\Roaming\\EldenRing\\76561198127396738",
    },
    mode: "overlay" as const,
  };
  return withHash(withoutHash, "planHash") as SaveRestorePlan;
}

export function replacementPlanFixture(): SaveReplacementPlan {
  const withoutHash = {
    schemaVersion: 1 as const,
    status: "planned" as const,
    createdAt: NOW,
    expiresAt: LATER,
    preconditionStateHash: HASH_A,
    operations: [operation()],
    rescueUnitId: "vanilla-main",
    replacementPlanId: randomUUID(),
    packageId: "savepkg-fixture",
    packageManifestHash: HASH_A,
    saveContextId: randomUUID(),
    compatibilityAssessmentId: "c0d524e0-4db2-40f0-9988-f9fc9fc7f8fb",
    compatibilityHash: HASH_B,
    target: {
      rootId: "primary",
      absolutePath:
        "C:\\Users\\fixture\\AppData\\Roaming\\EldenRing\\76561198127396738",
    },
    payloadPolicies: [
      {
        relativePath: "ER0000.sl2",
        action: "replace" as const,
        expectedPreState: operation().expectedPreState,
        expectedPostState: operation().expectedPostState,
      },
    ],
    strategy: "slot_import" as const,
    adapterId: "elden-ring-steam-pc",
    sourceSlot: 0,
    targetSlot: 1,
  };
  return withHash(withoutHash, "planHash") as SaveReplacementPlan;
}

export function transactionFixture(): SaveTransactionRecord {
  const withoutHash = {
    schemaVersion: 1 as const,
    transactionId: randomUUID(),
    planKind: "restore" as const,
    planId: randomUUID(),
    planHash: HASH_A,
    rescueBackupId: randomUUID(),
    state: "committed" as const,
    events: [
      {
        sequence: 0,
        phase: "committed" as const,
        message: "Static verification passed.",
        observedAt: NOW,
      },
    ],
    startedAt: NOW,
    completedAt: NOW,
  };
  return withHash(withoutHash, "transactionHash") as SaveTransactionRecord;
}

export function operationRecordFixture(): SaveOperationRecord {
  const withoutHash = {
    schemaVersion: 1 as const,
    recordId: randomUUID(),
    kind: "restore" as const,
    planId: randomUUID(),
    transactionId: randomUUID(),
    saveContextId: randomUUID(),
    sourceId: randomUUID(),
    staticVerification: "passed" as const,
    runtimeVerification: "not-run" as const,
    completedAt: NOW,
  };
  return withHash(withoutHash, "recordHash") as SaveOperationRecord;
}
