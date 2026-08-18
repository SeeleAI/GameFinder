import { createHash, randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import type {
  GameInstallContext,
  GameSaveProfile,
  LearnedSaveProfile,
  SaveContext,
} from "../contracts.js";
import { saveContextSchema } from "../contracts.js";
import type { GameSaveProfileRegistry } from "../profiles/registry.js";
import type { LearnedSaveProfileStore } from "../storage/learned-profile-store.js";
import {
  assertWindowsSaveEnvironment,
  expandSaveTemplate,
  type SaveEnvironment,
} from "./environment.js";

export function gameRootFingerprint(gameRoot: string): string {
  return createHash("sha256")
    .update(path.resolve(gameRoot).toLowerCase())
    .digest("hex");
}

function windowsUserIdentityHash(environment: SaveEnvironment): string {
  return createHash("sha256")
    .update(
      `${environment.username.toLowerCase()}\0${path.resolve(environment.userProfile).toLowerCase()}`,
    )
    .digest("hex");
}

async function isDirectory(value: string): Promise<boolean> {
  return await stat(value)
    .then((info) => info.isDirectory())
    .catch(() => false);
}

async function isFile(value: string): Promise<boolean> {
  return await stat(value)
    .then((info) => info.isFile())
    .catch(() => false);
}

async function profileRootIsValid(
  saveRoot: string,
  profile: GameSaveProfile,
): Promise<boolean> {
  if (!(await isDirectory(saveRoot))) return false;
  return await Promise.any(
    profile.saveUnits.map(async (unit) => {
      for (const required of unit.essential) {
        if (
          !(await isFile(path.join(saveRoot, ...required.split("/"))))
        ) {
          throw new Error("missing");
        }
      }
      return true;
    }),
  ).catch(() => false);
}

async function candidateAccountRoots(input: {
  profile: GameSaveProfile;
  environment: SaveEnvironment;
  preferredSteamId: string | null;
}): Promise<Array<{ saveRoot: string; steamId: string | null }>> {
  const candidates: Array<{ saveRoot: string; steamId: string | null }> = [];
  if (input.preferredSteamId) {
    for (const template of input.profile.discovery.saveRootTemplates) {
      const saveRoot = expandSaveTemplate(
        template,
        input.environment,
        input.preferredSteamId,
      );
      if (await profileRootIsValid(saveRoot, input.profile)) {
        candidates.push({
          saveRoot,
          steamId: input.preferredSteamId,
        });
      }
    }
    if (candidates.length > 0) return candidates;
  }

  for (const template of input.profile.discovery.saveRootTemplates) {
    const marker = "{STEAM_ID64}";
    const markerIndex = template.indexOf(marker);
    if (markerIndex < 0) {
      const saveRoot = expandSaveTemplate(template, input.environment, null);
      if (await profileRootIsValid(saveRoot, input.profile)) {
        candidates.push({ saveRoot, steamId: null });
      }
      continue;
    }
    const parentTemplate = template
      .slice(0, markerIndex)
      .replace(/[\\/]+$/, "");
    const parent = expandSaveTemplate(
      parentTemplate,
      input.environment,
      null,
    );
    if (!(await isDirectory(parent))) continue;
    const accountPattern = input.profile.discovery.accountDirectoryPattern
      ? new RegExp(input.profile.discovery.accountDirectoryPattern)
      : null;
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (accountPattern && !accountPattern.test(entry.name)) continue;
      const saveRoot = path.join(parent, entry.name);
      if (await profileRootIsValid(saveRoot, input.profile)) {
        candidates.push({ saveRoot, steamId: entry.name });
      }
    }
  }
  const deduplicated = new Map<string, { saveRoot: string; steamId: string | null }>();
  for (const candidate of candidates) {
    deduplicated.set(candidate.saveRoot.toLowerCase(), candidate);
  }
  return [...deduplicated.values()];
}

