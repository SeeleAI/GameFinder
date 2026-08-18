import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sha256File } from "../src/install/file-hash.js";
import {
  DEFAULT_SAVE_INPUT_LIMITS,
  type RarCommandRunner,
  SaveInputInspector,
  parseUnrarTechnicalList,
} from "../src/save/package/input-inspector.js";
import { SavePackageNormalizer } from "../src/save/package/package-normalizer.js";

const temporaryDirectories: string[] = [];

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

async function createRarFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "save-m3-package-"));
  temporaryDirectories.push(root);
  const managerRoot = path.join(root, "manager");
  const sourceRoot = path.join(root, "rar-source", "76561198127396738");
  const rarPath = path.join(root, "76561198127396738.rar");
  await Promise.all([
    mkdir(managerRoot, { recursive: true }),
    mkdir(sourceRoot, { recursive: true }),
  ]);
  const contents = new Map([
    ["ER0000.sl2", "old-primary"],
    ["ER0000.sl2.bak", "old-companion"],
    ["steam_autocloud.vdf", "old-cloud"],
  ]);
  for (const [name, content] of contents) {
    await writeFile(path.join(sourceRoot, name), content);
  }
  await writeFile(rarPath, "fixture-rar-immutable-input");
  const list = technicalList([
    ...[...contents].map(([name, content]) => ({
      name: `76561198127396738\\${name}`,
      size: Buffer.byteLength(content),
      packed: Buffer.byteLength(content),
    })),
    { name: "76561198127396738", type: "Directory", size: 0, packed: 0 },
  ]);
  const runner: RarCommandRunner = {
    async run(_executablePath, args) {
      if (args[0] === "lt") return { stdout: list, stderr: "" };
      if (args[0] === "x") {
        const destination = args.at(-1);
        if (!destination) throw new Error("missing destination");
        const targetRoot = path.join(destination, "76561198127396738");
        await mkdir(targetRoot, { recursive: true });
        for (const name of contents.keys()) {
          await copyFile(path.join(sourceRoot, name), path.join(targetRoot, name));
        }
      }
      return { stdout: "", stderr: "" };
    },
  };
  const inspector = await SaveInputInspector.create({
    managerRoot,
    rarCapability: {
      executablePath: path.join(root, "UnRAR.exe"),
      version: "7.12",
      runner,
    },
  });
  const normalizer = await SavePackageNormalizer.create({ managerRoot, inspector });
  return { root, managerRoot, sourceRoot, rarPath, inspector, normalizer };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(
      async (directory) => await rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("save M3 input inspection", () => {
  it("identifies one Elden Ring wrapper payload from a read-only RAR inventory", async () => {
    const fixture = await createRarFixture();
    const before = await sha256File(fixture.rarPath);
    const inspection = await fixture.inspector.inspect(fixture.rarPath);
    expect(inspection.input).toMatchObject({
      kind: "rar",
      sha256: before,
    });
    expect(inspection.archive).toMatchObject({
      format: "rar",
      extractor: { kind: "unrar", version: "7.12" },
      commonTopLevelDirectory: "76561198127396738",
    });
    expect(inspection.payloadCandidates).toHaveLength(1);
    expect(inspection.payloadCandidates[0]).toMatchObject({
      root: "76561198127396738",
      unitId: "vanilla-main",
      binding: { kind: "steam_id64", value: "76561198127396738" },
      confidence: "confirmed",
    });
    expect(inspection.payloadCandidates[0]?.files.map((file) => file.relativePath)).toEqual([
      "ER0000.sl2",
      "ER0000.sl2.bak",
      "steam_autocloud.vdf",
    ]);
    expect(await sha256File(fixture.rarPath)).toBe(before);
  });

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

describe("save M3 package normalization", () => {
  it("publishes and re-verifies a deterministic immutable Standard Save Package", async () => {
    const fixture = await createRarFixture();
    const inputBefore = await sha256File(fixture.rarPath);
    const inspection = await fixture.inspector.inspect(fixture.rarPath);
    const selection = inspection.payloadCandidates[0]!;
    const first = await fixture.normalizer.normalize({
      inspectionId: inspection.inspectionId,
      payloadSelectionId: selection.payloadSelectionId,
    });
    expect(first.packageId).toMatch(/^savepkg-[a-f0-9]{64}$/);
    expect(first.payload.files.map((file) => file.relativePath)).toEqual([
      "ER0000.sl2",
      "ER0000.sl2.bak",
      "steam_autocloud.vdf",
    ]);
    expect(first.binding).toEqual({ kind: "steam_id64", value: "76561198127396738" });
    expect(await fixture.normalizer.verify(first.packageId)).toEqual(first);
    const repeated = await fixture.normalizer.normalize({
      inspectionId: inspection.inspectionId,
      payloadSelectionId: selection.payloadSelectionId,
    });
    expect(repeated.packageId).toBe(first.packageId);
    expect(repeated).toEqual(first);
    expect(await sha256File(fixture.rarPath)).toBe(inputBefore);
  });

  it("rejects normalization if the inspected original input changes", async () => {
    const fixture = await createRarFixture();
    const inspection = await fixture.inspector.inspect(fixture.rarPath);
    await writeFile(fixture.rarPath, "tampered-rar");
    await expect(
      fixture.normalizer.normalize({
        inspectionId: inspection.inspectionId,
        payloadSelectionId: inspection.payloadCandidates[0]!.payloadSelectionId,
      }),
    ).rejects.toMatchObject({ code: "SAVE_PACKAGE_INVALID" });
  });

  it("detects corruption of a published package payload", async () => {
    const fixture = await createRarFixture();
    const inspection = await fixture.inspector.inspect(fixture.rarPath);
    const manifest = await fixture.normalizer.normalize({
      inspectionId: inspection.inspectionId,
      payloadSelectionId: inspection.payloadCandidates[0]!.payloadSelectionId,
    });
    const payloadRoot = fixture.normalizer.packageStore.payloadRoot(manifest.packageId);
    await writeFile(path.join(payloadRoot, "ER0000.sl2"), "corrupt");
    await expect(fixture.normalizer.verify(manifest.packageId)).rejects.toMatchObject({
      code: "SAVE_PACKAGE_INVALID",
    });
  });
});
