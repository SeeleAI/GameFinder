import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sha256CanonicalJson } from "../src/install/content-hash.js";
import { SaveBackupService } from "../src/save/backup/save-backup-service.js";
import type { SaveContext } from "../src/save/contracts.js";
import { saveContextSchema } from "../src/save/contracts.js";
import { SaveInputInspector } from "../src/save/package/input-inspector.js";
import { SavePackageNormalizer } from "../src/save/package/package-normalizer.js";
import { GameSaveProfileRegistry } from "../src/save/profiles/registry.js";
import { SaveCompatibilityAssessor } from "../src/save/replacement/compatibility-assessor.js";
import {
  type SaveReplacementFaultInjector,
  SaveReplacementService,
} from "../src/save/replacement/save-replacement-service.js";
import { SaveRestoreService } from "../src/save/restore/save-restore-service.js";
import { SaveContextStore } from "../src/save/storage/context-store.js";
import {
  gameInstallContextFixture,
  saveContextFixture,
} from "./fixtures/save-contract-fixtures.js";

const temporaryDirectories: string[] = [];

async function createFixture(options: {
  packageAccount?: string;
  processGuard?: (names: ReadonlyArray<string>) => Promise<void>;
  faultInjector?: SaveReplacementFaultInjector;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "save-m3-replacement-"));
  temporaryDirectories.push(root);
  const managerRoot = path.join(root, "manager");
  const saveRoot = path.join(root, "live-save");
  const packageInput = path.join(root, "manual-input");
  const wrapper = path.join(packageInput, options.packageAccount ?? "76561198127396738");
  await Promise.all([
    mkdir(saveRoot, { recursive: true }),
    mkdir(wrapper, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(saveRoot, "ER0000.sl2"), "current-primary"),
    writeFile(path.join(saveRoot, "ER0000.sl2.bak"), "current-companion"),
    writeFile(path.join(saveRoot, "steam_autocloud.vdf"), "current-cloud"),
    writeFile(path.join(wrapper, "ER0000.sl2"), "old-primary"),
    writeFile(path.join(wrapper, "ER0000.sl2.bak"), "old-companion"),
    writeFile(path.join(wrapper, "steam_autocloud.vdf"), "current-cloud"),
  ]);
  const contexts = await SaveContextStore.create(managerRoot);
  const install = gameInstallContextFixture();
  await contexts.saveInstallContext(install);
  const base = saveContextFixture(install.installContextId);
  const { contextHash: _oldHash, ...withoutOldHash } = base;
  const withoutHash = {
    ...withoutOldHash,
    saveRoots: [{ rootId: "primary", absolutePath: saveRoot, role: "primary" as const }],
  };
  const context: SaveContext = saveContextSchema.parse({
    ...withoutHash,
    contextHash: sha256CanonicalJson(withoutHash),
  });
  await contexts.saveSaveContext(context);
  const profiles = new GameSaveProfileRegistry();
  const backups = await SaveBackupService.create({
    managerRoot,
    contexts,
    profiles,
    processGuard: options.processGuard ?? (async () => undefined),
  });
  const inspector = await SaveInputInspector.create({ managerRoot, rarCapability: null });
  const packages = await SavePackageNormalizer.create({ managerRoot, inspector });
  const inspection = await inspector.inspect(packageInput);
  const savePackage = await packages.normalize({
    inspectionId: inspection.inspectionId,
    payloadSelectionId: inspection.payloadCandidates[0]!.payloadSelectionId,
  });
  const assessments = await SaveCompatibilityAssessor.create({
    managerRoot,
    contexts,
    packages,
  });
  const replacements = await SaveReplacementService.create({
    managerRoot,
    contexts,
    packages,
    assessments,
    backups,
    ...(options.faultInjector === undefined
      ? {}
      : { faultInjector: options.faultInjector }),
  });
  const restores = await SaveRestoreService.create({
    managerRoot,
    contexts,
    backups,
  });
  return {
    root,
    managerRoot,
    saveRoot,
    context,
    backups,
    packages,
    savePackage,
    assessments,
    replacements,
    restores,
  };
}