function buildSaveContext(input: {
  install: GameInstallContext;
  environment: SaveEnvironment;
  saveRoot: string;
  steamId: string | null;
  profile: GameSaveProfile | null;
  learned: LearnedSaveProfile | null;
  observedRelativePaths?: ReadonlyArray<string>;
  method: SaveContext["verification"]["method"];
  now?: Date;
}): SaveContext {
  const now = (input.now ?? new Date()).toISOString();
  const saveUnits = input.profile?.saveUnits ?? [
    {
      unitId: "learned-main",
      essential: [...(input.observedRelativePaths ?? [])],
      companions: [],
      auxiliary: [],
      managedPaths: [...(input.observedRelativePaths ?? [])],
    },
  ];
  const withoutHash = {
    schemaVersion: 1 as const,
    saveContextId: randomUUID(),
    installContextId: input.install.installContextId,
    windowsUserSidHash: null,
    windowsUserIdentityHash: windowsUserIdentityHash(input.environment),
    profile: input.profile
      ? {
          profileId: input.profile.profileId,
          profileVersion: input.profile.profileVersion,
          source: "built-in" as const,
        }
      : {
          profileId: input.learned?.learnedProfileId ?? "learned-save-profile",
          profileVersion: "1",
          source: "learned" as const,
        },
    storeAccount: input.steamId
      ? {
          kind: "steam_id64" as const,
          value: input.steamId,
        }
      : null,
    saveRoots: [
      {
        rootId: "primary",
        absolutePath: path.resolve(input.saveRoot),
        role: "primary" as const,
      },
    ],
    saveUnits,
    format: input.profile?.format ?? {
      kind: "unknown" as const,
      adapterId: null,
    },
    evidence: [
      {
        kind: input.learned
          ? ("learned-profile" as const)
          : ("profile-rule" as const),
        path: path.resolve(input.saveRoot),
        detail: input.learned
          ? `Matched local verified profile ${input.learned.learnedProfileId}.`
          : `Matched built-in profile ${input.profile?.profileId ?? "unknown"}.`,
        observedAt: now,
      },
      {
        kind: "filesystem" as const,
        path: path.resolve(input.saveRoot),
        detail: "Required Save Unit files exist at this root.",
        observedAt: now,
      },
    ],
    verification: {
      state: "confirmed" as const,
      method: input.method,
    },
    createdAt: now,
  };
  return saveContextSchema.parse({
    ...withoutHash,
    contextHash: sha256CanonicalJson(withoutHash),
  });
}

export class SaveContextResolver {
  readonly #profiles: GameSaveProfileRegistry;
  readonly #learnedProfiles: LearnedSaveProfileStore;
  readonly #environment: SaveEnvironment;

  constructor(input: {
    profiles: GameSaveProfileRegistry;
    learnedProfiles: LearnedSaveProfileStore;
    environment: SaveEnvironment;
  }) {
    this.#profiles = input.profiles;
    this.#learnedProfiles = input.learnedProfiles;
    this.#environment = input.environment;
  }

  async resolve(install: GameInstallContext): Promise<SaveContext> {
    assertWindowsSaveEnvironment(this.#environment);
    const profile = this.#profiles.findByCanonicalGameId(
      install.game.canonicalId,
    );
    if (profile) {
      const candidates = await candidateAccountRoots({
        profile,
        environment: this.#environment,
        preferredSteamId:
          install.storeMetadata.steam?.lastOwner ?? null,
      });
      if (candidates.length === 1) {
        const candidate = candidates[0];
        if (!candidate) {
          throw new NexusError(
            "SAVE_CONTEXT_NOT_FOUND",
            "The sole save-root candidate could not be read.",
          );
        }
        return buildSaveContext({
          install,
          environment: this.#environment,
          saveRoot: candidate.saveRoot,
          steamId: candidate.steamId,
          profile,
          learned: null,
          method: "profile+filesystem",
        });
      }
      if (candidates.length > 1) {
        throw new NexusError(
          "SAVE_CONTEXT_AMBIGUOUS",
          "Multiple valid save roots were found and no unique current account could be established.",
          {
            details: {
              candidateRoots: candidates.map((candidate) => candidate.saveRoot),
            },
          },
        );
      }
    }

    const learnedCandidates = (
      await this.#learnedProfiles.listForGame(install.game.canonicalId)
    ).filter(
      (candidate) =>
        candidate.gameRootFingerprint ===
          gameRootFingerprint(install.gameRoot) &&
        candidate.observedRelativePaths.length > 0,
    );
    const validLearned: LearnedSaveProfile[] = [];
    for (const candidate of learnedCandidates) {
      if (!(await isDirectory(candidate.saveRoot))) continue;
      let valid = true;
      for (const relativePath of candidate.observedRelativePaths) {
        if (
          !(await isFile(
            path.join(candidate.saveRoot, ...relativePath.split("/")),
          ))
        ) {
          valid = false;
          break;
        }
      }
      if (valid) validLearned.push(candidate);
    }
    if (validLearned.length === 1) {
      const learned = validLearned[0];
      if (!learned) {
        throw new NexusError(
          "SAVE_CONTEXT_NOT_FOUND",
          "The learned save-root candidate could not be read.",
        );
      }
      const name = path.basename(learned.saveRoot);
      return buildSaveContext({
        install,
        environment: this.#environment,
        saveRoot: learned.saveRoot,
        steamId: /^\d{17}$/.test(name) ? name : null,
        profile: null,
        learned,
        observedRelativePaths: learned.observedRelativePaths,
        method: "learned-profile",
      });
    }
    if (validLearned.length > 1) {
      throw new NexusError(
        "SAVE_CONTEXT_AMBIGUOUS",
        "Multiple local verified save roots match this game installation.",
        {
          details: {
            learnedProfileIds: validLearned.map(
              (candidate) => candidate.learnedProfileId,
            ),
          },
        },
      );
    }
    throw new NexusError(
      "SAVE_CONTEXT_NOT_FOUND",
      "No validated local save root was found. Start a differential probe.",
      {
        details: {
          gameCanonicalId: install.game.canonicalId,
          profileId: profile?.profileId ?? null,
        },
      },
    );
  }
}
