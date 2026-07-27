import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { NexusError } from "../src/errors.js";
import {
  AdapterRegistry,
  STARDEW_VALLEY_PROFILE,
  SmapiFolderModAdapter,
  computeDynamicGameContextHash,
  computeEvidencePackHash,
  computeInstallPlanV2Hash,
  computeInstallProposalHash,
  computeInstallationMethodHash,
  computeMethodOutcomeHash,
  dynamicGameContextSchema,
  evidencePackSchema,
  gameInstanceSchema,
  installPlanV2Schema,
  installProposalSchema,
  installationMethodSchema,
  LegacyV1CompatibilityProvider,
  MethodStore,
  methodOutcomeSchema,
  packageAnalysisSchema,
} from "../src/install/index.js";
import type {
  DynamicGameContext,
  EvidencePack,
  InstallPlanV2,
  InstallProposal,
  InstallationMethod,
  MethodOutcome,
} from "../src/install/index.js";

const cleanup: string[] = [];
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const NOW = "2026-07-27T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "phase6b-v2-m1-"));
  cleanup.push(directory);
  return directory;
}

function makeMethod(
  overrides: Partial<Omit<InstallationMethod, "methodHash">> = {},
): InstallationMethod {
  const withoutHash: Omit<InstallationMethod, "methodHash"> = {
    schemaVersion: 2,
    methodId: randomUUID(),
    revision: 1,
    state: "draft",
    createdAt: NOW,
    updatedAt: NOW,
    name: "SMAPI self-contained folder package",
    scope: {
      operatingSystems: ["win32"],
      gameSelectors: [
        {
          signalId: "game-stardew-valley",
          kind: "game_identity",
          subject: "gameId",
          operator: "equals",
          expected: "stardew-valley",
          required: true,
        },
      ],
      loaderSelectors: [
        {
          signalId: "loader-smapi",
          kind: "loader_state",
          subject: "smapi",
          operator: "equals",
          expected: "detected",
          required: true,
        },
      ],
      sourceSelectors: [],
      packageSignals: [
        {
          signalId: "package-loader-plugin",
          kind: "package_type",
          subject: "packageType",
          operator: "equals",
          expected: "loader-plugin",
          required: true,
        },
      ],
      negativeSignals: [],
    },
    resolution: {
      packageRootRules: ["Use the directory containing manifest.json."],
      componentSelectionRules: [],
      targetMappings: [
        {
          mappingId: "smapi-mod-root",
          sourceTemplate: "${packageRoot}",
          targetTemplate: "Mods/${packageName}",
        },
      ],
    },
    operationTemplates: [
      {
        templateId: "install-package-tree",
        kind: "install_tree",
        sourceTemplate: "${packageRoot}",
        targetTemplate: "Mods/${packageName}",
        ownershipMode: "installed_file_set",
      },
    ],
    preconditions: [],
    verificationTemplate: {
      staticChecks: [
        {
          checkId: "manifest-present",
          kind: "path_exists",
          subject: "Mods/${packageName}/manifest.json",
          expected: null,
          required: true,
          evidenceIds: [],
        },
      ],
      runtimeChecks: [],
      dependentMinimumLevel: "static_verified",
    },
    reversibilityRequirements: [
      {
        operationKind: "install_tree",
        level: "full",
        requirement: "Record the installed file set.",
      },
    ],
    provenance: {
      origin: "agent_learned",
      evidenceRefs: [],
      derivedFromInstallationIds: [],
      legacyAdapterBinding: null,
    },
    confidence: {
      deterministicSignals: ["manifest.json", "EntryDll"],
      successfulApplications: 0,
      failedApplications: 0,
      lastVerifiedAt: null,
    },
    ...overrides,
  };
  return installationMethodSchema.parse({
    ...withoutHash,
    methodHash: computeInstallationMethodHash(withoutHash),
  });
}

