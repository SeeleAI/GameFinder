import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import { sha256File } from "../../install/file-hash.js";
import type {
  EldenRingSaveAnalysis,
  EldenRingSlotImportPlan,
  EldenRingStagedImport,
  SaveContext,
} from "../contracts.js";
import { eldenRingSlotImportPlanSchema, eldenRingStagedImportSchema } from "../contracts.js";
import type { SavePackageNormalizer } from "../package/package-normalizer.js";
import type { SaveContextStore } from "../storage/context-store.js";
import {
  analyzeEldenRingBuffer,
  analyzeEldenRingFile,
  assertChangesAllowed,
  ELDEN_RING_SL2,
  importEldenRingSlot,
  slotChecksumStart,
  slotDataStart,
  slotSummaryStart,
  summarizeAllowedChanges,
} from "./elden-ring-steam-pc.js";
import { EldenRingSlotImportStore } from "./elden-ring-slot-import-store.js";

export class EldenRingSlotImportService {
  readonly #contexts: SaveContextStore;
  readonly #packages: SavePackageNormalizer;
  readonly #store: EldenRingSlotImportStore;
  readonly #planTtlMs: number;

  private constructor(input: { contexts: SaveContextStore; packages: SavePackageNormalizer; store: EldenRingSlotImportStore; planTtlMs: number }) {
    this.#contexts = input.contexts;
    this.#packages = input.packages;
    this.#store = input.store;
    this.#planTtlMs = input.planTtlMs;
  }

  static async create(options: { managerRoot: string; contexts: SaveContextStore; packages: SavePackageNormalizer; planTtlMs?: number }): Promise<EldenRingSlotImportService> {
    return new EldenRingSlotImportService({
      contexts: options.contexts,
      packages: options.packages,
      store: await EldenRingSlotImportStore.create(options.managerRoot),
      planTtlMs: options.planTtlMs ?? 30 * 60_000,
    });
  }

  async analyzePath(absolutePath: string): Promise<Readonly<EldenRingSaveAnalysis>> {
    const { analysis } = await analyzeEldenRingFile(absolutePath, { kind: "path", referenceId: null });
    return await this.#store.saveAnalysis(analysis);
  }

  async analyzePackage(packageId: string): Promise<Readonly<EldenRingSaveAnalysis>> {
    const savePackage = await this.#packages.verify(packageId);
    this.#assertEldenPackage(savePackage.game.canonicalId, savePackage.format.adapterHint);
    const payload = savePackage.payload.files.filter((file) => file.relativePath.toLowerCase() === "er0000.sl2");
    if (payload.length !== 1) throw new NexusError("SAVE_FORMAT_INVALID", "Package must contain exactly one root ER0000.sl2 payload.");
    const object = await this.#packages.objectStore.get(payload[0]!.objectId);
    if (object.objectKind !== "file") throw new NexusError("SAVE_FORMAT_INVALID", "ER0000.sl2 package object is not a file.");
    const { analysis } = await analyzeEldenRingFile(object.absolutePath, { kind: "package", referenceId: packageId });
    if (analysis.fileSha256 !== payload[0]!.sha256) throw new NexusError("SAVE_PACKAGE_INVALID", "Analyzed ER0000.sl2 differs from the package manifest.");
    return await this.#store.saveAnalysis(analysis);
  }

  async analyzeContext(saveContextId: string): Promise<Readonly<EldenRingSaveAnalysis>> {
    const context = await this.#contexts.getSaveContext(saveContextId);
    const savePath = this.#targetPath(context);
    const { analysis } = await analyzeEldenRingFile(savePath, { kind: "save-context", referenceId: saveContextId });
    const account = context.storeAccount;
    if (account?.kind !== "steam_id64" || account.value !== analysis.steamId64) {
      throw new NexusError("SAVE_ACCOUNT_BINDING_MISMATCH", "Save Context account does not match the embedded Elden Ring SteamID64.");
    }
    return await this.#store.saveAnalysis(analysis);
  }

