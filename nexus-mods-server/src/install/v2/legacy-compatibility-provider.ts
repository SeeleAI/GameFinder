import { createHash } from "node:crypto";

import { NexusError } from "../../errors.js";
import type { AdapterPackageContext } from "../adapter.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { GameProfile } from "../contracts.js";
import {
  computeGameDefinitionHash,
  gameDefinitionV2Schema,
  methodProviderCandidateSchema,
} from "./contracts.js";
import type {
  GameDefinitionV2,
  MethodProviderCandidate,
} from "./contracts.js";

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function mapMatchState(
  state: "matched" | "possible" | "ambiguous" | "unsupported" | "blocked",
): MethodProviderCandidate["state"] {
  switch (state) {
    case "matched":
      return "candidate_match";
    case "possible":
    case "ambiguous":
      return "ambiguous";
    case "blocked":
      return "evidence_stale";
    case "unsupported":
      return "no_match";
  }
}

function mapProfile(profile: GameProfile): GameDefinitionV2 {
  const withoutHash: Omit<GameDefinitionV2, "definitionHash"> = {
    schemaVersion: 2,
    definitionId: `v1-profile:${profile.profileId}`,
    revision: 1,
    origin: "v1_compat",
    game: {
      gameId: profile.profileId,
      name: profile.gameName,
      nexusDomainName: profile.nexusDomainName,
    },
    supportedOperatingSystems: [...profile.supportedOperatingSystems],
    discovery: {
      executableAnchors: [...profile.discovery.executableAnchors],
      platformAppIds: profile.discovery.steamAppIds.map(String),
    },
    pathPolicyTemplate: {
      writableRoots: [...profile.filesystem.writableRoots],
      protectedRoots: [...profile.filesystem.protectedRoots],
      liveModRoots: [...profile.filesystem.liveModRoots],
    },
    loaders: profile.loaders.map((loader) => ({
      loaderId: loader.loaderId,
      detectionPaths: [...loader.detectionPaths],
      modRoots: [...loader.modRoots],
      logLocations: [...loader.logLocations],
    })),
    legacyProfileBinding: {
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
    },
  };
  return gameDefinitionV2Schema.parse({
    ...withoutHash,
    definitionHash: computeGameDefinitionHash(withoutHash),
  });
}

export class LegacyV1CompatibilityProvider {
  readonly providerId = "legacy-v1-adapter-provider";
  readonly #registry: AdapterRegistry;
  readonly #profiles: ReadonlyMap<string, GameProfile>;

  constructor(input: {
    registry: AdapterRegistry;
    profiles: ReadonlyArray<GameProfile>;
  }) {
    this.#registry = input.registry;
    const profiles = new Map<string, GameProfile>();
    for (const profile of input.profiles) {
      if (profiles.has(profile.profileId)) {
        throw new NexusError(
          "INSTALL_CONTRACT_INVALID",
          `Duplicate V1 Game Profile ${profile.profileId}.`,
        );
      }
      profiles.set(profile.profileId, profile);
    }
    this.#profiles = profiles;
  }

  listGameDefinitions(): ReadonlyArray<GameDefinitionV2> {
    return [...this.#profiles.values()]
      .sort((left, right) => left.profileId.localeCompare(right.profileId))
      .map(mapProfile);
  }

  getGameDefinition(profileId: string): GameDefinitionV2 {
    const profile = this.#profiles.get(profileId);
    if (!profile) {
      throw new NexusError(
        "GAME_CONTEXT_REQUIRED",
        `V1 Game Profile ${profileId} is not available as a compatibility definition.`,
      );
    }
    return mapProfile(profile);
  }

  async query(
    context: AdapterPackageContext,
  ): Promise<ReadonlyArray<MethodProviderCandidate>> {
    const profile = this.#profiles.get(context.profile.profileId);
    if (
      !profile ||
      profile.profileVersion !== context.profile.profileVersion
    ) {
      throw new NexusError(
        "GAME_CONTEXT_REQUIRED",
        "The V1 Adapter query references an unregistered compatibility profile.",
        {
          details: {
            profileId: context.profile.profileId,
            profileVersion: context.profile.profileVersion,
          },
        },
      );
    }

    const results = await this.#registry.matchAll(context);
    return results.map(({ match }) =>
      methodProviderCandidateSchema.parse({
        schemaVersion: 2,
        candidateId: deterministicUuid(
          [
            this.providerId,
            context.analysis.analysisHash,
            context.profile.profileId,
            context.profile.profileVersion,
            match.adapterId,
            match.adapterVersion,
          ].join("\0"),
        ),
        providerId: this.providerId,
        providerKind: "legacy_v1_adapter",
        state: mapMatchState(match.state),
        confidence: match.confidence,
        methodBinding: null,
        legacyAdapterBinding: {
          adapterId: match.adapterId,
          adapterVersion: match.adapterVersion,
          profileId: context.profile.profileId,
          profileVersion: context.profile.profileVersion,
        },
        packageUnitIds: match.packageUnitIds,
        positiveSignals: match.positiveSignals,
        negativeSignals: match.negativeSignals,
        missingEvidence: match.missingEvidence,
        requiresUserChoice: match.requiresUserChoice,
      }),
    );
  }
}
