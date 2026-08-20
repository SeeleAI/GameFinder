import { randomUUID } from "node:crypto";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import type {
  SaveCompatibilityAssessment,
  SaveContext,
} from "../contracts.js";
import { saveCompatibilityAssessmentSchema } from "../contracts.js";
import type { SavePackageNormalizer } from "../package/package-normalizer.js";
import type { SaveContextStore } from "../storage/context-store.js";
import { SaveCompatibilityAssessmentStore } from "./save-compatibility-assessment-store.js";

export class SaveCompatibilityAssessor {
  readonly #contexts: SaveContextStore;
  readonly #packages: SavePackageNormalizer;
  readonly #store: SaveCompatibilityAssessmentStore;

  private constructor(input: {
    contexts: SaveContextStore;
    packages: SavePackageNormalizer;
    store: SaveCompatibilityAssessmentStore;
  }) {
    this.#contexts = input.contexts;
    this.#packages = input.packages;
    this.#store = input.store;
  }

  static async create(options: {
    managerRoot: string;
    contexts: SaveContextStore;
    packages: SavePackageNormalizer;
  }): Promise<SaveCompatibilityAssessor> {
    return new SaveCompatibilityAssessor({
      contexts: options.contexts,
      packages: options.packages,
      store: await SaveCompatibilityAssessmentStore.create(options.managerRoot),
    });
  }

  async assess(input: {
    packageId: string;
    saveContextId: string;
  }): Promise<Readonly<SaveCompatibilityAssessment>> {
    const [savePackage, context] = await Promise.all([
      this.#packages.verify(input.packageId),
      this.#contexts.getSaveContext(input.saveContextId),
    ]);
    const install = await this.#contexts.getInstallContext(context.installContextId);
    const reasons: string[] = [];
    const warnings: string[] = [];
    let state: SaveCompatibilityAssessment["state"] = "compatible_direct";
    let recommendedStrategy: SaveCompatibilityAssessment["recommendedStrategy"] = "direct_replace";
    if (context.verification.state !== "confirmed") {
      state = "ambiguous";
      recommendedStrategy = null;
      reasons.push("The target Save Context is not confirmed.");
    } else if (savePackage.game.canonicalId !== install.game.canonicalId) {
      state = "unsupported";
      recommendedStrategy = null;
      reasons.push("The package game identity does not match the target installation.");
    } else {
      const unit = context.saveUnits.find((candidate) => candidate.unitId === "vanilla-main");
      if (!unit) {
        state = "unsupported";
        recommendedStrategy = null;
        reasons.push("The target context has no compatible vanilla-main Save Unit.");
      } else if (
        savePackage.format.adapterHint !== context.format.adapterId ||
        savePackage.format.kind !== context.format.kind
      ) {
        state = "conversion_required";
        recommendedStrategy = "format_conversion";
        reasons.push("The package format does not exactly match the target Save Context adapter.");
      } else {
        const packagePaths = new Set(
          savePackage.payload.files.map((file) => file.relativePath.toLowerCase()),
        );
        const managed = new Set(unit.managedPaths.map((value) => value.toLowerCase()));
        if (savePackage.payload.files.some((file) => !managed.has(file.relativePath.toLowerCase()))) {
          state = "unsupported";
          recommendedStrategy = null;
          reasons.push("The package contains files outside the target Save Unit managed paths.");
        } else if (unit.essential.some((value) => !packagePaths.has(value.toLowerCase()))) {
          state = "unsupported";
          recommendedStrategy = null;
          reasons.push("The package is missing an essential target Save Unit file.");
        } else if (
          savePackage.binding.kind === "steam_id64" &&
          context.storeAccount?.kind === "steam_id64" &&
          savePackage.binding.value === context.storeAccount.value
        ) {
          reasons.push("Game, format, managed files, and SteamID64 binding match exactly.");
        } else if (
          savePackage.binding.kind === "steam_id64" &&
          context.storeAccount?.kind === "steam_id64" &&
          savePackage.binding.value !== context.storeAccount.value
        ) {
          if (context.format.adapterId === "elden-ring-steam-pc") {
            state = "compatible_with_slot_import";
            recommendedStrategy = "slot_import";
            reasons.push("The Elden Ring package SteamID64 differs; the adapter can rebind one selected slot while preserving other target slots.");
          } else {
            state = "compatible_with_account_rebind";
            recommendedStrategy = "account_rebind";
            reasons.push("The package SteamID64 differs from the target account.");
          }
        } else {
          if (context.format.adapterId === "elden-ring-steam-pc") {
            state = "compatible_with_slot_import";
            recommendedStrategy = "slot_import";
            reasons.push("The package account binding is unproven; the Elden Ring adapter must parse and rebind one selected slot.");
          } else {
            state = "ambiguous";
            recommendedStrategy = null;
            reasons.push("The package account binding cannot be proven to match the target.");
          }
        }
      }
    }
    if (savePackage.claims.gameVersion === null) {
      warnings.push("The manual package does not claim a game version; M3 verifies format and identity only.");
    }
    warnings.push("Static compatibility does not replace offline in-game runtime verification.");
    const withoutHash = {
      schemaVersion: 1 as const,
      assessmentId: randomUUID(),
      packageId: savePackage.packageId,
      packageManifestHash: savePackage.manifestHash,
      saveContextId: context.saveContextId,
      state,
      recommendedStrategy,
      reasons,
      warnings,
      assessedAt: new Date().toISOString(),
    };
    return await this.#store.save(
      saveCompatibilityAssessmentSchema.parse({
        ...withoutHash,
        assessmentHash: sha256CanonicalJson(withoutHash),
      }),
    );
  }

  async get(assessmentId: string): Promise<Readonly<SaveCompatibilityAssessment>> {
    return await this.#store.get(assessmentId);
  }

  async saveV2TransactionBridge(input: {
    assessmentId: string;
    packageId: string;
    packageManifestHash: string;
    saveContextId: string;
    reasons: string[];
    warnings: string[];
    assessedAt: string;
  }): Promise<Readonly<SaveCompatibilityAssessment>> {
    const withoutHash: Omit<SaveCompatibilityAssessment, "assessmentHash"> = {
      schemaVersion: 1,
      assessmentId: input.assessmentId,
      packageId: input.packageId,
      packageManifestHash: input.packageManifestHash,
      saveContextId: input.saveContextId,
      state: "compatible_direct",
      recommendedStrategy: "direct_replace",
      reasons: input.reasons,
      warnings: input.warnings,
      assessedAt: input.assessedAt,
    };
    const bridge = saveCompatibilityAssessmentSchema.parse({
      ...withoutHash,
      assessmentHash: sha256CanonicalJson(withoutHash),
    });
    try {
      const existing = await this.#store.get(input.assessmentId);
      if (existing.assessmentHash !== bridge.assessmentHash) {
        throw new NexusError("SAVE_PACKAGE_INVALID", "A V2 transaction bridge with the same identity has different evidence.");
      }
      return existing;
    } catch (error) {
      if (!(error instanceof NexusError) || error.code !== "NOT_FOUND") throw error;
      return await this.#store.save(bridge);
    }
  }
}
