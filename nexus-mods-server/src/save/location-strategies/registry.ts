import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import type { SaveLocationStrategyV2, SaveRootCandidateV2 } from "./types.js";

async function realDirectory(value: string): Promise<boolean> {
  const info = await lstat(value).catch(() => null);
  return Boolean(info?.isDirectory() && !info.isSymbolicLink());
}

function parameter(parameters: Readonly<Record<string, string | number | boolean>>, name: string): string {
  const value = parameters[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new NexusError("SAVE_CONTRACT_INVALID", `Location Strategy parameter ${name} is required.`);
  }
  return value.trim();
}

class ProductDirectoryStrategy implements SaveLocationStrategyV2 {
  readonly strategyVersion = "1.0.0";
  constructor(readonly strategyId: string, readonly base: "documents" | "savedGames" | "appData" | "localAppData" | "localLow") {}

  async candidates(input: Parameters<SaveLocationStrategyV2["candidates"]>[0]): Promise<ReadonlyArray<SaveRootCandidateV2>> {
    const root = path.join(input.environment[this.base], parameter(input.parameters, "productDirectory"));
    return await realDirectory(root) ? [{
      strategyId: this.strategyId,
      absolutePath: root,
      role: "primary",
      accountDirectory: null,
      accountKind: "none",
      evidence: `Existing non-reparse product directory under ${this.base}.`,
    }] : [];
  }
}

class ProductAccountDirectoryStrategy implements SaveLocationStrategyV2 {
  readonly strategyVersion = "1.0.0";
  constructor(readonly strategyId: string, readonly base: "documents" | "appData") {}

  async candidates(input: Parameters<SaveLocationStrategyV2["candidates"]>[0]): Promise<ReadonlyArray<SaveRootCandidateV2>> {
    const productRoot = path.join(input.environment[this.base], parameter(input.parameters, "productDirectory"));
    if (!(await realDirectory(productRoot))) return [];
    const sourcePattern = parameter(input.parameters, "accountDirectoryPattern");
    if (sourcePattern.length > 200) throw new NexusError("SAVE_CONTRACT_INVALID", "Account directory pattern is too long.");
    const pattern = new RegExp(sourcePattern);
    const entries = (await readdir(productRoot, { withFileTypes: true })).slice(0, 1_000);
    const results: SaveRootCandidateV2[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !pattern.test(entry.name)) continue;
      const absolutePath = path.join(productRoot, entry.name);
      const hint = input.install.accountHints.find((candidate) => candidate.value === entry.name);
      results.push({
        strategyId: this.strategyId,
        absolutePath,
        role: "primary",
        accountDirectory: entry.name,
        accountKind: hint?.kind ?? "opaque_directory_key",
        evidence: hint
          ? `Account subdirectory matches ${hint.kind} install evidence.`
          : "Account subdirectory matched the Recipe pattern; numeric shape alone has no Steam semantics.",
      });
    }
    return results;
  }
}

class PlatformCandidateStrategy implements SaveLocationStrategyV2 {
  readonly strategyVersion = "1.0.0";
  constructor(readonly strategyId: string) {}
  async candidates(input: Parameters<SaveLocationStrategyV2["candidates"]>[0]): Promise<ReadonlyArray<SaveRootCandidateV2>> {
    const results: SaveRootCandidateV2[] = [];
    for (const candidate of input.install.platformCandidateRoots.slice(0, 50)) {
      if (await realDirectory(candidate)) results.push({
        strategyId: this.strategyId,
        absolutePath: candidate,
        role: "variant",
        accountDirectory: null,
        accountKind: "unknown",
        evidence: "Existing non-reparse platform candidate root from the Install Context.",
      });
    }
    return results;
  }
}

export class SaveLocationStrategyRegistryV2 {
  readonly #strategies = new Map<string, SaveLocationStrategyV2>([
    ["documents-product-name", new ProductDirectoryStrategy("documents-product-name", "documents")],
    ["documents-product-account-subdir", new ProductAccountDirectoryStrategy("documents-product-account-subdir", "documents")],
    ["saved-games-product-name", new ProductDirectoryStrategy("saved-games-product-name", "savedGames")],
    ["appdata-roaming-product-name", new ProductDirectoryStrategy("appdata-roaming-product-name", "appData")],
    ["appdata-roaming-product-account-subdir", new ProductAccountDirectoryStrategy("appdata-roaming-product-account-subdir", "appData")],
    ["appdata-local-product-name", new ProductDirectoryStrategy("appdata-local-product-name", "localAppData")],
    ["appdata-locallow-product-name", new ProductDirectoryStrategy("appdata-locallow-product-name", "localLow")],
    ["steam-userdata-appid", new PlatformCandidateStrategy("steam-userdata-appid")],
    ["rune-public-documents-appid", new PlatformCandidateStrategy("rune-public-documents-appid")],
  ]);

  list(): ReadonlyArray<SaveLocationStrategyV2> { return [...this.#strategies.values()]; }
  get(strategyId: string): SaveLocationStrategyV2 {
    const strategy = this.#strategies.get(strategyId);
    if (!strategy) throw new NexusError("SAVE_LOCATION_STRATEGY_EXHAUSTED", "The Recipe references an unavailable Location Strategy.", { details: { strategyId } });
    return strategy;
  }
}
