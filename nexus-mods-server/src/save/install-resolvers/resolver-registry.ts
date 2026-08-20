import { NexusError } from "../../errors.js";
import type { GameInstallContextV2 } from "../v2/contracts.js";
import { ManualPeResolver } from "./manual-pe.js";
import { RuneSteamEmulatorResolver } from "./rune-steam-emulator.js";
import { SteamLibraryResolver } from "./steam-library.js";
import type { SaveInstallResolverInput, SaveInstallResolverV2 } from "./types.js";

export interface ProbeSaveInstallInput extends SaveInstallResolverInput {
  resolverHint?: string;
}

export class SaveInstallResolverRegistryV2 {
  readonly #resolvers: ReadonlyArray<SaveInstallResolverV2>;

  constructor(resolvers: ReadonlyArray<SaveInstallResolverV2> = [
    new SteamLibraryResolver(),
    new RuneSteamEmulatorResolver(),
    new ManualPeResolver(),
  ]) {
    const ids = new Set<string>();
    for (const resolver of resolvers) {
      if (ids.has(resolver.resolverId)) {
        throw new NexusError("SAVE_CONTRACT_INVALID", "Save installation resolver IDs must be unique.", {
          details: { resolverId: resolver.resolverId },
        });
      }
      ids.add(resolver.resolverId);
    }
    this.#resolvers = [...resolvers];
  }

  list(): ReadonlyArray<SaveInstallResolverV2> {
    return [...this.#resolvers];
  }

  async probe(input: ProbeSaveInstallInput): Promise<GameInstallContextV2> {
    if (input.resolverHint !== undefined) {
      const resolver = this.#resolvers.find((candidate) => candidate.resolverId === input.resolverHint);
      if (!resolver) {
        throw new NexusError("SAVE_INSTALL_RESOLVER_NOT_FOUND", "The requested save installation resolver is not registered.", {
          details: { resolverHint: input.resolverHint },
        });
      }
      const context = await resolver.probe(input);
      if (!context) {
        throw new NexusError("GAME_INSTALL_NOT_IDENTIFIED", "The requested resolver did not match the selected game root.", {
          details: { resolverHint: input.resolverHint, gameRoot: input.gameRoot },
        });
      }
      return context;
    }

    const specific = this.#resolvers.filter((resolver) => resolver.resolverId !== "manual-pe");
    const matches: GameInstallContextV2[] = [];
    for (const resolver of specific) {
      const context = await resolver.probe(input);
      if (context) matches.push(context);
    }
    if (matches.length > 1) {
      throw new NexusError("SAVE_INSTALL_IDENTITY_AMBIGUOUS", "Multiple distribution resolvers matched the selected game root.", {
        details: { gameRoot: input.gameRoot, resolverIds: matches.map((match) => match.resolver.resolverId) },
      });
    }
    if (matches[0]) return matches[0];

    const manual = this.#resolvers.find((resolver) => resolver.resolverId === "manual-pe");
    const fallback = manual ? await manual.probe(input) : null;
    if (fallback) return fallback;
    throw new NexusError("GAME_INSTALL_NOT_IDENTIFIED", "No registered installation resolver matched the selected game root.", {
      details: { gameRoot: input.gameRoot },
    });
  }
}