async function contents(saveRoot: string) {
  return await Promise.all(
    ["ER0000.sl2", "ER0000.sl2.bak", "steam_autocloud.vdf"].map(
      async (name) => [name, await readFile(path.join(saveRoot, name), "utf8")] as const,
    ),
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(
      async (directory) => await rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("save M3 compatibility", () => {
  it("allows direct replacement only when game, format, paths, and SteamID64 match", async () => {
    const fixture = await createFixture();
    const assessment = await fixture.assessments.assess({
      packageId: fixture.savePackage.packageId,
      saveContextId: fixture.context.saveContextId,
    });
    expect(assessment).toMatchObject({
      state: "compatible_direct",
      recommendedStrategy: "direct_replace",
    });
    const plan = await fixture.replacements.planReplacement({
      assessmentId: assessment.assessmentId,
      strategy: "direct_replace",
    });
    expect(plan.operations.map((operation) => operation.targetRelativePath)).toEqual([
      "ER0000.sl2",
      "ER0000.sl2.bak",
    ]);
    expect(plan.payloadPolicies.map((policy) => [policy.relativePath, policy.action])).toEqual([
      ["ER0000.sl2", "replace"],
      ["ER0000.sl2.bak", "replace"],
      ["steam_autocloud.vdf", "preserve-identical"],
    ]);
    expect(await contents(fixture.saveRoot)).toEqual([
      ["ER0000.sl2", "current-primary"],
      ["ER0000.sl2.bak", "current-companion"],
      ["steam_autocloud.vdf", "current-cloud"],
    ]);
  });

  it("routes a different Elden Ring SteamID64 to slot import instead of a direct plan", async () => {
    const fixture = await createFixture({ packageAccount: "76561198000000000" });
    const assessment = await fixture.assessments.assess({
      packageId: fixture.savePackage.packageId,
      saveContextId: fixture.context.saveContextId,
    });
    expect(assessment.state).toBe("compatible_with_slot_import");
    expect(assessment.recommendedStrategy).toBe("slot_import");
    await expect(
      fixture.replacements.planReplacement({
        assessmentId: assessment.assessmentId,
        strategy: "direct_replace",
      }),
    ).rejects.toMatchObject({ code: "SAVE_ADAPTER_UNSUPPORTED" });
  });
});

describe("save M3 replacement transaction", () => {
  it("defaults to auto-safe and supports an explicit always-review override", async () => {
    const fixture = await createFixture();
    const assessment = await fixture.assessments.assess({
      packageId: fixture.savePackage.packageId,
      saveContextId: fixture.context.saveContextId,
    });
    const automatic = await fixture.replacements.planReplacement({
      assessmentId: assessment.assessmentId,
      strategy: "direct_replace",
    });
    expect(automatic.review).toMatchObject({
      classification: "auto_safe",
      nextAction: "apply_now",
      requestScope: { mode: "auto_safe", action: "replace" },
    });
    const reviewed = await fixture.replacements.planReplacement({
      assessmentId: assessment.assessmentId,
      strategy: "direct_replace",
      reviewMode: "always_review",
    });
    expect(reviewed.review).toMatchObject({
      classification: "review_required",
      nextAction: "request_confirmation",
      requestScope: { mode: "always_review", action: "replace" },
    });
  });

  it("creates a rescue, replaces all planned files, verifies, and replays idempotently", async () => {
    const fixture = await createFixture();
    const assessment = await fixture.assessments.assess({
      packageId: fixture.savePackage.packageId,
      saveContextId: fixture.context.saveContextId,
    });
    const plan = await fixture.replacements.planReplacement({
      assessmentId: assessment.assessmentId,
      strategy: "direct_replace",
    });
    const applied = await fixture.replacements.applyReplacement(plan.replacementPlanId);
    expect(applied.idempotentReplay).toBe(false);
    expect(await contents(fixture.saveRoot)).toEqual([
      ["ER0000.sl2", "old-primary"],
      ["ER0000.sl2.bak", "old-companion"],
      ["steam_autocloud.vdf", "current-cloud"],
    ]);
    expect(await fixture.replacements.verifyReplacement(applied.record.recordId)).toEqual(applied.record);
    const rescue = await fixture.backups.getBackup(applied.rescueBackupId);
    expect(rescue.reason).toBe("pre_replacement_rescue");
    const replay = await fixture.replacements.applyReplacement(plan.replacementPlanId);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.record).toEqual(applied.record);
  });

  it("rolls back exactly when replacement fails after a target write", async () => {
    let injected = false;
    const fixture = await createFixture({
      faultInjector: {
        checkpoint: async (checkpoint) => {
          if (!injected && checkpoint === "after_target_write") {
            injected = true;
            throw new Error("replacement fault");
          }
        },
      },
    });
    const before = await contents(fixture.saveRoot);
    const assessment = await fixture.assessments.assess({
      packageId: fixture.savePackage.packageId,
      saveContextId: fixture.context.saveContextId,
    });
    const plan = await fixture.replacements.planReplacement({
      assessmentId: assessment.assessmentId,
      strategy: "direct_replace",
    });
    await expect(fixture.replacements.applyReplacement(plan.replacementPlanId))
      .rejects.toThrow("replacement fault");
    expect(await contents(fixture.saveRoot)).toEqual(before);
  });

  it("performs zero target writes if pre-replacement rescue creation fails", async () => {
    let guardCalls = 0;
    const fixture = await createFixture({
      processGuard: async () => {
        guardCalls += 1;
        if (guardCalls === 1) throw new Error("process running");
      },
    });
    const before = await contents(fixture.saveRoot);
    const assessment = await fixture.assessments.assess({
      packageId: fixture.savePackage.packageId,
      saveContextId: fixture.context.saveContextId,
    });
    const plan = await fixture.replacements.planReplacement({
      assessmentId: assessment.assessmentId,
      strategy: "direct_replace",
    });
    await expect(fixture.replacements.applyReplacement(plan.replacementPlanId))
      .rejects.toMatchObject({ code: "SAVE_RESCUE_BACKUP_FAILED" });
    expect(await contents(fixture.saveRoot)).toEqual(before);
  });

  it("completes the baseline -> old package -> baseline static recovery loop", async () => {
    const fixture = await createFixture();
    const baseline = await fixture.backups.createBackup({
      saveContextId: fixture.context.saveContextId,
      unitId: "vanilla-main",
      reason: "acceptance_baseline",
    });
    const assessment = await fixture.assessments.assess({
      packageId: fixture.savePackage.packageId,
      saveContextId: fixture.context.saveContextId,
    });
    const replacementPlan = await fixture.replacements.planReplacement({
      assessmentId: assessment.assessmentId,
      strategy: "direct_replace",
    });
    await fixture.replacements.applyReplacement(replacementPlan.replacementPlanId);
    const restorePlan = await fixture.restores.planRestore({
      backupId: baseline.backupId,
      saveContextId: fixture.context.saveContextId,
      mode: "exact_managed_snapshot",
    });
    await fixture.restores.applyRestore(restorePlan.restorePlanId);
    expect(await contents(fixture.saveRoot)).toEqual([
      ["ER0000.sl2", "current-primary"],
      ["ER0000.sl2.bak", "current-companion"],
      ["steam_autocloud.vdf", "current-cloud"],
    ]);
  });
});
