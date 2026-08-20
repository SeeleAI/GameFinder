import { describe, expect, it } from "vitest";

import { analyzeGhostOfTsushimaPcV49 } from "../src/save/adapters/ghost-of-tsushima-pc-v49.js";

function validSave(): Buffer {
  const bytes = Buffer.alloc(0x220, 0x5a);
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

describe("Ghost of Tsushima PC v49 format Adapter", () => {
  it("validates exact size, platform markers, and checksum", () => {
    expect(analyzeGhostOfTsushimaPcV49(validSave())).toMatchObject({
      valid: true,
      magic: 0x14e,
      contentSize: 0x220,
      version: 49,
      buildMarker: "6a4b716a45ed4447",
      platformMarker: "d5cf106b395e5d10",
      pcSlotMarker: "bfe1bd115c5c51a2",
      errors: [],
    });
  });

  it("rejects changed payload bytes, markers, versions, and truncated files", () => {
    const checksumCorrupt = validSave();
    checksumCorrupt[0x200] = checksumCorrupt[0x200]! ^ 0xff;
    expect(analyzeGhostOfTsushimaPcV49(checksumCorrupt).errors).toContain("CHECKSUM_INVALID");
    const markerCorrupt = validSave();
    markerCorrupt[0x188] = markerCorrupt[0x188]! ^ 0xff;
    expect(analyzeGhostOfTsushimaPcV49(markerCorrupt).errors).toContain("PLATFORM_MARKER_MISMATCH");
    const versionCorrupt = validSave();
    versionCorrupt.writeUInt32LE(50, 12);
    expect(analyzeGhostOfTsushimaPcV49(versionCorrupt).errors).toContain("VERSION_UNSUPPORTED");
    expect(analyzeGhostOfTsushimaPcV49(Buffer.alloc(8)).valid).toBe(false);
  });
});
