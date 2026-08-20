import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { GameSaveRecipeRegistryV2 } from "../src/save/recipes/recipe-registry.js";
import { FormatAdapterRegistry } from "../src/save/adapters/format-adapter-registry.js";
import { GameSaveRecipeStoreV2 } from "../src/save/recipes/recipe-store.js";
import { LearnedGameSaveRecipeStoreV2 } from "../src/save/recipes/learned-recipe-store.js";
import {
  adapterRequirementAssessmentSchema,
  computeAdapterRequirementAssessmentHash,
  materializeGameSaveRecipe,
  verifyAdapterRequirementAssessmentHash,
  verifyGameSaveRecipeHash,
} from "../src/save/v2/contracts.js";

const fixtureDirectory = fileURLToPath(new URL("./fixtures/save-recipes/", import.meta.url));
const zeroHash = "0".repeat(64);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("save V2 composable recipes", () => {
  it("loads and hash-verifies the built-in Elden Ring and Ghost of Tsushima recipes", async () => {
    const registry = await GameSaveRecipeRegistryV2.fromDirectory();
    expect(registry.list().map((recipe) => recipe.recipeId)).toEqual([
      "elden-ring-windows",
      "ghost-of-tsushima-directors-cut-windows",
    ]);
    expect(registry.list().every(verifyGameSaveRecipeHash)).toBe(true);
    expect(registry.findCandidates({ platform: "steam", platformAppId: "2215430" }))
      .toEqual([expect.objectContaining({ recipeId: "ghost-of-tsushima-directors-cut-windows" })]);
    expect(registry.findCandidates({
      executableName: "GhostOfTsushima.exe",
      productName: "Ghost of Tsushima DIRECTOR'S CUT",
    })).toHaveLength(1);
  });

  it("matches format Adapters by Recipe, format, and operation scope instead of game-name branches", async () => {
    const recipes = await GameSaveRecipeRegistryV2.fromDirectory();
    const eldenRing = recipes.findById("elden-ring-windows")!;
    const ghost = recipes.findById("ghost-of-tsushima-directors-cut-windows")!;
    const adapters = new FormatAdapterRegistry();
    expect(adapters.match({ adapterId: eldenRing.format.adapterId, recipe: eldenRing, operation: "cross-account-import" }))
      .toMatchObject({ adapterId: "elden-ring-steam-pc" });
    expect(adapters.match({ adapterId: eldenRing.format.adapterId, recipe: eldenRing, operation: "version-conversion" }))
      .toBeNull();
    expect(adapters.match({ adapterId: "elden-ring-steam-pc", recipe: ghost, operation: "cross-account-import" }))
      .toBeNull();
    expect(adapters.match({ adapterId: ghost.format.adapterId, recipe: ghost, operation: "replace-whole-unit" }))
      .toMatchObject({ adapterId: "ghost-of-tsushima-pc-v49" });
  });

  it("adds two games sharing one resolver, strategy, and layout through JSON data only", async () => {
    const registry = await GameSaveRecipeRegistryV2.fromDirectory(fixtureDirectory);
    const recipes = registry.list();
    expect(recipes).toHaveLength(2);
    expect(new Set(recipes.flatMap((recipe) => recipe.installResolvers))).toEqual(
      new Set(["rune-steam-emulator"]),
    );
    expect(new Set(recipes.map((recipe) => recipe.locationStrategies[0]?.strategyId))).toEqual(
      new Set(["documents-product-account-subdir"]),
    );
    expect(new Set(recipes.map((recipe) => recipe.saveUnits[0]?.layoutFamily))).toEqual(
      new Set(["slot-file-set"]),
    );
    expect(registry.findCandidates({ platformAppId: "900002" })[0]?.recipeId)
      .toBe("fixture-slot-game-b");
  });

  it("publishes hash-addressed immutable V2 recipe records", async () => {
    const registry = await GameSaveRecipeRegistryV2.fromDirectory(fixtureDirectory);
    const managerRoot = await mkdtemp(path.join(os.tmpdir(), "save-recipe-v2-store-"));
    temporaryDirectories.push(managerRoot);
    const store = await GameSaveRecipeStoreV2.create(managerRoot);
    const recipe = registry.findById("fixture-slot-game-a");
    expect(recipe).not.toBeNull();
    const saved = await store.save(recipe!);
    expect(saved).toEqual(recipe);
    expect(await store.get(saved.recipeHash)).toEqual(recipe);
    await store.save(recipe!);
    expect(await store.list()).toEqual([recipe]);
    await expect(store.get("f".repeat(64))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("stores local_verified Recipe evidence as a machine- and probe-scoped immutable record", async () => {
    const registry = await GameSaveRecipeRegistryV2.fromDirectory(fixtureDirectory);
    const imported = registry.findById("fixture-slot-game-a")!;
    const { recipeHash: _oldHash, ...definition } = imported;
    const learnedRecipe = materializeGameSaveRecipe({ ...definition, trust: "local_verified" });
    const managerRoot = await mkdtemp(path.join(os.tmpdir(), "save-learned-recipe-v2-"));
    temporaryDirectories.push(managerRoot);
    const store = await LearnedGameSaveRecipeStoreV2.create(managerRoot);
    const record = await store.save({
      schemaVersion: 2,
      learnedRecipeId: randomUUID(),
      recipe: learnedRecipe,
      gameRootFingerprint: "1".repeat(64),
      windowsUserIdentityHash: "2".repeat(64),
      resolverEvidenceHash: "3".repeat(64),
      probeHash: "4".repeat(64),
      saveRoot: path.join(managerRoot, "observed-save"),
      materializedPaths: ["auto.sav", "manual_0000.sav"],
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    expect((await store.get(record.learnedRecipeId)).recordHash).toBe(record.recordHash);
    expect(record.recipe.trust).toBe("local_verified");
  });

  it("rejects unsafe path patterns before they can become managed paths", () => {
    const valid = materializeGameSaveRecipe({
      schemaVersion: 2,
      recipeId: "safe-fixture",
      recipeVersion: "1",
      trust: "local_verified",
      game: {
        canonicalId: "safe-fixture",
        displayName: "Safe Fixture",
        aliases: [],
        platformAppIds: { manual: "safe-fixture" },
      },
      identity: {
        executableAnchors: ["Safe.exe"],
        productNames: ["Safe Fixture"],
        fileDescriptions: [],
      },
      installResolvers: ["manual-pe"],
      locationStrategies: [{ strategyId: "documents-product-name", parameters: {} }],
      saveUnits: [{
        unitId: "main",
        layoutFamily: "single-file",
        requiredAll: ["save.dat"],
        requiredAnyOf: [],
        companions: [],
        auxiliary: [],
        managedPatterns: ["save.dat"],
        maximumMatches: 1,
      }],
      binding: { policy: "unknown", evidenceScope: null },
      format: { kind: "opaque-files", adapterId: null },
      runtime: { processNames: ["Safe.exe"], lockSensitiveProcessNames: ["Safe.exe"] },
      sources: { nexusDomainName: null, speedrunGameSlug: null },
      evidence: [{
        kind: "local-probe",
        detail: "Test evidence.",
        source: null,
        observedAt: "2026-08-20T00:00:00.000Z",
      }],
      createdAt: "2026-08-20T00:00:00.000Z",
      verifiedAt: "2026-08-20T00:00:00.000Z",
    });
    const unsafe = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    delete unsafe.recipeHash;
    const saveUnits = unsafe.saveUnits as Array<Record<string, unknown>>;
    saveUnits[0]!.requiredAll = ["../save.dat"];
    saveUnits[0]!.managedPatterns = ["../save.dat"];
    expect(() => materializeGameSaveRecipe(unsafe)).toThrow();
  });

  it("hash-verifies an assessment and blocks undetermined replacement authorization", () => {
    const withoutHash = {
      schemaVersion: 2 as const,
      assessmentId: randomUUID(),
      saveContextId: randomUUID(),
      saveContextHash: zeroHash,
      packageId: "savepkg-fixture",
      packageManifestHash: zeroHash,
      intendedOperation: "cross-account-import" as const,
      selection: { sourceSlot: 0, targetSlot: 1, allowWholeUnitFallback: false },
      requirement: "undetermined" as const,
      adapterAvailability: "not_applicable" as const,
      extensionTarget: "format-adapter" as const,
      matchedAdapterId: null,
      scope: {
        gameCanonicalId: "fixture-game",
        recipeId: "fixture-recipe",
        recipeHash: zeroHash,
        distributionKind: "manual-pe" as const,
        installContextId: "a0d524e0-4db2-40f0-9988-f9fc9fc7f8fb",
        installContextHash: zeroHash,
        accountKind: "unknown" as const,
        accountValue: null,
        sourceKind: "manual" as const,
      },
      reasonCodes: ["ACCOUNT_BINDING_UNKNOWN"],
      genericCapabilitiesSatisfied: ["slot-file-mapping"],
      missingCapabilities: ["account-binding-proof"],
      evidence: [{
        kind: "static-inspection",
        detail: "No positive account-binding evidence is available.",
        confidence: "confirmed" as const,
      }],
      compatibilityAssessmentAllowed: true,
      replacementPlanAllowed: false,
      nextAction: "Research the account binding before planning a live replacement.",
      assessedAt: "2026-08-20T00:00:00.000Z",
    };
    const assessment = adapterRequirementAssessmentSchema.parse({
      ...withoutHash,
      assessmentHash: computeAdapterRequirementAssessmentHash(withoutHash),
    });
    expect(verifyAdapterRequirementAssessmentHash(assessment)).toBe(true);
    expect(() => adapterRequirementAssessmentSchema.parse({
      ...assessment,
      replacementPlanAllowed: true,
    })).toThrow();
  });
});
