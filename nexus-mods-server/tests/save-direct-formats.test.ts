import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { sha256File } from "../src/install/file-hash.js";
import { NexusClient } from "../src/nexus-client.js";
import { createNexusMcpServer } from "../src/server.js";
import { GenericSaveImportService } from "../src/save/generic/import-service.js";
import {
  analyzeEldenRingBuffer, ELDEN_RING_SL2, EldenRingFileService,
  slotChecksumStart, slotDataStart, slotSummaryStart,
} from "../src/save/formats/elden-ring.js";

const temporaryDirectories: string[] = [];
const TARGET_ID = "76561198127396738";
const SOURCE_ID = "76561198396506719";
function md5(bytes: Buffer) { return createHash("md5").update(bytes).digest(); }
function digest(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }

function checksums(bytes: Buffer) {
  for (let index = 0; index < 10; index++) {
    md5(bytes.subarray(slotDataStart(index), slotDataStart(index) + ELDEN_RING_SL2.slotDataLength))
      .copy(bytes, slotChecksumStart(index));
  }
  md5(bytes.subarray(ELDEN_RING_SL2.headerSectionStart,
    ELDEN_RING_SL2.headerSectionStart + ELDEN_RING_SL2.headerSectionLength)).copy(bytes, ELDEN_RING_SL2.headerChecksumStart);
  return bytes;
}
function save(account: string, active: number[]) {
  const bytes = Buffer.alloc(ELDEN_RING_SL2.bytes);
  bytes.write("BND4");
  bytes.writeBigUInt64LE(BigInt(account), ELDEN_RING_SL2.accountIdOffset);
  for (const index of active) {
    bytes[ELDEN_RING_SL2.activeSlotsOffset + index] = 1;
    bytes.writeBigUInt64LE(BigInt(account), slotDataStart(index) + 0x12340);
    Buffer.from(`Hero${index}\0`, "utf16le").copy(bytes, slotSummaryStart(index));
    bytes[slotSummaryStart(index) + ELDEN_RING_SL2.characterLevelOffset] = 40 + index;
  }
  return checksums(bytes);
}
function analyze(bytes: Buffer) {
  return analyzeEldenRingBuffer(bytes, { kind: "path", referenceId: null, absolutePath: path.resolve("fixture.sl2") }, digest(bytes));
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "direct-save-format-"));
  temporaryDirectories.push(root);
  const sourcePath = path.join(root, "source.sl2");
  const targetRoot = path.join(root, "player");
  await mkdir(targetRoot);
  const targetPath = path.join(targetRoot, "ER0000.sl2");
  const source = save(SOURCE_ID, [7, 9]);
  const target = save(TARGET_ID, [0]);
  await Promise.all([writeFile(sourcePath, source), writeFile(targetPath, target)]);
  const service = await EldenRingFileService.create({ managerRoot: path.join(root, "manager") });
  const input = { sourcePath, targetPath, sourceSha256: digest(source), targetSha256: digest(target) };
  return { root, service, input, source, target };
}
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("direct Elden Ring file analysis and conversion", () => {
  it("validates signature, length, checksum, active flags, account binding, and summary fields", () => {
    const good = save(SOURCE_ID, [7]);
    expect(analyze(good)).toMatchObject({ steamId64: SOURCE_ID, headerChecksumValid: true, structureValid: true });
    expect(analyze(good).slots[7]).toMatchObject({ active: true, characterName: "Hero7", accountIdOccurrences: 1 });
    expect(() => analyze(good.subarray(1))).toThrowError(expect.objectContaining({ code: "SAVE_FORMAT_INVALID" }));
    const badMagic = Buffer.from(good); badMagic.write("BAD!");
    expect(() => analyze(badMagic)).toThrowError(expect.objectContaining({ code: "SAVE_FORMAT_INVALID" }));
    const badChecksum = Buffer.from(good); badChecksum[slotDataStart(7) + 3] = 99;
    expect(() => analyze(badChecksum)).toThrowError(expect.objectContaining({ code: "SAVE_FORMAT_INVALID" }));
    const badFlag = Buffer.from(good); badFlag[ELDEN_RING_SL2.activeSlotsOffset] = 2;
    expect(() => analyze(checksums(badFlag))).toThrowError(expect.objectContaining({ code: "SAVE_FORMAT_INVALID" }));
    const badAccount = Buffer.from(good); badAccount.fill(0, slotDataStart(7) + 0x12340, slotDataStart(7) + 0x12348);
    expect(() => analyze(checksums(badAccount))).toThrowError(expect.objectContaining({ code: "SAVE_FORMAT_INVALID" }));
    const badTime = Buffer.from(good); badTime.writeInt32LE(-1, slotSummaryStart(7) + ELDEN_RING_SL2.secondsPlayedOffset);
    expect(() => analyze(checksums(badTime))).toThrowError(expect.objectContaining({ code: "SAVE_FORMAT_INVALID" }));
  });

  it("merges selected slots, rebinds accounts, preserves every unselected byte, and persists a verified receipt", async () => {
    const f = await fixture();
    const receipt = await f.service.prepare({ ...f.input, slots: [{ sourceSlot: 7, targetSlot: 1 }, { sourceSlot: 9, targetSlot: 2 }] });
    const staged = await readFile(path.join(receipt.inputPath, "ER0000.sl2"));
    expect(receipt.expectedTargets).toEqual([{ targetPath: "ER0000.sl2", sha256: f.input.targetSha256, bytes: ELDEN_RING_SL2.bytes }]);
    expect(receipt.analysis.steamId64).toBe(TARGET_ID);
    expect(receipt.analysis.slots[1]).toMatchObject({ active: true, characterName: "Hero7", accountIdOccurrences: 1 });
    expect(receipt.analysis.slots[2]).toMatchObject({ active: true, characterName: "Hero9", accountIdOccurrences: 1 });
    for (const index of receipt.preservedSlotIndexes) {
      expect(staged.subarray(slotChecksumStart(index), slotDataStart(index) + ELDEN_RING_SL2.slotDataLength)
        .equals(f.target.subarray(slotChecksumStart(index), slotDataStart(index) + ELDEN_RING_SL2.slotDataLength))).toBe(true);
      expect(staged.subarray(slotSummaryStart(index), slotSummaryStart(index) + ELDEN_RING_SL2.slotSummaryLength)
        .equals(f.target.subarray(slotSummaryStart(index), slotSummaryStart(index) + ELDEN_RING_SL2.slotSummaryLength))).toBe(true);
    }
    expect(await sha256File(f.input.targetPath)).toBe(f.input.targetSha256);
    const restarted = await EldenRingFileService.create({ managerRoot: path.join(f.root, "manager") });
    expect(await restarted.get(receipt.preparationId)).toMatchObject({ planHash: receipt.planHash, stagedSha256: receipt.stagedSha256 });
  }, 20_000);

  it("requires explicit occupied-slot authorization and rejects empty or duplicate selections", async () => {
    const f = await fixture();
    await expect(f.service.prepare({ ...f.input, slots: [{ sourceSlot: 7, targetSlot: 0 }] }))
      .rejects.toMatchObject({ code: "SAVE_SLOT_SELECTION_REQUIRED" });
    await expect(f.service.prepare({ ...f.input, slots: [{ sourceSlot: 0, targetSlot: 1 }] }))
      .rejects.toMatchObject({ code: "SAVE_SLOT_SELECTION_REQUIRED" });
    await expect(f.service.prepare({ ...f.input, slots: [{ sourceSlot: 7, targetSlot: 1 }, { sourceSlot: 9, targetSlot: 1 }] }))
      .rejects.toMatchObject({ code: "SAVE_SLOT_SELECTION_REQUIRED" });
    const receipt = await f.service.prepare({ ...f.input, slots: [{ sourceSlot: 7, targetSlot: 0, allowOverwriteOccupied: true }] });
    expect(receipt.analysis.slots[0]!.characterName).toBe("Hero7");
    expect(await sha256File(f.input.targetPath)).toBe(f.input.targetSha256);
  });

  it("rejects source and target drift after slot selection without touching real saves", async () => {
    const f = await fixture();
    await writeFile(f.input.targetPath, save(TARGET_ID, [0, 1]));
    await expect(f.service.prepare({ ...f.input, slots: [{ sourceSlot: 7, targetSlot: 1 }] }))
      .rejects.toMatchObject({ code: "SAVE_TARGET_DRIFTED" });
    await writeFile(f.input.targetPath, f.target);
    await writeFile(f.input.sourcePath, save(SOURCE_ID, [7]));
    await expect(f.service.prepare({ ...f.input, slots: [{ sourceSlot: 7, targetSlot: 1 }] }))
      .rejects.toMatchObject({ code: "SAVE_TARGET_DRIFTED" });
    expect(await sha256File(f.input.targetPath)).toBe(f.input.targetSha256);
  });

  it("rejects receipt tampering and valid-but-replaced staged files", async () => {
    const f = await fixture();
    const receipt = await f.service.prepare({ ...f.input, slots: [{ sourceSlot: 7, targetSlot: 1 }] });
    await writeFile(path.join(receipt.inputPath, "ER0000.sl2"), f.target);
    await expect(f.service.get(receipt.preparationId)).rejects.toMatchObject({ code: "SAVE_STAGING_INVALID" });
    const second = await f.service.prepare({ ...f.input, slots: [{ sourceSlot: 7, targetSlot: 2 }] });
    const disk = JSON.parse(await readFile(second.receiptPath, "utf8"));
    disk.targetSha256 = "a".repeat(64);
    await writeFile(second.receiptPath, JSON.stringify(disk));
    await expect(f.service.get(second.preparationId)).rejects.toMatchObject({ code: "SAVE_STAGING_INVALID" });
    await expect(f.service.get("../outside")).rejects.toThrow();
  });

  it("rejects real files reached through an ancestor junction", async () => {
    const f = await fixture();
    const linked = path.join(f.root, "alias");
    await symlink(path.dirname(f.input.targetPath), linked, "junction");
    await expect(f.service.analyze({ filePath: path.join(linked, "ER0000.sl2") }))
      .rejects.toMatchObject({ code: "SAVE_PATH_PROTECTED" });
  });

  it("binds conversion to generic import, rejects changed destinations, and restores applied bytes", async () => {
    const f = await fixture();
    const receipt = await f.service.prepare({ ...f.input, slots: [{ sourceSlot: 7, targetSlot: 1 }] });
    const imports = await GenericSaveImportService.create({ managerRoot: path.join(f.root, "manager"), processGuard: async () => undefined });
    const installationRoot = path.join(f.root, "game"); await mkdir(installationRoot);
    const evidence = { gameName: "Elden Ring", installationRoot,
      source: "Synthetic source with a verified active character in slot seven",
      target: "Synthetic destination save whose local account was analyzed",
      compatibility: "Exact supported PC BND4 length, signature and all checksums passed",
      method: "Verified direct conversion receipt; copy its staged output unchanged",
      knownConversionRequired: false };
    const input = { inputPath: receipt.inputPath, targetRoot: receipt.targetRoot, mappings: receipt.mappings,
      processNames: ["eldenring.exe"], evidence };
    await expect(imports.plan(input)).rejects.toMatchObject({ code: "SAVE_STAGING_INVALID" });
    await expect(imports.inspect(receipt.inputPath)).rejects.toMatchObject({ code: "SAVE_STAGING_INVALID" });
    const bound = { ...input, preparationId: receipt.preparationId };
    await writeFile(f.input.targetPath, save(TARGET_ID, [0, 2]));
    await expect(imports.plan(bound)).rejects.toMatchObject({ code: "SAVE_TARGET_DRIFTED" });
    await writeFile(f.input.targetPath, f.target);
    const plan = await imports.plan(bound);
    await writeFile(f.input.targetPath, save(TARGET_ID, [0, 3]));
    await expect(imports.apply(plan.planId)).rejects.toMatchObject({ code: "SAVE_TARGET_DRIFTED" });
    await writeFile(f.input.targetPath, f.target);
    const applied = await imports.apply(plan.planId);
    expect(applied.operation?.state).toBe("applied");
    expect(await sha256File(f.input.targetPath)).toBe(receipt.stagedSha256);
    await imports.restore(plan.planId);
    expect(await sha256File(f.input.targetPath)).toBe(f.input.targetSha256);
  }, 20_000);

  it("runs direct analysis, conversion and reversible import through actual MCP tool calls", async () => {
    const f = await fixture();
    const installationRoot = path.join(f.root, "game");
    await mkdir(installationRoot);
    const service = createNexusMcpServer(new NexusClient("fixture-key"), undefined, {
      managerRoot: path.join(f.root, "manager"), saveProcessGuard: async () => undefined,
    });
    const client = new Client({ name: "direct-format-mcp-test", version: "1" });
    const [local, remote] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([service.server.connect(remote), client.connect(local)]);
      const sourceResult = await client.callTool({ name: "analyze_elden_ring_save", arguments: { filePath: f.input.sourcePath } });
      const targetResult = await client.callTool({ name: "analyze_elden_ring_save", arguments: { filePath: f.input.targetPath } });
      expect(sourceResult.isError).not.toBe(true);
      expect(targetResult.isError).not.toBe(true);
      const analysisResult = z.object({ analysis: z.object({ fileSha256: z.string() }) });
      const sourceSha256 = analysisResult.parse(sourceResult.structuredContent).analysis.fileSha256;
      const targetSha256 = analysisResult.parse(targetResult.structuredContent).analysis.fileSha256;
      expect(sourceSha256).toBe(f.input.sourceSha256);
      expect(targetSha256).toBe(f.input.targetSha256);
      const prepared = await client.callTool({ name: "prepare_elden_ring_import", arguments: {
        sourcePath: f.input.sourcePath, targetPath: f.input.targetPath, sourceSha256, targetSha256,
        slots: [{ sourceSlot: 7, targetSlot: 1 }],
      } });
      expect(prepared.isError).not.toBe(true);
      const receipt = z.object({ preparation: z.object({ preparationId: z.uuid(), inputPath: z.string(), targetRoot: z.string(),
        mappings: z.array(z.object({ sourcePath: z.string(), targetPath: z.string() })), stagedSha256: z.string(),
      }) }).parse(prepared.structuredContent).preparation;
      expect(await sha256File(f.input.targetPath)).toBe(targetSha256);
      const readPreparation = await client.callTool({ name: "get_elden_ring_preparation", arguments: { preparationId: receipt.preparationId } });
      expect(readPreparation.isError).not.toBe(true);
      expect(readPreparation.structuredContent).toMatchObject({ preparation: {
        preparationId: receipt.preparationId, stagedSha256: receipt.stagedSha256,
      } });
      const planned = await client.callTool({ name: "plan_save_import", arguments: {
        preparationId: receipt.preparationId, inputPath: receipt.inputPath, targetRoot: receipt.targetRoot, mappings: receipt.mappings,
        processNames: ["eldenring.exe"], evidence: {
          gameName: "Elden Ring", installationRoot,
          source: "Synthetic active source character verified by the direct analysis tool",
          target: "Synthetic current player file verified by the direct analysis tool",
          compatibility: "Supported PC BND4 with valid length, account binding and checksums",
          method: "Use the verified conversion receipt and its exact staged bytes",
          knownConversionRequired: false,
        },
      } });
      expect(planned.isError).not.toBe(true);
      const plan = z.object({ plan: z.object({ planId: z.uuid(), preparationId: z.uuid() }) }).parse(planned.structuredContent).plan;
      expect(plan.preparationId).toBe(receipt.preparationId);
      const applied = await client.callTool({ name: "apply_save_import", arguments: { planId: plan.planId } });
      expect(applied.isError).not.toBe(true);
      expect(applied.structuredContent).toMatchObject({ operation: { state: "applied" }, runtimeVerification: "not_performed" });
      expect(await sha256File(f.input.targetPath)).toBe(receipt.stagedSha256);
      const queried = await client.callTool({ name: "get_save_import", arguments: { planId: plan.planId } });
      expect(queried.isError).not.toBe(true);
      expect(queried.structuredContent).toMatchObject({ plan: { planId: plan.planId }, operation: { state: "applied" } });
      const restored = await client.callTool({ name: "restore_save_import", arguments: { planId: plan.planId } });
      expect(restored.isError).not.toBe(true);
      expect(restored.structuredContent).toMatchObject({ operation: { state: "restored" } });
      expect(await sha256File(f.input.targetPath)).toBe(targetSha256);
    } finally {
      await client.close();
      await service.close();
    }
  }, 20_000);
});