function makeEvidencePack(): EvidencePack {
  const withoutHash: Omit<EvidencePack, "evidencePackHash"> = {
    schemaVersion: 2,
    evidencePackId: randomUUID(),
    createdAt: NOW,
    source: {
      archive: {
        absolutePath: "C:\\Downloads\\mod.zip",
        fileName: "mod.zip",
        bytes: 10,
        sha256: HASH_A,
      },
      receiptPath: "C:\\Downloads\\mod.zip.nexus-receipt.json",
      nexus: {
        domainName: "stardewvalley",
        modId: 2697,
        fileId: 115145,
        canonicalModUrl: "https://www.nexusmods.com/stardewvalley/mods/2697",
      },
      bundle: null,
    },
    archive: {
      inventoryHash: HASH_B,
      entryCount: 1,
      entries: [
        {
          relativePath: "SkipFishingMinigame/manifest.json",
          kind: "file",
          bytes: 10,
          sha256: HASH_C,
        },
      ],
    },
    packageUnits: [],
    dependencies: [],
    gameContextBinding: null,
    evidence: [],
  };
  return evidencePackSchema.parse({
    ...withoutHash,
    evidencePackHash: computeEvidencePackHash(withoutHash),
  });
}

function makeGameContext(): DynamicGameContext {
  const withoutHash: Omit<DynamicGameContext, "gameContextHash"> = {
    schemaVersion: 2,
    gameContextId: randomUUID(),
    state: "observed",
    createdAt: NOW,
    verifiedAt: NOW,
    game: {
      gameId: "stardew-valley",
      name: "Stardew Valley",
      nexusDomainName: "stardewvalley",
      version: "1.6.14",
    },
    instance: {
      gameRoot: "C:\\Games\\Stardew Valley",
      platform: "steam",
      platformAppId: "413150",
      operatingSystem: "win32",
      anchorFingerprints: [HASH_A],
    },
    pathPolicy: {
      writableRoots: [
        { scope: "game_root", path: "Mods", evidenceIds: [] },
      ],
      protectedRoots: [
        { scope: "game_root", path: "Content", evidenceIds: [] },
      ],
      liveModRoots: [
        { scope: "game_root", path: "Mods", evidenceIds: [] },
      ],
      managedStateRoots: [
        {
          scope: "manager_root",
          path: "installations",
          evidenceIds: [],
        },
      ],
      observableRoots: [],
      processSideEffectRoots: [],
    },
    detectedLoaders: [],
    processes: {
      knownProcessNames: ["Stardew Valley.exe"],
      lockSensitiveProcessNames: ["Stardew Valley.exe"],
    },
    definitionBinding: null,
    legacyProfileBinding: null,
    evidence: [],
  };
  return dynamicGameContextSchema.parse({
    ...withoutHash,
    gameContextHash: computeDynamicGameContextHash(withoutHash),
  });
}

describe("Phase 6B V2 M1 contracts", () => {
  it("binds evidence, game context, proposal, and frozen plan with V2 hashes", () => {
    const evidence = makeEvidencePack();
    const context = makeGameContext();
    const proposalWithoutHash: Omit<InstallProposal, "proposalHash"> = {
      schemaVersion: 2,
      proposalId: randomUUID(),
      createdAt: NOW,
      evidenceBinding: {
        evidencePackId: evidence.evidencePackId,
        evidencePackHash: evidence.evidencePackHash,
      },
      gameBinding: {
        gameContextId: context.gameContextId,
        gameContextHash: context.gameContextHash,
      },
      strategyBinding: {
        origin: "agent_proposal",
        methodId: null,
        methodRevision: null,
        methodHash: null,
        legacyAdapterBinding: null,
      },
      selection: {
        packageUnitId: "skip-fishing-minigame",
        packageRoot: "SkipFishingMinigame",
        selectedComponents: [],
      },
      operations: [
        {
          operationId: randomUUID(),
          kind: "install_tree",
          sourceRelativePath: "SkipFishingMinigame",
          targetRelativePath: "Mods/SkipFishingMinigame",
          ownershipMode: "installed_file_set",
        },
      ],
      preconditions: [],
      verificationRequirements: [],
      unresolvedChoices: [],
      risk: { level: "low", reasons: [] },
    };
    const proposal = installProposalSchema.parse({
      ...proposalWithoutHash,
      proposalHash: computeInstallProposalHash(proposalWithoutHash),
    });

    const planWithoutHash: Omit<InstallPlanV2, "planHash"> = {
      schemaVersion: 2,
      planId: randomUUID(),
      status: "planned",
      createdAt: NOW,
      expiresAt: "2026-07-27T13:00:00.000Z",
      source: {
        archive: evidence.source.archive,
        receiptPath: evidence.source.receiptPath,
        bundleId: null,
        bundleNodeId: null,
      },
      evidenceBinding: proposal.evidenceBinding,
      gameBinding: {
        ...proposal.gameBinding,
        gameRoot: context.instance.gameRoot,
      },
      strategyBinding: {
        ...proposal.strategyBinding,
        proposalId: proposal.proposalId,
        proposalHash: proposal.proposalHash,
      },
      selection: proposal.selection,
      operations: [
        {
          operationId: proposal.operations[0]?.operationId ?? randomUUID(),
          kind: "install_tree",
          sourceRelativePath: "SkipFishingMinigame",
          sourceTreeHash: HASH_B,
          targetRelativePath: "Mods/SkipFishingMinigame",
          ownershipMode: "installed_file_set",
          expectedPreState: { kind: "absent" },
          expectedPostState: {
            kind: "directory",
            treeHash: HASH_B,
            entries: 1,
          },
        },
      ],
      conflicts: [],
      preconditions: [],
      verificationRequirements: [],
      reversibility: {
        level: "full",
        backupRequirements: [],
      },
      risk: proposal.risk,
      approval: {
        requiresExplicitConfirmation: true,
        approvalDigest: HASH_C,
      },
      preconditionStateHash: HASH_A,
    };
    const plan = installPlanV2Schema.parse({
      ...planWithoutHash,
      planHash: computeInstallPlanV2Hash(planWithoutHash),
    });

    expect(proposal.schemaVersion).toBe(2);
    expect(plan.strategyBinding.origin).toBe("agent_proposal");
    expect(plan.evidenceBinding.evidencePackHash).toBe(
      evidence.evidencePackHash,
    );
  });
});

