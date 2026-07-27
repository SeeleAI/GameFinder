import type {
  BackupObject,
  CurrentStateInspection,
  GameInstance,
  GameProfile,
  InstallationRecord,
  InstallOperation,
  InstallPlan,
  PackageAnalysis,
  TransactionJournal,
  UninstallPlan
} from "../../src/install/contracts.js";

export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const HASH_C = "c".repeat(64);
export const ANALYSIS_ID = "11111111-1111-4111-8111-111111111111";
export const PLAN_ID = "22222222-2222-4222-8222-222222222222";
export const INSTANCE_ID = "33333333-3333-4333-8333-333333333333";
export const OPERATION_ID = "44444444-4444-4444-8444-444444444444";
export const TRANSACTION_ID = "55555555-5555-4555-8555-555555555555";
export const INSTALLATION_ID = "66666666-6666-4666-8666-666666666666";
export const BACKUP_ID = "77777777-7777-4777-8777-777777777777";
export const INSPECTION_ID = "88888888-8888-4888-8888-888888888888";
export const STAGING_ID = "99999999-9999-4999-8999-999999999999";
export const UNINSTALL_PLAN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const NOW = "2026-07-26T00:00:00.000Z";

export function installFileOperation(): InstallOperation {
  return {
    operationId: OPERATION_ID,
    kind: "install_new_file",
    sourceRelativePath: "SkipFishingMinigameDotnet5/SkipFishingMinigame.dll",
    sourceSha256: HASH_A,
    targetRelativePath: "Mods/SkipFishingMinigameDotnet5/SkipFishingMinigame.dll",
    expectedPreState: { kind: "absent" },
    expectedPostState: { kind: "file", bytes: 1_024, sha256: HASH_A }
  };
}

export function packageAnalysisFixture(): PackageAnalysis {
  return {
    schemaVersion: 1,
    analysisId: ANALYSIS_ID,
    analysisHash: HASH_B,
    analyzerVersion: "phase6b-contract-v1",
    archive: {
      absolutePath: "C:\\Downloads\\SkipFishingMinigame.zip",
      fileName: "SkipFishingMinigame.zip",
      bytes: 18_120,
      sha256: HASH_C
    },
    packages: [
      {
        packageUnitId: "DewMods.SkipFishingMinigame",
        packageType: "loader-plugin",
        packageRoot: "SkipFishingMinigameDotnet5",
        identity: {
          uniqueId: "DewMods.SkipFishingMinigame",
          name: "Skip Fishing Minigame",
          version: "0.7.4"
        },
        entryFiles: ["SkipFishingMinigame.dll"],
        dependencies: [
          {
            dependencyId: "SMAPI",
            kind: "required",
            versionConstraint: ">=4.1.1",
            evidence: ["SMAPI manifest"]
          }
        ],
        positiveSignals: ["manifest.json has UniqueID and EntryDll"],
        negativeSignals: []
      }
    ],
    ambiguities: [],
    analyzedAt: NOW
  };
}

export function gameProfileFixture(): GameProfile {
  return {
    schemaVersion: 1,
    profileId: "stardewvalley",
    profileVersion: "1.0.0",
    gameName: "Stardew Valley",
    nexusDomainName: "stardewvalley",
    supportedOperatingSystems: ["win32"],
    discovery: {
      executableAnchors: ["Stardew Valley.exe"],
      steamAppIds: [413150]
    },
    filesystem: {
      writableRoots: ["Mods"],
      protectedRoots: ["Content", "Saves"],
      liveModRoots: ["Mods"],
      stateLocationPolicy: "local-app-data"
    },
    loaders: [
      {
        loaderId: "smapi",
        detectionPaths: ["StardewModdingAPI.exe"],
        modRoots: ["Mods"],
        logLocations: ["%APPDATA%/StardewValley/ErrorLogs/SMAPI-latest.txt"]
      }
    ],
    runtime: {
      processNames: ["Stardew Valley.exe"],
      lockSensitiveProcessNames: ["Stardew Valley.exe", "StardewModdingAPI.exe"]
    }
  };
}

export function gameInstanceFixture(): GameInstance {
  return {
    schemaVersion: 1,
    instanceId: INSTANCE_ID,
    profileId: "stardewvalley",
    profileVersion: "1.0.0",
    gameRoot: "C:\\Games\\Stardew Valley",
    platform: "steam",
    platformAppId: "413150",
    gameVersion: "1.6.15",
    anchorFingerprints: [HASH_A],
    detectedLoaders: [
      {
        loaderId: "smapi",
        state: "detected",
        version: "4.1.10",
        absolutePath: "C:\\Games\\Stardew Valley\\StardewModdingAPI.exe",
        modRoots: ["C:\\Games\\Stardew Valley\\Mods"],
        evidence: ["StardewModdingAPI.exe exists"]
      }
    ],
    verifiedAt: NOW
  };
}

