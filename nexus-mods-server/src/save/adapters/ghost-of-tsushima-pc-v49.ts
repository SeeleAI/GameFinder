export interface GhostOfTsushimaPcV49Analysis {
  valid: boolean;
  magic: number;
  contentSize: number;
  checksum: number;
  computedChecksum: number;
  version: number;
  buildMarker: string;
  platformMarker: string;
  pcSlotMarker: string;
  errors: string[];
}

const MAGIC = 0x0000_014e;
const VERSION_PC = 49;
const MINIMUM_BYTES = 0x198;
const MAXIMUM_BYTES = 16 * 1024 * 1024;
const BUILD_MARKER = "6a4b716a45ed4447";
const PLATFORM_MARKER_PC = "d5cf106b395e5d10";
const PC_SLOT_MARKER = "bfe1bd115c5c51a2";

function marker(bytes: Uint8Array, start: number): string {
  return Buffer.from(bytes.subarray(start, start + 8)).toString("hex");
}

export function analyzeGhostOfTsushimaPcV49(bytes: Uint8Array): GhostOfTsushimaPcV49Analysis {
  const errors: string[] = [];
  if (bytes.length < MINIMUM_BYTES || bytes.length > MAXIMUM_BYTES) {
    errors.push("FILE_SIZE_OUT_OF_SCOPE");
  }
  const view = bytes.length >= 16
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : null;
  const magic = view?.getUint32(0, true) ?? 0;
  const contentSize = view?.getUint32(4, true) ?? 0;
  const checksum = view?.getUint32(8, true) ?? 0;
  const version = view?.getUint32(12, true) ?? 0;
  if (magic !== MAGIC) errors.push("MAGIC_MISMATCH");
  if (contentSize !== bytes.length) errors.push("CONTENT_SIZE_MISMATCH");
  if (version !== VERSION_PC) errors.push("VERSION_UNSUPPORTED");
  const buildMarker = bytes.length >= 0x188 ? marker(bytes, 0x180) : "";
  const platformMarker = bytes.length >= 0x190 ? marker(bytes, 0x188) : "";
  const pcSlotMarker = bytes.length >= 0x198 ? marker(bytes, 0x190) : "";
  if (buildMarker !== BUILD_MARKER) errors.push("BUILD_MARKER_MISMATCH");
  if (platformMarker !== PLATFORM_MARKER_PC) errors.push("PLATFORM_MARKER_MISMATCH");
  if (pcSlotMarker !== PC_SLOT_MARKER) errors.push("PC_SLOT_MARKER_MISMATCH");
  let sum = BigInt(contentSize) + BigInt(magic) + BigInt(version);
  const end = Math.min(contentSize, bytes.length);
  for (let index = 0x10; index < end; index += 1) sum += BigInt(bytes[index]!);
  const computedChecksum = Number(sum & 0xffff_ffffn);
  if (computedChecksum !== checksum) errors.push("CHECKSUM_INVALID");
  return {
    valid: errors.length === 0,
    magic,
    contentSize,
    checksum,
    computedChecksum,
    version,
    buildMarker,
    platformMarker,
    pcSlotMarker,
    errors,
  };
}
