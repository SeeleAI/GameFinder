import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import { sha256File } from "../../install/file-hash.js";
import type { EldenRingSaveAnalysis } from "../contracts.js";
import { eldenRingSaveAnalysisSchema } from "../contracts.js";

// Independently implemented from the MIT-licensed BenGrn/EldenRingSaveCopier
// layout constants, with stricter length, signature, checksum and bounds checks.
export const ELDEN_RING_SL2 = Object.freeze({
  bytes: 28_967_888,
  slotCount: 10,
  slotChecksumStart: 0x300,
  slotDataLength: 0x280000,
  slotStride: 0x280010,
  headerChecksumStart: 0x19003a0,
  headerSectionStart: 0x19003b0,
  headerSectionLength: 0x60000,
  accountIdOffset: 0x19003b4,
  activeSlotsOffset: 0x1901d04,
  slotSummaryStart: 0x1901d0e,
  slotSummaryLength: 0x24c,
  characterNameLength: 0x22,
  characterLevelOffset: 0x22,
  secondsPlayedOffset: 0x26,
});

export interface EldenRingAnalysisSource {
  kind: "package" | "save-context" | "path";
  referenceId: string | null;
  absolutePath: string;
}

export interface ByteRange {
  start: number;
  endExclusive: number;
  reason: string;
}

function md5(value: Buffer): string {
  return createHash("md5").update(value).digest("hex");
}

function decodeName(value: Buffer): string | null {
  let end = value.length;
  for (let index = 0; index + 1 < value.length; index += 2) {
    if (value[index] === 0 && value[index + 1] === 0) { end = index; break; }
  }
  const name = value.subarray(0, end).toString("utf16le").trim();
  if (!name) return null;
  if (/\p{C}/u.test(name)) {
    throw new NexusError("SAVE_FORMAT_INVALID", "Elden Ring slot summary contains control characters.");
  }
  return name;
}

function occurrences(haystack: Buffer, needle: Buffer): number[] {
  const result: number[] = [];
  for (let offset = 0; offset <= haystack.length - needle.length;) {
    const found = haystack.indexOf(needle, offset);
    if (found < 0) break;
    result.push(found);
    offset = found + needle.length;
  }
  return result;
}

export function slotChecksumStart(slotIndex: number): number {
  return ELDEN_RING_SL2.slotChecksumStart + slotIndex * ELDEN_RING_SL2.slotStride;
}

export function slotDataStart(slotIndex: number): number {
  return slotChecksumStart(slotIndex) + 0x10;
}

export function slotSummaryStart(slotIndex: number): number {
  return ELDEN_RING_SL2.slotSummaryStart + slotIndex * ELDEN_RING_SL2.slotSummaryLength;
}