export function installPlanFixture(): InstallPlan {
  return {
    schemaVersion: 1,
    planId: PLAN_ID,
    planHash: HASH_A,
    status: "planned",
    createdAt: NOW,
    expiresAt: "2026-07-26T01:00:00.000Z",
    archive: packageAnalysisFixture().archive,
    analysisId: ANALYSIS_ID,
    analysisHash: HASH_B,
    gameInstanceId: INSTANCE_ID,
    gameProfileId: "stardewvalley",
    gameProfileVersion: "1.0.0",
    adapterId: "smapi-folder-mod",
    adapterVersion: "1.0.0",
    staging: {
      stagingId: STAGING_ID,
      packageRoot: "SkipFishingMinigameDotnet5",
      sourceTreeHash: HASH_B
    },
    operations: [installFileOperation()],
    conflicts: [
      {
        targetRelativePath: "Mods/SkipFishingMinigameDotnet5/SkipFishingMinigame.dll",
        kind: "new_path",
        blocking: false,
        message: "Target does not exist."
      }
    ],
    preconditionStateHash: HASH_C
  };
}

export function transactionJournalFixture(): TransactionJournal {
  return {
    schemaVersion: 1,
    transactionId: TRANSACTION_ID,
    transactionKind: "install",
    planId: PLAN_ID,
    gameInstanceId: INSTANCE_ID,
    state: "committed",
    startedAt: NOW,
    completedAt: "2026-07-26T00:00:01.000Z",
    entries: [
      {
        sequence: 0,
        recordedAt: NOW,
        phase: "applying",
        operationId: OPERATION_ID,
        event: "operation_applied",
        preState: { kind: "absent" },
        postState: { kind: "file", bytes: 1_024, sha256: HASH_A },
        backupId: null,
        message: "Installed new file."
      }
    ]
  };
}

export function uninstallPlanFixture(): UninstallPlan {
  return {
    schemaVersion: 1,
    uninstallPlanId: UNINSTALL_PLAN_ID,
    uninstallPlanHash: HASH_A,
    status: "planned",
    installationId: INSTALLATION_ID,
    installationRevision: 1,
    inspectionId: INSPECTION_ID,
    inspectionStateHash: HASH_B,
    gameInstanceId: INSTANCE_ID,
    gameProfileId: "stardewvalley",
    gameProfileVersion: "1.0.0",
    createdAt: NOW,
    expiresAt: "2026-07-26T01:00:00.000Z",
    actions: [
      {
        actionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        kind: "delete_owned_file",
        targetRelativePath:
          "Mods/SkipFishingMinigameDotnet5/SkipFishingMinigame.dll",
        expectedCurrentState: {
          kind: "file",
          bytes: 1_024,
          sha256: HASH_A
        }
      }
    ],
    retainedPaths: []
  };
}

export function backupObjectFixture(): BackupObject {
  return {
    schemaVersion: 1,
    backupId: BACKUP_ID,
    objectKind: "file",
    sha256: HASH_B,
    bytes: 512,
    absolutePath: "C:\\Manager\\backups\\bb\\fixture",
    createdAt: NOW,
    referenceCount: 1
  };
}

export function installationRecordFixture(): InstallationRecord {
  return {
    schemaVersion: 1,
    installationId: INSTALLATION_ID,
    revision: 1,
    state: "runtime_unverified",
    transactionId: TRANSACTION_ID,
    sourcePlanId: PLAN_ID,
    sourcePlanHash: HASH_A,
    gameInstanceId: INSTANCE_ID,
    gameProfileId: "stardewvalley",
    gameProfileVersion: "1.0.0",
    adapterId: "smapi-folder-mod",
    adapterVersion: "1.0.0",
    archive: packageAnalysisFixture().archive,
    nexus: {
      domainName: "stardewvalley",
      modId: 2697,
      fileId: 115145,
      receiptPath: "C:\\Downloads\\SkipFishingMinigame.zip.nexus-receipt.json"
    },
    packageSummary: {
      analysisHash: HASH_B,
      packageUnitId: "DewMods.SkipFishingMinigame",
      packageRoot: "SkipFishingMinigameDotnet5",
      identity: {
        uniqueId: "DewMods.SkipFishingMinigame",
        name: "Skip Fishing Minigame",
        version: "0.7.4"
      }
    },
    operationOutcomes: [
      {
        operationId: OPERATION_ID,
        operationKind: "install_new_file",
        targetRelativePath: "Mods/SkipFishingMinigameDotnet5/SkipFishingMinigame.dll",
        outcome: "applied",
        preState: { kind: "absent" },
        postState: { kind: "file", bytes: 1_024, sha256: HASH_A },
        ownershipMode: "installed_file_set",
        ownedFiles: [],
        ownedDirectories: [],
        backupId: null,
        previousOwnerInstallationId: null
      }
    ],
    staticVerification: "passed",
    runtimeVerification: "not-run",
    installedAt: NOW,
    updatedAt: NOW,
    uninstallTransactionId: null
  };
}

export function currentStateInspectionFixture(): CurrentStateInspection {
  return {
    schemaVersion: 1,
    inspectionId: INSPECTION_ID,
    installationId: INSTALLATION_ID,
    gameInstanceId: INSTANCE_ID,
    stateHash: HASH_C,
    inspectedAt: NOW,
    paths: [
      {
        targetRelativePath: "Mods/SkipFishingMinigameDotnet5/SkipFishingMinigame.dll",
        state: "unchanged",
        expectedPostState: { kind: "file", bytes: 1_024, sha256: HASH_A },
        actualState: { kind: "file", bytes: 1_024, sha256: HASH_A },
        currentOwnerInstallationId: INSTALLATION_ID
      }
    ],
    blocking: false
  };
}