describe("Phase 6B V2 Method Store", () => {
  it("stores immutable revisions, enforces transitions, indexes, and appends outcomes", async () => {
    const managerRoot = await temporaryRoot();
    const store = await MethodStore.create(managerRoot);
    const draft = makeMethod();

    await expect(store.saveDraft(draft)).resolves.toEqual(draft);
    expect(await store.list({ gameId: "stardew-valley" })).toEqual([draft]);

    await expect(store.transition(draft.methodId, "promoted")).rejects.toMatchObject({
      code: "INSTALL_CONTRACT_INVALID",
    } satisfies Partial<NexusError>);

    const approved = await store.transition(
      draft.methodId,
      "session_approved",
      { updatedAt: "2026-07-27T12:01:00.000Z" },
    );
    const verified = await store.transition(
      draft.methodId,
      "local_verified",
      { updatedAt: "2026-07-27T12:02:00.000Z" },
    );

    expect((await store.history(draft.methodId)).map((item) => item.state)).toEqual([
      "draft",
      "session_approved",
      "local_verified",
    ]);
    expect(approved.revision).toBe(2);
    expect(verified.revision).toBe(3);

    const outcomeWithoutHash: Omit<MethodOutcome, "outcomeHash"> = {
      schemaVersion: 2,
      outcomeId: randomUUID(),
      methodId: verified.methodId,
      methodRevision: verified.revision,
      methodHash: verified.methodHash,
      evidencePackId: randomUUID(),
      evidencePackHash: HASH_A,
      gameContextId: randomUUID(),
      gameContextHash: HASH_B,
      installationId: randomUUID(),
      transactionId: null,
      state: "succeeded",
      verification: {
        static: "passed",
        runtime: "not_run",
      },
      operationDeviations: [],
      failureAttribution: null,
      createdAt: "2026-07-27T12:03:00.000Z",
    };
    const outcome = methodOutcomeSchema.parse({
      ...outcomeWithoutHash,
      outcomeHash: computeMethodOutcomeHash(outcomeWithoutHash),
    });
    await expect(store.appendOutcome(outcome)).resolves.toEqual(outcome);
    expect(await store.listOutcomes(verified.methodId)).toEqual([outcome]);

    const reopened = await MethodStore.create(managerRoot);
    expect(await reopened.get(verified.methodId)).toEqual(verified);
    await expect(reopened.saveDraft(draft)).rejects.toMatchObject({
      code: "INSTALL_CONTRACT_INVALID",
    } satisfies Partial<NexusError>);
  });

  it("rejects method and outcome hash mismatches", async () => {
    const store = await MethodStore.create(await temporaryRoot());
    const draft = makeMethod();
    await expect(
      store.saveDraft({ ...draft, name: "tampered" }),
    ).rejects.toMatchObject({
      code: "INSTALL_CONTRACT_INVALID",
    } satisfies Partial<NexusError>);

    const saved = await store.saveDraft(draft);
    const outcomeWithoutHash: Omit<MethodOutcome, "outcomeHash"> = {
      schemaVersion: 2,
      outcomeId: randomUUID(),
      methodId: saved.methodId,
      methodRevision: saved.revision,
      methodHash: saved.methodHash,
      evidencePackId: randomUUID(),
      evidencePackHash: HASH_A,
      gameContextId: randomUUID(),
      gameContextHash: HASH_B,
      installationId: null,
      transactionId: randomUUID(),
      state: "failed",
      verification: { static: "failed", runtime: "not_run" },
      operationDeviations: [],
      failureAttribution: "method",
      createdAt: NOW,
    };
    const outcome = methodOutcomeSchema.parse({
      ...outcomeWithoutHash,
      outcomeHash: computeMethodOutcomeHash(outcomeWithoutHash),
    });
    await expect(
      store.appendOutcome({ ...outcome, failureAttribution: "environment" }),
    ).rejects.toMatchObject({
      code: "INSTALL_CONTRACT_INVALID",
    } satisfies Partial<NexusError>);
  });
});