export function analyzeEldenRingBuffer(
  buffer: Buffer,
  source: EldenRingAnalysisSource,
  fileSha256: string,
): EldenRingSaveAnalysis {
  if (buffer.length !== ELDEN_RING_SL2.bytes) {
    throw new NexusError("SAVE_FORMAT_INVALID", "Elden Ring PC save has an unsupported container length.", {
      details: { expected: ELDEN_RING_SL2.bytes, actual: buffer.length },
    });
  }
  if (buffer.subarray(0, 4).toString("ascii") !== "BND4") {
    throw new NexusError("SAVE_FORMAT_INVALID", "Elden Ring PC save is missing the BND4 signature.");
  }
  const accountBytes = buffer.subarray(ELDEN_RING_SL2.accountIdOffset, ELDEN_RING_SL2.accountIdOffset + 8);
  const steamId64 = accountBytes.readBigUInt64LE().toString();
  if (!/^\d{17}$/.test(steamId64)) {
    throw new NexusError("SAVE_FORMAT_INVALID", "Elden Ring save has no valid 17-digit SteamID64 binding.");
  }
  const headerChecksum = buffer.subarray(
    ELDEN_RING_SL2.headerChecksumStart,
    ELDEN_RING_SL2.headerSectionStart,
  ).toString("hex");
  const headerActual = md5(buffer.subarray(
    ELDEN_RING_SL2.headerSectionStart,
    ELDEN_RING_SL2.headerSectionStart + ELDEN_RING_SL2.headerSectionLength,
  ));
  if (headerChecksum !== headerActual) {
    throw new NexusError("SAVE_FORMAT_INVALID", "Elden Ring header-section MD5 checksum failed.");
  }
  const slots = Array.from({ length: ELDEN_RING_SL2.slotCount }, (_, slotIndex) => {
    const activeByte = buffer[ELDEN_RING_SL2.activeSlotsOffset + slotIndex];
    if (activeByte !== 0 && activeByte !== 1) {
      throw new NexusError("SAVE_FORMAT_INVALID", "Elden Ring active-slot table contains an invalid value.", {
        details: { slotIndex, activeByte },
      });
    }
    const checksumStart = slotChecksumStart(slotIndex);
    const dataStart = slotDataStart(slotIndex);
    const data = buffer.subarray(dataStart, dataStart + ELDEN_RING_SL2.slotDataLength);
    const checksum = buffer.subarray(checksumStart, dataStart).toString("hex");
    const actual = md5(data);
    if (checksum !== actual) {
      throw new NexusError("SAVE_FORMAT_INVALID", "Elden Ring slot MD5 checksum failed.", {
        details: { slotIndex },
      });
    }
    const summaryStart = slotSummaryStart(slotIndex);
    const active = activeByte === 1;
    const accountIdOccurrences = occurrences(data, accountBytes).length;
    if (active && accountIdOccurrences < 1) {
      throw new NexusError("SAVE_FORMAT_INVALID", "An active Elden Ring slot has no matching account binding.", {
        details: { slotIndex },
      });
    }
    const secondsPlayed = buffer.readInt32LE(summaryStart + ELDEN_RING_SL2.secondsPlayedOffset);
    if (secondsPlayed < 0) {
      throw new NexusError("SAVE_FORMAT_INVALID", "Elden Ring slot summary has a negative play time.", {
        details: { slotIndex },
      });
    }
    return {
      slotIndex,
      active,
      characterName: decodeName(buffer.subarray(summaryStart, summaryStart + ELDEN_RING_SL2.characterNameLength)),
      level: buffer[summaryStart + ELDEN_RING_SL2.characterLevelOffset] ?? 0,
      secondsPlayed,
      checksum,
      checksumValid: true,
      accountIdOccurrences,
    };
  });
  const withoutHash = {
    schemaVersion: 1 as const,
    analysisId: randomUUID(),
    source: { ...source, absolutePath: path.resolve(source.absolutePath) },
    fileSha256,
    bytes: ELDEN_RING_SL2.bytes as 28_967_888,
    containerMagic: "BND4" as const,
    steamId64,
    headerChecksum,
    headerChecksumValid: true,
    slots,
    structureValid: true as const,
    createdAt: new Date().toISOString(),
  };
  return eldenRingSaveAnalysisSchema.parse({
    ...withoutHash,
    analysisHash: sha256CanonicalJson(withoutHash),
  });
}

export async function analyzeEldenRingFile(
  absolutePath: string,
  source: Omit<EldenRingAnalysisSource, "absolutePath">,
): Promise<{ analysis: EldenRingSaveAnalysis; buffer: Buffer }> {
  if (!path.isAbsolute(absolutePath)) throw new NexusError("SAVE_PATH_INVALID", "Elden Ring save path must be absolute.");
  const resolved = path.resolve(absolutePath);
  const info = await lstat(resolved).catch((error: unknown) => {
    throw new NexusError("SAVE_FORMAT_INVALID", "Elden Ring save file is unavailable.", { cause: error });
  });
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new NexusError("SAVE_PATH_PROTECTED", "Elden Ring save input must be a real file.");
  }
  const [buffer, fileSha256] = await Promise.all([readFile(resolved), sha256File(resolved)]);
  return { analysis: analyzeEldenRingBuffer(buffer, { ...source, absolutePath: resolved }, fileSha256), buffer };
}

export function changedByteRanges(before: Buffer, after: Buffer): ByteRange[] {
  if (before.length !== after.length) throw new NexusError("SAVE_STAGING_INVALID", "Staged save length changed.");
  const ranges: ByteRange[] = [];
  for (let index = 0; index < before.length;) {
    if (before[index] === after[index]) { index += 1; continue; }
    const start = index;
    while (index < before.length && before[index] !== after[index]) index += 1;
    ranges.push({ start, endExclusive: index, reason: "observed-change" });
  }
  return ranges;
}

