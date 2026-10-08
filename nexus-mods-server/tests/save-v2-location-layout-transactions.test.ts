import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SaveService } from "../src/save/save-service.js";
import { verifySaveContextV2Hash } from "../src/save/v2/contracts.js";

const roots: string[] = [];

function gotPcV49Save(payloadByte: number): Buffer {
  const bytes = Buffer.alloc(0x220, payloadByte);
  bytes.writeUInt32LE(0x14e, 0);
  bytes.writeUInt32LE(bytes.length, 4);
  bytes.writeUInt32LE(49, 12);
  Buffer.from("6a4b716a45ed4447", "hex").copy(bytes, 0x180);
  Buffer.from("d5cf106b395e5d10", "hex").copy(bytes, 0x188);
  Buffer.from("bfe1bd115c5c51a2", "hex").copy(bytes, 0x190);
  let checksum = bytes.length + 0x14e + 49;
  for (let index = 0x10; index < bytes.length; index += 1) checksum += bytes[index]!;
  bytes.writeUInt32LE(checksum >>> 0, 8);
  return bytes;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("save V2 location, layout, backup, and restore", () => {
  it("resolves a RUNE Documents account root, freezes slot files, and restores a sandbox", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "save-v2-g3-g4-"));
    roots.push(root);
    const userProfile = path.join(root, "User");
    const gameRoot = path.join(root, "Game");
    const saveRoot = path.join(userProfile, "Documents", "Ghost of Tsushima DIRECTOR'S CUT", "76561197960271872");
    await Promise.all([
      mkdir(gameRoot, { recursive: true }),
      mkdir(path.join(saveRoot, "Screenshots"), { recursive: true }),
      mkdir(path.join(userProfile, "AppData", "Roaming"), { recursive: true }),
      mkdir(path.join(userProfile, "AppData", "Local"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(gameRoot, "GhostOfTsushima.exe"), "fixture exe"),
      writeFile(path.join(gameRoot, "steam_api64.rne"), "rune"),
      writeFile(path.join(gameRoot, "steam_emu.ini"), "AppId=2215430\n;AccountId=0\n"),
      writeFile(path.join(saveRoot, "auto.sav"), gotPcV49Save(0x11)),
      writeFile(path.join(saveRoot, "manual_0000.sav"), gotPcV49Save(0x22)),
      writeFile(path.join(saveRoot, "game.log"), "unmanaged"),
      writeFile(path.join(saveRoot, "Screenshots", "shot.png"), "unmanaged screenshot"),
    ]);
    let failAfterReplacementWrites: number | null = null;
    let replacementWriteCount = 0;
    const service = await SaveService.create({
      managerRoot: path.join(root, "manager"),
      environment: {
        platform: "win32",
        userProfile,
        username: "fixture",
        appData: path.join(userProfile, "AppData", "Roaming"),
        localAppData: path.join(userProfile, "AppData", "Local"),
      },
      peMetadataReader: async () => ({
        productName: "Ghost of Tsushima DIRECTOR'S CUT",
        fileDescription: "Ghost of Tsushima DIRECTOR'S CUT",
        fileVersion: "fixture",
        productVersion: "fixture",
      }),
      processGuard: async () => undefined,
      replacementFaultInjector: {
        checkpoint: async (checkpoint) => {
          if (checkpoint !== "after_target_write" || failAfterReplacementWrites === null) return;
          replacementWriteCount += 1;
          if (replacementWriteCount === failAfterReplacementWrites) {
            throw new Error("injected exact-unit replacement failure");
          }
        },
      },
    });
    const install = await service.probeGameInstall({ gameRoot, resolverHint: "rune-steam-emulator" });
    const context = await service.resolveSaveLocations(install.installContextId) as unknown as {
      schemaVersion: 2;
      saveContextId: string;
      contextHash: string;
      accountIdentity: { kind: string; value: string | null };
      saveRoots: Array<{ absolutePath: string }>;
      saveUnits: Array<{ unitId: string; layoutFamily: string; materializedFiles: Array<{ relativePath: string; slot: { index: number | null } | null }> }>;
    };

    expect(context.schemaVersion).toBe(2);
    expect(context.saveRoots[0]?.absolutePath).toBe(saveRoot);
    expect(context.accountIdentity).toEqual({
      kind: "opaque_directory_key",
      value: "76561197960271872",
      evidence: expect.any(String),
    });
    expect(context.saveUnits[0]).toMatchObject({
      unitId: "main-saves",
      layoutFamily: "slot-file-set",
      materializedFiles: [
        { relativePath: "auto.sav" },
        { relativePath: "manual_0000.sav", slot: { index: 0 } },
      ],
    });
    expect(JSON.stringify(context)).not.toContain("game.log");
    expect(JSON.stringify(context)).not.toContain("Screenshots");
    expect(verifySaveContextV2Hash(context as never)).toBe(true);

    const backup = await service.createSaveBackup({
      saveContextId: context.saveContextId,
      unitId: "main-saves",
      reason: "acceptance_baseline",
    });
    expect(backup.files.map((file) => file.relativePath)).toEqual(["auto.sav", "manual_0000.sav"]);
    expect((await service.verifySaveBackup(backup.backupId)).integrity).toBe("verified");

    const plan = await service.planSaveRestore({
      backupId: backup.backupId,
      saveContextId: context.saveContextId,
      mode: "exact_managed_snapshot",
      targetKind: "sandbox",
    });
    expect(plan.review?.nextAction).toBe("apply_now");
    const applied = await service.applySaveRestore(plan.restorePlanId);
    expect(await readFile(path.join(applied.targetAbsolutePath, "auto.sav"))).toEqual(gotPcV49Save(0x11));
    expect(await readFile(path.join(applied.targetAbsolutePath, "manual_0000.sav"))).toEqual(gotPcV49Save(0x22));
    expect((await service.verifySaveRestore(applied.record.recordId)).staticVerification).toBe("passed");

    const externalRoot = path.join(root, "downloaded-save", "GoT 100 percent");
    await mkdir(externalRoot, { recursive: true });
    await Promise.all([
      writeFile(path.join(externalRoot, "manual_0028.sav"), gotPcV49Save(0x44)),
      writeFile(path.join(externalRoot, "README.txt"), "author claim only"),
    ]);
    const inspection = await service.inspectSaveInput(path.dirname(externalRoot), {
      saveContextId: context.saveContextId,
      unitId: "main-saves",
    });
    expect(inspection.payloadCandidates).toHaveLength(1);
    expect(inspection.payloadCandidates[0]).toMatchObject({
      root: "GoT 100 percent",
      unitId: "main-saves",
      layoutFamily: "slot-file-set",
      files: [
        { sourcePath: "GoT 100 percent/manual_0028.sav", relativePath: "manual_0028.sav", slot: { index: 28 } },
      ],
    });
    expect(JSON.stringify(inspection.payloadCandidates)).not.toContain("README.txt");
    const normalized = await service.normalizeSavePackage({
      inspectionId: inspection.inspectionId,
      payloadSelectionId: inspection.payloadCandidates[0]!.payloadSelectionId,
    }) as unknown as {
      schemaVersion: 2;
      packageId: string;
      manifestHash: string;
      unitId: string;
      layoutFamily: string;
      payload: { files: Array<{ sourcePath: string; relativePath: string }> };
      binding: { kind: string };
    };
    expect(normalized).toMatchObject({
      schemaVersion: 2,
      unitId: "main-saves",
      layoutFamily: "slot-file-set",
      binding: { kind: "unknown" },
    });
    expect(normalized.payload.files[0]).toHaveProperty("sourcePath");
    expect(await service.verifyStandardSavePackage(normalized.packageId)).toEqual(normalized);
    const backupRequirement = await service.assessSaveAdapterRequirement({
      saveContextId: context.saveContextId,
      intendedOperation: "backup",
    });
    expect(backupRequirement).toMatchObject({
      assessment: {
        requirement: "not_required",
        adapterAvailability: "not_applicable",
        extensionTarget: "none",
        reasonCodes: ["OPAQUE_BACKUP"],
        compatibilityAssessmentAllowed: false,
        replacementPlanAllowed: false,
      },
      developmentBrief: null,
    });
    expect(await service.getSaveAdapterRequirementAssessment(backupRequirement.assessment.assessmentId))
      .toEqual(backupRequirement.assessment);

    const replacementRequirement = await service.assessSaveAdapterRequirement({
      saveContextId: context.saveContextId,
      packageId: normalized.packageId,
      intendedOperation: "replace-whole-unit",
    });
    expect(replacementRequirement).toMatchObject({
      assessment: {
        requirement: "required",
        adapterAvailability: "matched",
        extensionTarget: "format-adapter",
        matchedAdapterId: "ghost-of-tsushima-pc-v49",
        reasonCodes: ["FORMAT_ADAPTER_VALIDATED_EXACT_REPLACEMENT"],
        compatibilityAssessmentAllowed: true,
        replacementPlanAllowed: true,
        scope: {
          gameCanonicalId: "ghost-of-tsushima-directors-cut",
          distributionKind: "rune-steam-emulator",
          accountKind: "opaque_directory_key",
        },
      },
      developmentBrief: null,
    });
    expect(replacementRequirement.assessment.evidence.filter((item) => item.kind === "adapter-format-validation")).toHaveLength(3);

    const versionRequirement = await service.assessSaveAdapterRequirement({
      saveContextId: context.saveContextId,
      packageId: normalized.packageId,
      intendedOperation: "version-conversion",
    });
    expect(versionRequirement.assessment).toMatchObject({
      requirement: "required",
      adapterAvailability: "missing",
      extensionTarget: "format-adapter",
      reasonCodes: ["VERSION_CONVERSION_REQUIRED"],
      replacementPlanAllowed: false,
    });
    expect(versionRequirement.developmentBrief).toMatchObject({
      assessmentId: versionRequirement.assessment.assessmentId,
      game: { canonicalId: "ghost-of-tsushima-directors-cut" },
      distributionKind: "rune-steam-emulator",
      intendedOperation: "version-conversion",
      requiredCapabilities: ["version-migration", "post-migration-format-verification"],
    });
    expect(await service.getSaveAdapterDevelopmentBrief(versionRequirement.developmentBrief!.briefId))
      .toEqual(versionRequirement.developmentBrief);
    const compatibility = await service.assessSavePackageCompatibility({
      packageId: normalized.packageId,
      saveContextId: context.saveContextId,
    }) as unknown as {
      schemaVersion: 2;
      state: string;
      replacementPlanAllowed: boolean;
      targetMappings: Array<{ targetRelativePath: string }>;
    };
    expect(compatibility).toMatchObject({
      schemaVersion: 2,
      state: "compatible_direct",
      replacementPlanAllowed: true,
      adapterRequirementAssessmentId: expect.any(String),
      adapterRequirementAssessmentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(compatibility.targetMappings.map((mapping) => mapping.targetRelativePath)).toEqual([
      "manual_0028.sav",
    ]);
    const replacementPlan = await service.planSaveReplacement({
      assessmentId: (compatibility as unknown as { assessmentId: string }).assessmentId,
      strategy: "direct_replace",
    });
    expect(replacementPlan).toMatchObject({
      rescueUnitId: "main-saves",
      adapterId: "ghost-of-tsushima-pc-v49",
      strategy: "direct_replace",
      replacementMode: "exact-unit",
      operations: [
        { kind: "delete-file", targetRelativePath: "auto.sav" },
        { kind: "delete-file", targetRelativePath: "manual_0000.sav" },
        { kind: "create-file", targetRelativePath: "manual_0028.sav" },
      ],
    });
    const replaced = await service.applySaveReplacement(replacementPlan.replacementPlanId);
    expect(replaced.record.staticVerification).toBe("passed");
    expect(replaced.rescueBackupId).toEqual(expect.any(String));
    await expect(readFile(path.join(saveRoot, "auto.sav"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(saveRoot, "manual_0000.sav"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(saveRoot, "manual_0028.sav"))).toEqual(gotPcV49Save(0x44));
    expect((await service.verifySaveReplacement(replaced.record.recordId)).staticVerification).toBe("passed");

    const baselineRestore = await service.planSaveRestore({
      backupId: backup.backupId,
      saveContextId: context.saveContextId,
      mode: "exact_managed_snapshot",
      targetKind: "save-context",
    });
    const restored = await service.applySaveRestore(baselineRestore.restorePlanId);
    expect((await service.verifySaveRestore(restored.record.recordId)).staticVerification).toBe("passed");
    expect(await readFile(path.join(saveRoot, "auto.sav"))).toEqual(gotPcV49Save(0x11));
    expect(await readFile(path.join(saveRoot, "manual_0000.sav"))).toEqual(gotPcV49Save(0x22));
    await expect(readFile(path.join(saveRoot, "manual_0028.sav"))).rejects.toMatchObject({ code: "ENOENT" });

    const rollbackPlan = await service.planSaveReplacement({
      assessmentId: (compatibility as unknown as { assessmentId: string }).assessmentId,
      strategy: "direct_replace",
    });
    failAfterReplacementWrites = 3;
    replacementWriteCount = 0;
    await expect(service.applySaveReplacement(rollbackPlan.replacementPlanId))
      .rejects.toThrow("injected exact-unit replacement failure");
    expect(await readFile(path.join(saveRoot, "auto.sav"))).toEqual(gotPcV49Save(0x11));
    expect(await readFile(path.join(saveRoot, "manual_0000.sav"))).toEqual(gotPcV49Save(0x22));
    await expect(readFile(path.join(saveRoot, "manual_0028.sav"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses Recipe-scoped Windows roots for a bounded differential fallback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "save-v2-differential-"));
    roots.push(root);
    const userProfile = path.join(root, "User");
    const gameRoot = path.join(root, "Game");
    await Promise.all([
      mkdir(gameRoot, { recursive: true }),
      mkdir(path.join(userProfile, "AppData", "Roaming"), { recursive: true }),
      mkdir(path.join(userProfile, "AppData", "Local"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(gameRoot, "GhostOfTsushima.exe"), "fixture exe"),
      writeFile(path.join(gameRoot, "steam_api64.rne"), "rune"),
      writeFile(path.join(gameRoot, "steam_emu.ini"), "AppId=2215430\n"),
    ]);
    const service = await SaveService.create({
      managerRoot: path.join(root, "manager"),
      environment: {
        platform: "win32",
        userProfile,
        username: "fixture",
        appData: path.join(userProfile, "AppData", "Roaming"),
        localAppData: path.join(userProfile, "AppData", "Local"),
      },
      peMetadataReader: async () => ({ productName: "Ghost of Tsushima DIRECTOR'S CUT", fileDescription: null, fileVersion: "fixture", productVersion: "fixture" }),
    });
    const install = await service.probeGameInstall({ gameRoot, resolverHint: "rune-steam-emulator" });
    const probe = await service.beginSaveLocationProbe(install.installContextId);
    expect(probe.observationRoots).toEqual([
      path.join(userProfile, "Documents", "Ghost of Tsushima DIRECTOR'S CUT"),
    ]);
    const learnedRoot = path.join(probe.observationRoots[0]!, "opaque-account");
    await mkdir(learnedRoot, { recursive: true });
    await writeFile(path.join(learnedRoot, "manual_0003.sav"), "new save");
    const completed = await service.completeSaveLocationProbe(probe.probeId);
    expect(completed.learnedProfile).toMatchObject({
      state: "local_verified",
      saveRoot: learnedRoot,
      observedRelativePaths: ["manual_0003.sav"],
    });
    expect(completed.saveContext?.verification).toMatchObject({ state: "confirmed", method: "differential-probe" });
  });
});
