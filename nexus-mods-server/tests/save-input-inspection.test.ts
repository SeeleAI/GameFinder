import { describe, expect, it } from "vitest";
import { parseUnrarTechnicalList, DEFAULT_SAVE_INPUT_LIMITS, parseBsdtarList } from "../src/save/generic/input-inspector.js";
function technicalList(entries: Array<{ name: string; type?: string; size?: number; packed?: number }>): string {
  return entries
    .map(
      (entry) => `
        Name: ${entry.name}
        Type: ${entry.type ?? "File"}
        Size: ${entry.size ?? 0}
 Packed size: ${entry.packed ?? entry.size ?? 0}
       CRC32: E8D77F15
`,
    )
    .join("\n");
}

describe("save archive inventory safety", () => {
  it("rejects traversal, links, duplicates, and excessive compression ratios", () => {
    expect(() => parseUnrarTechnicalList(technicalList([{ name: "..\\escape.sl2", size: 1 }])))
      .toThrowError(expect.objectContaining({ code: "SAVE_ARCHIVE_UNSAFE" }));
    expect(() => parseUnrarTechnicalList(technicalList([{ name: "link", type: "Symbolic Link" }])))
      .toThrowError(expect.objectContaining({ code: "SAVE_ARCHIVE_UNSAFE" }));
    expect(() => parseUnrarTechnicalList(technicalList([
      { name: "Save\\ER0000.sl2", size: 1 },
      { name: "save\\er0000.sl2", size: 1 },
    ]))).toThrowError(expect.objectContaining({ code: "SAVE_ARCHIVE_UNSAFE" }));
    expect(() => parseUnrarTechnicalList(
      technicalList([{ name: "save\\ER0000.sl2", size: 10_001, packed: 1 }]),
      { ...DEFAULT_SAVE_INPUT_LIMITS, maxCompressionRatio: 100 },
    )).toThrowError(expect.objectContaining({ code: "SAVE_ARCHIVE_UNSAFE" }));
  });
});

it("rejects 7z link listings, case collisions and overlarge entries", () => {
  expect(() => parseBsdtarList({ names: "save/link", verbose: "lrwxrwxrwx 0 0 0 0 Aug 18 00:00 save/link -> target" })).toThrow();
  expect(() => parseBsdtarList({ names: "save/a\nsave/A", verbose: "-rw-r--r-- 0 0 0 1 Aug 18 00:00 save/a\n-rw-r--r-- 0 0 0 1 Aug 18 00:00 save/A" })).toThrow();
  expect(() => parseBsdtarList({ names: "save/a", verbose: "-rw-r--r-- 0 0 0 10 Aug 18 00:00 save/a" }, { ...DEFAULT_SAVE_INPUT_LIMITS, maxSingleEntryBytes: 2 })).toThrow();
});
it("stages RAR inventory through the same opaque-file route without game inference", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
  const os = await import("node:os"); const path = await import("node:path");
  const { SaveInputInspector } = await import("../src/save/generic/input-inspector.js");
  const { stageSaveInput } = await import("../src/save/generic/input.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "save-rar-stage-"));
  try {
    const inputPath = path.join(root, "unknown.rar"); await writeFile(inputPath, "rar fixture");
    const inspector = await SaveInputInspector.create({ managerRoot: path.join(root, "manager"), sevenZipCapability: null,
      rarCapability: { executablePath: "fixture-unrar", version: "1", runner: { run: async (_exe, args) => {
        if (args[0] === "lt") return { stdout: technicalList([{ name: "wrapper/opaque.sav", size: 5, packed: 5 }]), stderr: "" };
        if (args[0] === "x") { const dir = path.join(args.at(-1)!, "wrapper"); await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, "opaque.sav"), "bytes"); }
        return { stdout: "", stderr: "" };
      } } }
    });
    const result = await stageSaveInput(inspector, inputPath, path.join(root, "staging"));
    expect(result.stagedInput.files.map(file => file.relativePath)).toEqual(["wrapper/opaque.sav"]);
    expect(await readFile(path.join(result.stagedInput.root, "wrapper", "opaque.sav"), "utf8")).toBe("bytes");
  } finally { await rm(root, { recursive: true, force: true }); }
});