  async getAnalysis(id: string): Promise<Readonly<EldenRingSaveAnalysis>> { return await this.#store.getAnalysis(id); }

  async plan(input: { packageId: string; saveContextId: string; sourceSlot?: number; targetSlot?: number; allowOccupiedTarget?: boolean }): Promise<Readonly<EldenRingSlotImportPlan>> {
    const [savePackage, context, source, target] = await Promise.all([
      this.#packages.verify(input.packageId),
      this.#contexts.getSaveContext(input.saveContextId),
      this.analyzePackage(input.packageId),
      this.analyzeContext(input.saveContextId),
    ]);
    const sourceSlot = input.sourceSlot ?? source.slots.find((slot) => slot.active)?.slotIndex;
    if (sourceSlot === undefined || !source.slots[sourceSlot]?.active) {
      throw new NexusError("SAVE_SLOT_SELECTION_REQUIRED", "A valid active source slot must be selected.");
    }
    const targetSlot = input.targetSlot ?? target.slots.find((slot) => !slot.active)?.slotIndex;
    if (targetSlot === undefined || !target.slots[targetSlot]) {
      throw new NexusError("SAVE_SLOT_SELECTION_REQUIRED", "No empty target slot exists; explicitly select an occupied slot for review.");
    }
    const targetSummary = target.slots[targetSlot]!;
    const overwriteOccupiedTarget = targetSummary.active;
    if (overwriteOccupiedTarget && input.allowOccupiedTarget !== true) {
      throw new NexusError("SAVE_SLOT_SELECTION_REQUIRED", "The selected target slot is occupied and overwrite was not explicitly allowed.", {
        details: { targetSlot, characterName: targetSummary.characterName },
      });
    }
    const now = new Date();
    const allowedByteRanges = [
      { start: slotChecksumStart(targetSlot), endExclusive: slotDataStart(targetSlot) + ELDEN_RING_SL2.slotDataLength, reason: "target-slot-checksum-and-data" },
      { start: ELDEN_RING_SL2.headerChecksumStart, endExclusive: ELDEN_RING_SL2.headerSectionStart, reason: "header-section-checksum" },
      { start: ELDEN_RING_SL2.activeSlotsOffset + targetSlot, endExclusive: ELDEN_RING_SL2.activeSlotsOffset + targetSlot + 1, reason: "target-active-flag" },
      { start: slotSummaryStart(targetSlot), endExclusive: slotSummaryStart(targetSlot) + ELDEN_RING_SL2.slotSummaryLength, reason: "target-slot-summary" },
    ];
    const withoutHash = {
      schemaVersion: 1 as const,
      slotImportPlanId: randomUUID(),
      status: "planned" as const,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#planTtlMs).toISOString(),
      packageId: savePackage.packageId,
      packageManifestHash: savePackage.manifestHash,
      saveContextId: context.saveContextId,
      saveContextHash: context.contextHash,
      sourceAnalysisId: source.analysisId,
      sourceAnalysisHash: source.analysisHash,
      targetAnalysisId: target.analysisId,
      targetAnalysisHash: target.analysisHash,
      sourceFileSha256: source.fileSha256,
      targetPreStateSha256: target.fileSha256,
      sourceSlot,
      targetSlot,
      overwriteOccupiedTarget,
      sourceCharacterName: source.slots[sourceSlot]!.characterName,
      replacedTargetCharacterName: targetSummary.characterName,
      sourceSteamId64: source.steamId64,
      targetSteamId64: target.steamId64,
      transformations: ["copy-slot-data", "rebind-slot-steam-id", "copy-slot-summary", "mark-target-slot-active", "recompute-slot-md5", "recompute-header-md5"] as const,
      allowedByteRanges,
      preservedSlotIndexes: Array.from({ length: 10 }, (_, index) => index).filter((index) => index !== targetSlot),
    };
    return await this.#store.savePlan(eldenRingSlotImportPlanSchema.parse({ ...withoutHash, planHash: sha256CanonicalJson(withoutHash) }));
  }

  async getPlan(id: string, allowExpired = false): Promise<Readonly<EldenRingSlotImportPlan>> { return await this.#store.getPlan(id, allowExpired); }

  async stage(slotImportPlanId: string): Promise<Readonly<EldenRingStagedImport>> {
    const plan = await this.#store.getPlan(slotImportPlanId);
    const [savePackage, context, sourceObject] = await Promise.all([
      this.#packages.verify(plan.packageId),
      this.#contexts.getSaveContext(plan.saveContextId),
      this.#sourceObject(plan.packageId),
    ]);
    if (savePackage.manifestHash !== plan.packageManifestHash || context.contextHash !== plan.saveContextHash) {
      throw new NexusError("SAVE_TARGET_DRIFTED", "Slot import package or Save Context changed after planning.");
    }
    const targetPath = this.#targetPath(context);
    const [{ analysis: source, buffer: sourceBuffer }, { analysis: target, buffer: targetBuffer }] = await Promise.all([
      analyzeEldenRingFile(sourceObject.absolutePath, { kind: "package", referenceId: plan.packageId }),
      analyzeEldenRingFile(targetPath, { kind: "save-context", referenceId: plan.saveContextId }),
    ]);
    if (source.fileSha256 !== plan.sourceFileSha256 || target.fileSha256 !== plan.targetPreStateSha256) {
      throw new NexusError("SAVE_TARGET_DRIFTED", "Source or target save bytes changed after Slot Import Plan creation.");
    }
    if (source.steamId64 !== plan.sourceSteamId64 || target.steamId64 !== plan.targetSteamId64) {
      throw new NexusError("SAVE_ACCOUNT_BINDING_MISMATCH", "Source or target SteamID64 changed after planning.");
    }
    if (!source.slots[plan.sourceSlot]?.active || (target.slots[plan.targetSlot]?.active && !plan.overwriteOccupiedTarget)) {
      throw new NexusError("SAVE_TARGET_DRIFTED", "Planned source/target slot state is no longer valid.");
    }
    const transformed = importEldenRingSlot({
      source: sourceBuffer, target: targetBuffer, sourceSlot: plan.sourceSlot, targetSlot: plan.targetSlot,
      sourceSteamId64: plan.sourceSteamId64, targetSteamId64: plan.targetSteamId64,
    });
    assertChangesAllowed(transformed.changes, plan.allowedByteRanges);
    const stagedImportId = randomUUID();
    const stageRoot = path.join(this.#store.stagingRoot, stagedImportId);
    const stagedPath = path.join(stageRoot, "ER0000.sl2");
    await mkdir(stageRoot, { recursive: false });
    try {
      await writeFile(stagedPath, transformed.staged, { flag: "wx" });
      const stagedSha256 = await sha256File(stagedPath);
      const stagedAnalysis = analyzeEldenRingBuffer(transformed.staged, { kind: "path", referenceId: stagedImportId, absolutePath: stagedPath }, stagedSha256);
      if (stagedAnalysis.steamId64 !== plan.targetSteamId64 || !stagedAnalysis.slots[plan.targetSlot]?.active) {
        throw new NexusError("SAVE_STAGING_INVALID", "Staged save failed account or active-slot verification.");
      }
      for (const index of plan.preservedSlotIndexes) {
        const checksumStart = slotChecksumStart(index);
        const dataEnd = slotDataStart(index) + ELDEN_RING_SL2.slotDataLength;
        if (!targetBuffer.subarray(checksumStart, dataEnd).equals(transformed.staged.subarray(checksumStart, dataEnd))) {
          throw new NexusError("SAVE_STAGING_INVALID", "An unselected target slot changed during staging.", { details: { slotIndex: index } });
        }
      }
      const withoutHash = {
        schemaVersion: 1 as const, stagedImportId, slotImportPlanId: plan.slotImportPlanId, planHash: plan.planHash,
        stagedPath, bytes: ELDEN_RING_SL2.bytes as 28_967_888, stagedSha256,
        sourceFileSha256: plan.sourceFileSha256, targetPreStateSha256: plan.targetPreStateSha256,
        sourceSlot: plan.sourceSlot, targetSlot: plan.targetSlot,
        reboundAccountOccurrences: transformed.reboundAccountOccurrences,
        changedByteRanges: summarizeAllowedChanges(transformed.changes, plan.allowedByteRanges),
        allowedByteRangeVerification: "passed" as const,
        checksumVerification: "passed" as const,
        unselectedSlotsVerification: "passed" as const,
        createdAt: new Date().toISOString(),
      };
      return await this.#store.saveRecord(eldenRingStagedImportSchema.parse({ ...withoutHash, recordHash: sha256CanonicalJson(withoutHash) }));
    } catch (error) {
      await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async verifyStage(id: string): Promise<Readonly<EldenRingStagedImport>> {
    const record = await this.#store.getRecord(id);
    const plan = await this.#store.getPlan(record.slotImportPlanId, true);
    if (plan.planHash !== record.planHash || await sha256File(record.stagedPath) !== record.stagedSha256) {
      throw new NexusError("SAVE_STAGING_INVALID", "Staged import record or bytes failed verification.");
    }
    const { analysis } = await analyzeEldenRingFile(record.stagedPath, { kind: "path", referenceId: id });
    if (analysis.steamId64 !== plan.targetSteamId64 || !analysis.slots[plan.targetSlot]?.active) {
      throw new NexusError("SAVE_STAGING_INVALID", "Staged import structure no longer matches its plan.");
    }
    return record;
  }

  async #sourceObject(packageId: string) {
    const savePackage = await this.#packages.verify(packageId);
    const payload = savePackage.payload.files.find((file) => file.relativePath.toLowerCase() === "er0000.sl2");
    if (!payload) throw new NexusError("SAVE_FORMAT_INVALID", "Package has no ER0000.sl2 payload.");
    const object = await this.#packages.objectStore.get(payload.objectId);
    if (object.objectKind !== "file") throw new NexusError("SAVE_FORMAT_INVALID", "ER0000.sl2 package object is not a file.");
    return object;
  }

  #targetPath(context: Readonly<SaveContext>): string {
    if (context.format.adapterId !== "elden-ring-steam-pc" || context.verification.state !== "confirmed") {
      throw new NexusError("SAVE_ADAPTER_UNSUPPORTED", "A confirmed Elden Ring Steam PC Save Context is required.");
    }
    const root = context.saveRoots.find((candidate) => candidate.role === "primary");
    if (!root) throw new NexusError("SAVE_CONTEXT_NOT_FOUND", "Elden Ring primary save root is missing.");
    return path.join(root.absolutePath, "ER0000.sl2");
  }

  #assertEldenPackage(gameId: string, adapterHint: string | null): void {
    if (gameId !== "steam:1245620" || adapterHint !== "elden-ring-steam-pc") {
      throw new NexusError("SAVE_INCOMPATIBLE_GAME", "Package is not an Elden Ring Steam PC save.");
    }
  }
}