export function assertChangesAllowed(changes: readonly ByteRange[], allowed: readonly ByteRange[]): void {
  const invalid = changes.find((change) => !allowed.some(
    (range) => change.start >= range.start && change.endExclusive <= range.endExclusive,
  ));
  if (invalid) {
    throw new NexusError("SAVE_STAGING_INVALID", "Staged slot import changed bytes outside its allowlist.", {
      details: { invalid },
    });
  }
}

export function summarizeAllowedChanges(
  changes: readonly ByteRange[],
  allowed: readonly ByteRange[],
): Array<ByteRange & { changedBytes: number }> {
  return allowed.flatMap((range) => {
    const inside = changes.filter((change) => change.start >= range.start && change.endExclusive <= range.endExclusive);
    if (inside.length === 0) return [];
    return [{
      start: Math.min(...inside.map((change) => change.start)),
      endExclusive: Math.max(...inside.map((change) => change.endExclusive)),
      reason: range.reason,
      changedBytes: inside.reduce((sum, change) => sum + change.endExclusive - change.start, 0),
    }];
  });
}

export function importEldenRingSlot(input: {
  source: Buffer;
  target: Buffer;
  sourceSlot: number;
  targetSlot: number;
  sourceSteamId64: string;
  targetSteamId64: string;
}): { staged: Buffer; reboundAccountOccurrences: number; allowedRanges: ByteRange[]; changes: ByteRange[] } {
  const staged = Buffer.from(input.target);
  const sourceStart = slotDataStart(input.sourceSlot);
  const targetStart = slotDataStart(input.targetSlot);
  const slotData = Buffer.from(input.source.subarray(sourceStart, sourceStart + ELDEN_RING_SL2.slotDataLength));
  const sourceId = Buffer.alloc(8); sourceId.writeBigUInt64LE(BigInt(input.sourceSteamId64));
  const targetId = Buffer.alloc(8); targetId.writeBigUInt64LE(BigInt(input.targetSteamId64));
  const hits = occurrences(slotData, sourceId);
  if (hits.length < 1 || hits.length > 100) {
    throw new NexusError("SAVE_FORMAT_INVALID", "Selected source slot has an unsafe account-binding occurrence count.", {
      details: { occurrences: hits.length },
    });
  }
  for (const hit of hits) targetId.copy(slotData, hit);
  slotData.copy(staged, targetStart);
  const sourceSummary = slotSummaryStart(input.sourceSlot);
  const targetSummary = slotSummaryStart(input.targetSlot);
  input.source.copy(staged, targetSummary, sourceSummary, sourceSummary + ELDEN_RING_SL2.slotSummaryLength);
  staged[ELDEN_RING_SL2.activeSlotsOffset + input.targetSlot] = 1;
  Buffer.from(md5(slotData), "hex").copy(staged, slotChecksumStart(input.targetSlot));
  Buffer.from(md5(staged.subarray(
    ELDEN_RING_SL2.headerSectionStart,
    ELDEN_RING_SL2.headerSectionStart + ELDEN_RING_SL2.headerSectionLength,
  )), "hex").copy(staged, ELDEN_RING_SL2.headerChecksumStart);
  const allowedRanges: ByteRange[] = [
    { start: slotChecksumStart(input.targetSlot), endExclusive: targetStart + ELDEN_RING_SL2.slotDataLength, reason: "target-slot-checksum-and-data" },
    { start: ELDEN_RING_SL2.headerChecksumStart, endExclusive: ELDEN_RING_SL2.headerSectionStart, reason: "header-section-checksum" },
    { start: ELDEN_RING_SL2.activeSlotsOffset + input.targetSlot, endExclusive: ELDEN_RING_SL2.activeSlotsOffset + input.targetSlot + 1, reason: "target-active-flag" },
    { start: targetSummary, endExclusive: targetSummary + ELDEN_RING_SL2.slotSummaryLength, reason: "target-slot-summary" },
  ];
  const changes = changedByteRanges(input.target, staged);
  assertChangesAllowed(changes, allowedRanges);
  return { staged, reboundAccountOccurrences: hits.length, allowedRanges, changes };
}