describe("Phase 6B V2 legacy compatibility provider", () => {
  it("maps V1 Profiles and Adapter matches to read-only V2 candidates", async () => {
    const provider = new LegacyV1CompatibilityProvider({
      registry: new AdapterRegistry([new SmapiFolderModAdapter()]),
      profiles: [STARDEW_VALLEY_PROFILE],
    });
    const definitions = provider.listGameDefinitions();
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({
      origin: "v1_compat",
      game: { gameId: "stardew-valley" },
      legacyProfileBinding: { profileId: "stardew-valley" },
    });

    const analysis = packageAnalysisSchema.parse({
      schemaVersion: 1,
      analysisId: randomUUID(),
      analysisHash: HASH_A,
      analyzerVersion: "1.0.0",
      archive: {
        absolutePath: "C:\\Downloads\\mod.zip",
        fileName: "mod.zip",
        bytes: 10,
        sha256: HASH_B,
      },
      packages: [
        {
          packageUnitId: "skip-fishing-minigame",
          packageType: "loader-plugin",
          packageRoot: "SkipFishingMinigame",
          identity: {
            uniqueId: "DewMods.SkipFishingMinigame",
            name: "Skip Fishing Minigame",
            version: "0.7.4",
          },
          entryFiles: ["SkipFishingMinigame.dll"],
          dependencies: [],
          positiveSignals: ["SMAPI manifest declares EntryDll."],
          negativeSignals: [],
        },
      ],
      ambiguities: [],
      analyzedAt: NOW,
    });
    const instance = gameInstanceSchema.parse({
      schemaVersion: 1,
      instanceId: randomUUID(),
      profileId: "stardew-valley",
      profileVersion: "1.0.0",
      gameRoot: "C:\\Games\\Stardew Valley",
      platform: "steam",
      platformAppId: "413150",
      gameVersion: "1.6.14",
      anchorFingerprints: [HASH_C],
      detectedLoaders: [
        {
          loaderId: "smapi",
          state: "detected",
          version: "4.5.2",
          absolutePath: "C:\\Games\\Stardew Valley\\StardewModdingAPI.exe",
          modRoots: ["C:\\Games\\Stardew Valley\\Mods"],
          evidence: ["Found StardewModdingAPI.exe."],
        },
      ],
      verifiedAt: NOW,
    });

    const candidates = await provider.query({
      analysis,
      profile: STARDEW_VALLEY_PROFILE,
      instance,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      providerKind: "legacy_v1_adapter",
      state: "candidate_match",
      confidence: 0.99,
      legacyAdapterBinding: {
        adapterId: "smapi-folder-mod",
        profileId: "stardew-valley",
      },
    });
    expect(candidates[0]?.methodBinding).toBeNull();
  });
});
