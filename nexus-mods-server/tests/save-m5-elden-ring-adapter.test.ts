import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sha256CanonicalJson } from "../src/install/content-hash.js";
import { sha256File } from "../src/install/file-hash.js";
import { EldenRingSlotImportService } from "../src/save/adapters/elden-ring-slot-import-service.js";
import { SaveBackupService } from "../src/save/backup/save-backup-service.js";
import {
  analyzeEldenRingBuffer,
  ELDEN_RING_SL2,
  slotChecksumStart,
  slotDataStart,
  slotSummaryStart,
} from "../src/save/adapters/elden-ring-steam-pc.js";
import type { SaveContext } from "../src/save/contracts.js";
import { saveContextSchema } from "../src/save/contracts.js";
import { SaveInputInspector } from "../src/save/package/input-inspector.js";
import { SavePackageNormalizer } from "../src/save/package/package-normalizer.js";
import { GameSaveProfileRegistry } from "../src/save/profiles/registry.js";
import { SaveCompatibilityAssessor } from "../src/save/replacement/compatibility-assessor.js";
import { SaveReplacementService } from "../src/save/replacement/save-replacement-service.js";
import { SaveContextStore } from "../src/save/storage/context-store.js";
import { gameInstallContextFixture, saveContextFixture } from "./fixtures/save-contract-fixtures.js";

const temporaryDirectories: string[] = [];
const TARGET_ID = "76561198127396738";
const SOURCE_ID = "76561198396506719";

function md5(buffer: Buffer): Buffer { return createHash("md5").update(buffer).digest(); }

function writeName(buffer: Buffer, slot: number, name: string, level: number, seconds: number): void {
  const start = slotSummaryStart(slot);
  Buffer.from(`${name}\0`, "utf16le").copy(buffer, start, 0, ELDEN_RING_SL2.characterNameLength);
  buffer[start + ELDEN_RING_SL2.characterLevelOffset] = level;
  buffer.writeInt32LE(seconds, start + ELDEN_RING_SL2.secondsPlayedOffset);
}

