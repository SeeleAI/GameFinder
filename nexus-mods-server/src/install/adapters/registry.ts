import { NexusError } from "../../errors.js";
import type {
  AdapterMatchResult,
  AdapterPackageContext,
  InstallAdapter,
} from "../adapter.js";

export interface SelectedAdapter {
  adapter: InstallAdapter;
  match: AdapterMatchResult;
}

export class AdapterRegistry {
  readonly #adapters = new Map<string, InstallAdapter>();

  constructor(adapters: ReadonlyArray<InstallAdapter> = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: InstallAdapter): void {
    const id = adapter.descriptor.adapterId;
    if (this.#adapters.has(id)) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        `Adapter ${id} is already registered.`,
      );
    }
    this.#adapters.set(id, adapter);
  }

  list(): ReadonlyArray<InstallAdapter> {
    return [...this.#adapters.values()].sort((left, right) =>
      left.descriptor.adapterId.localeCompare(right.descriptor.adapterId),
    );
  }

  get(adapterId: string): InstallAdapter {
    const adapter = this.#adapters.get(adapterId);
    if (!adapter) {
      throw new NexusError(
        "ADAPTER_NOT_FOUND",
        `Adapter ${adapterId} is not registered.`,
      );
    }
    return adapter;
  }

  async matchAll(
    context: AdapterPackageContext,
  ): Promise<ReadonlyArray<{
    adapter: InstallAdapter;
    match: AdapterMatchResult;
  }>> {
    const results = await Promise.all(
      this.list().map(async (adapter) => ({
        adapter,
        match: await adapter.probePackage(context),
      })),
    );
    return results.sort((left, right) => {
      const confidence = right.match.confidence - left.match.confidence;
      return confidence !== 0
        ? confidence
        : left.match.adapterId.localeCompare(right.match.adapterId);
    });
  }

  async select(context: AdapterPackageContext): Promise<SelectedAdapter> {
    const results = await this.matchAll(context);
    const matches = results.filter((result) => result.match.state === "matched");
    if (matches.length === 1 && matches[0]) return matches[0];
    if (matches.length > 1) {
      throw new NexusError(
        "ADAPTER_AMBIGUOUS",
        "More than one Adapter matched the selected package.",
        {
          details: {
            matches: matches.map(({ match }) => ({
              adapterId: match.adapterId,
              adapterVersion: match.adapterVersion,
              confidence: match.confidence,
              packageUnitIds: match.packageUnitIds,
            })),
          },
        },
      );
    }

    const ambiguous = results.filter(
      (result) =>
        result.match.state === "ambiguous" ||
        result.match.state === "possible",
    );
    if (ambiguous.length > 0) {
      throw new NexusError(
        "ADAPTER_AMBIGUOUS",
        "No unique high-confidence Adapter match is available.",
        {
          details: {
            candidates: ambiguous.map(({ match }) => match),
          },
        },
      );
    }
    throw new NexusError(
      "ADAPTER_NOT_FOUND",
      "No registered Adapter supports the analyzed package.",
      {
        details: {
          adapters: results.map(({ match }) => ({
            adapterId: match.adapterId,
            state: match.state,
            negativeSignals: match.negativeSignals,
          })),
        },
      },
    );
  }
}