function createSave(steamId64: string, active: Array<{ slot: number; name: string; level: number }>): Buffer {
  const buffer = Buffer.alloc(ELDEN_RING_SL2.bytes);
  buffer.write("BND4", 0, "ascii");
  buffer.writeBigUInt64LE(BigInt(steamId64), ELDEN_RING_SL2.accountIdOffset);
  const id = Buffer.alloc(8); id.writeBigUInt64LE(BigInt(steamId64));
  for (const item of active) {
    buffer[ELDEN_RING_SL2.activeSlotsOffset + item.slot] = 1;
    id.copy(buffer, slotDataStart(item.slot) + 0x12340 + item.slot);
    buffer.writeUInt32LE(0xa0b0c000 + item.slot, slotDataStart(item.slot) + 0x400);
    writeName(buffer, item.slot, item.name, item.level, 3_600 + item.slot);
  }
  for (let slot = 0; slot < ELDEN_RING_SL2.slotCount; slot += 1) {
    const data = buffer.subarray(slotDataStart(slot), slotDataStart(slot) + ELDEN_RING_SL2.slotDataLength);
    md5(data).copy(buffer, slotChecksumStart(slot));
  }
  md5(buffer.subarray(
    ELDEN_RING_SL2.headerSectionStart,
    ELDEN_RING_SL2.headerSectionStart + ELDEN_RING_SL2.headerSectionLength,
  )).copy(buffer, ELDEN_RING_SL2.headerChecksumStart);
  return buffer;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "save-m5-er-"));
  temporaryDirectories.push(root);
  const managerRoot = path.join(root, "manager");
  const saveRoot = path.join(root, "live");
  const packageRoot = path.join(root, "package", SOURCE_ID);
  await Promise.all([mkdir(saveRoot, { recursive: true }), mkdir(packageRoot, { recursive: true })]);
  const targetPath = path.join(saveRoot, "ER0000.sl2");
  const sourcePath = path.join(packageRoot, "ER0000.sl2");
  await Promise.all([
    writeFile(targetPath, createSave(TARGET_ID, [{ slot: 0, name: "WhiteFur", level: 41 }])),
    writeFile(path.join(saveRoot, "ER0000.sl2.bak"), createSave(TARGET_ID, [{ slot: 0, name: "WhiteFur", level: 41 }])),
    writeFile(path.join(saveRoot, "steam_autocloud.vdf"), "cloud-baseline"),
    writeFile(sourcePath, createSave(SOURCE_ID, [{ slot: 7, name: "Bly", level: 200 }, { slot: 9, name: "Itzuri", level: 200 }])),
  ]);
  const contexts = await SaveContextStore.create(managerRoot);
  const install = gameInstallContextFixture();
  await contexts.saveInstallContext(install);
  const base = saveContextFixture(install.installContextId);
  const { contextHash: _old, ...baseWithoutHash } = base;
  const withoutHash = { ...baseWithoutHash, saveRoots: [{ rootId: "primary", absolutePath: saveRoot, role: "primary" as const }] };
  const context: SaveContext = saveContextSchema.parse({ ...withoutHash, contextHash: sha256CanonicalJson(withoutHash) });
  await contexts.saveSaveContext(context);
  const inspector = await SaveInputInspector.create({ managerRoot, rarCapability: null });
  const packages = await SavePackageNormalizer.create({ managerRoot, inspector });
  const inspection = await inspector.inspect(path.join(root, "package"));
  const savePackage = await packages.normalize({
    inspectionId: inspection.inspectionId,
    payloadSelectionId: inspection.payloadCandidates[0]!.payloadSelectionId,
  });
  const service = await EldenRingSlotImportService.create({ managerRoot, contexts, packages });
  const backups = await SaveBackupService.create({
    managerRoot, contexts, profiles: new GameSaveProfileRegistry(), processGuard: async () => undefined,
  });
  const assessments = await SaveCompatibilityAssessor.create({ managerRoot, contexts, packages });
  const replacements = await SaveReplacementService.create({
    managerRoot, contexts, packages, assessments, backups, eldenRingSlots: service,
  });
  return { root, managerRoot, saveRoot, targetPath, sourcePath, context, savePackage, service, backups, assessments, replacements, packages, contexts };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("M5 Elden Ring Steam PC adapter", () => {
  it("deeply parses ten slots and verifies every slot/header checksum", async () => {
    const f = await fixture();
    const analysis = await f.service.analyzePackage(f.savePackage.packageId);
    expect(analysis).toMatchObject({ bytes: 28_967_888, containerMagic: "BND4", steamId64: SOURCE_ID, headerChecksumValid: true });
    expect(analysis.slots).toHaveLength(10);
    expect(analysis.slots.filter((slot) => slot.active).map((slot) => [slot.slotIndex, slot.characterName, slot.level]))
      .toEqual([[7, "Bly", 200], [9, "Itzuri", 200]]);
    expect(analysis.slots.every((slot) => slot.checksumValid)).toBe(true);
  });

  it("plans an empty-slot import and creates only a verified staging save", async () => {
    const f = await fixture();
    const beforeHash = await sha256File(f.targetPath);
    const targetBefore = await readFile(f.targetPath);
    const plan = await f.service.plan({ packageId: f.savePackage.packageId, saveContextId: f.context.saveContextId });
    expect(plan).toMatchObject({ sourceSlot: 7, targetSlot: 1, overwriteOccupiedTarget: false, sourceSteamId64: SOURCE_ID, targetSteamId64: TARGET_ID });
    expect(plan.preservedSlotIndexes).not.toContain(1);
    const staged = await f.service.stage(plan.slotImportPlanId);
    expect(await sha256File(f.targetPath)).toBe(beforeHash);
    expect(staged).toMatchObject({ sourceSlot: 7, targetSlot: 1, reboundAccountOccurrences: 1, allowedByteRangeVerification: "passed", checksumVerification: "passed", unselectedSlotsVerification: "passed" });
    const stagedBytes = await readFile(staged.stagedPath);
    const analysis = analyzeEldenRingBuffer(stagedBytes, { kind: "path", referenceId: staged.stagedImportId, absolutePath: staged.stagedPath }, staged.stagedSha256);
    expect(analysis.steamId64).toBe(TARGET_ID);
    expect(analysis.slots[1]).toMatchObject({ active: true, characterName: "Bly", level: 200 });
    expect(stagedBytes.subarray(slotChecksumStart(0), slotDataStart(0) + ELDEN_RING_SL2.slotDataLength))
      .toEqual(targetBefore.subarray(slotChecksumStart(0), slotDataStart(0) + ELDEN_RING_SL2.slotDataLength));
    await expect(f.service.verifyStage(staged.stagedImportId)).resolves.toMatchObject({ stagedImportId: staged.stagedImportId });
  }, 20_000);

  it("fails closed on corruption, occupied targets without consent, and target drift", async () => {
    const f = await fixture();
    const corrupted = await readFile(f.sourcePath);
    corrupted[slotDataStart(7) + 10] = (corrupted[slotDataStart(7) + 10] ?? 0) ^ 0xff;
    expect(() => analyzeEldenRingBuffer(corrupted, { kind: "path", referenceId: null, absolutePath: f.sourcePath }, "a".repeat(64)))
      .toThrowError(expect.objectContaining({ code: "SAVE_FORMAT_INVALID" }));
    await expect(f.service.plan({ packageId: f.savePackage.packageId, saveContextId: f.context.saveContextId, targetSlot: 0 }))
      .rejects.toMatchObject({ code: "SAVE_SLOT_SELECTION_REQUIRED" });
    const plan = await f.service.plan({ packageId: f.savePackage.packageId, saveContextId: f.context.saveContextId });
    const target = await readFile(f.targetPath);
    target[slotDataStart(0) + 100] = (target[slotDataStart(0) + 100] ?? 0) ^ 1;
    await writeFile(f.targetPath, target);
    await expect(f.service.stage(plan.slotImportPlanId)).rejects.toMatchObject({ code: "SAVE_FORMAT_INVALID" });
  });

  it("freezes and transactionally applies a staged slot import with a rescue backup", async () => {
    const f = await fixture();
    const companionPath = path.join(f.saveRoot, "ER0000.sl2.bak");
    const cloudPath = path.join(f.saveRoot, "steam_autocloud.vdf");
    const [companionBefore, cloudBefore] = await Promise.all([sha256File(companionPath), sha256File(cloudPath)]);
    const slotPlan = await f.service.plan({ packageId: f.savePackage.packageId, saveContextId: f.context.saveContextId });
    const staged = await f.service.stage(slotPlan.slotImportPlanId);
    const replacementPlan = await f.replacements.planStagedSlotImport(staged.stagedImportId);
    expect(replacementPlan).toMatchObject({
      strategy: "slot_import", sourceSlot: 7, targetSlot: 1,
      stagedImportId: staged.stagedImportId, slotImportPlanId: slotPlan.slotImportPlanId,
    });
    expect(replacementPlan.payloadPolicies).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "ER0000.sl2.bak", action: "preserve-identical" }),
      expect.objectContaining({ relativePath: "steam_autocloud.vdf", action: "preserve-identical" }),
    ]));
    const applied = await f.replacements.applyReplacement(replacementPlan.replacementPlanId);
    expect(applied.record.staticVerification).toBe("passed");
    await expect(f.backups.verifyBackup(applied.rescueBackupId)).resolves.toMatchObject({ reason: "pre_replacement_rescue" });
    expect(await sha256File(f.targetPath)).toBe(staged.stagedSha256);
    expect(await sha256File(companionPath)).toBe(companionBefore);
    expect(await sha256File(cloudPath)).toBe(cloudBefore);
    await expect(f.replacements.verifyReplacement(applied.record.recordId)).resolves.toMatchObject({ recordId: applied.record.recordId });
  }, 20_000);

  it("rolls a slot import back when failure is injected after the target write", async () => {
    const f = await fixture();
    const before = await sha256File(f.targetPath);
    const slotPlan = await f.service.plan({ packageId: f.savePackage.packageId, saveContextId: f.context.saveContextId });
    const staged = await f.service.stage(slotPlan.slotImportPlanId);
    const replacementPlan = await f.replacements.planStagedSlotImport(staged.stagedImportId);
    const faulting = await SaveReplacementService.create({
      managerRoot: f.managerRoot,
      contexts: f.contexts,
      packages: f.packages,
      assessments: f.assessments,
      backups: f.backups,
      eldenRingSlots: f.service,
      faultInjector: {
        async checkpoint(checkpoint) {
          if (checkpoint === "after_target_write") throw new Error("injected M6 failure");
        },
      },
    });
    await expect(faulting.applyReplacement(replacementPlan.replacementPlanId)).rejects.toThrow("injected M6 failure");
    expect(await sha256File(f.targetPath)).toBe(before);
  }, 20_000);
});
