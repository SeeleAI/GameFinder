import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ZipFile } from "yazl";
import { afterEach, describe, expect, it } from "vitest";

import type { DownloadReceipt } from "../src/download-verifier.js";
import { NexusError } from "../src/errors.js";
import {
  analyzePackageInventory,
  inspectZipArchive,
  sha256File,
  verifyInstallInput,
} from "../src/install/index.js";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "nexus-install-input-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeZip(
  zipPath: string,
  entries: ReadonlyArray<{ path: string; content: string }>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const archive = new ZipFile();
    const output = createWriteStream(zipPath, { flags: "wx" });
    output.on("close", resolve);
    output.on("error", reject);
    archive.outputStream.on("error", reject);
    archive.outputStream.pipe(output);
    for (const entry of entries) {
      archive.addBuffer(Buffer.from(entry.content), entry.path);
    }
    archive.end();
  });
}

async function writeReceipt(input: {
  archivePath: string;
  receiptPath: string;
  sha256?: string;
  bytes?: number;
}): Promise<DownloadReceipt> {
  const archiveInfo = await stat(input.archivePath);
  const receipt: DownloadReceipt = {
    schemaVersion: 1,
    backend: "persistent_chromium",
    canonicalModUrl: "https://www.nexusmods.com/stardewvalley/mods/2697",
    domainName: "stardewvalley",
    modId: 2697,
    fileId: 115145,
    fileName: path.basename(input.archivePath),
    bytes: input.bytes ?? archiveInfo.size,
    sha256: input.sha256 ?? (await sha256File(input.archivePath)),
    completedAt: "2026-07-26T12:00:00.000Z",
    absolutePath: input.archivePath,
    targetPath: input.archivePath,
    receiptPath: input.receiptPath,
    archiveValid: true,
    archiveCheck: {
      format: "zip",
      valid: true,
      detail: "ZIP end-of-central-directory record found.",
    },
    browser: {
      engine: "chromium",
      backend: "playwright",
    },
  };
  await writeFile(input.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("verifyInstallInput", () => {
  it("recomputes and binds the archive to its Nexus download receipt", async () => {
    const directory = await makeTemporaryDirectory();
    const archivePath = path.join(directory, "SkipFishingMinigame.zip");
    const receiptPath = `${archivePath}.nexus-receipt.json`;
    await writeZip(archivePath, [
      {
        path: "SkipFishingMinigame/manifest.json",
        content: '{"UniqueID":"DewMods.SkipFishingMinigame"}',
      },
    ]);
    const receipt = await writeReceipt({ archivePath, receiptPath });

    const result = await verifyInstallInput({
      archivePath,
      receiptPath,
      expectedSource: {
        domainName: "stardewvalley",
        modId: 2697,
        fileId: 115145,
      },
    });

    expect(result.archive.sha256).toBe(receipt.sha256);
    expect(result.archive.bytes).toBe(receipt.bytes);
    expect(result.source).toMatchObject({
      domainName: "stardewvalley",
      modId: 2697,
      fileId: 115145,
    });
  });

  it("rejects an archive modified after its receipt was written", async () => {
    const directory = await makeTemporaryDirectory();
    const archivePath = path.join(directory, "mod.zip");
    const receiptPath = `${archivePath}.nexus-receipt.json`;
    await writeZip(archivePath, [{ path: "Mod/file.dll", content: "first" }]);
    const originalHash = await sha256File(archivePath);
    await writeReceipt({ archivePath, receiptPath, sha256: originalHash });

    const original = await readFile(archivePath);
    await writeFile(archivePath, Buffer.concat([original, Buffer.from("tampered")]));

    await expect(
      verifyInstallInput({ archivePath, receiptPath }),
    ).rejects.toMatchObject({
      code: "INPUT_RECEIPT_MISMATCH",
    });
  });

  it("rejects a receipt for another Nexus file", async () => {
    const directory = await makeTemporaryDirectory();
    const archivePath = path.join(directory, "mod.zip");
    const receiptPath = `${archivePath}.nexus-receipt.json`;
    await writeZip(archivePath, [{ path: "Mod/file.dll", content: "payload" }]);
    await writeReceipt({ archivePath, receiptPath });

    await expect(
      verifyInstallInput({
        archivePath,
        receiptPath,
        expectedSource: {
          domainName: "stardewvalley",
          modId: 999,
          fileId: 115145,
        },
      }),
    ).rejects.toMatchObject({
      code: "INPUT_RECEIPT_MISMATCH",
    });
  });
});

describe("inspectZipArchive", () => {
  it("enumerates a ZIP without extracting it", async () => {
    const directory = await makeTemporaryDirectory();
    const archivePath = path.join(directory, "SkipFishingMinigame.zip");
    await writeZip(archivePath, [
      {
        path: "SkipFishingMinigame/manifest.json",
        content: '{"UniqueID":"DewMods.SkipFishingMinigame"}',
      },
      {
        path: "SkipFishingMinigame/SkipFishingMinigame.dll",
        content: "test-dll",
      },
    ]);
    const archiveInfo = await stat(archivePath);
    const archive = {
      absolutePath: archivePath,
      fileName: path.basename(archivePath),
      bytes: archiveInfo.size,
      sha256: await sha256File(archivePath),
    };

    const inventory = await inspectZipArchive({ archive });

    expect(inventory.format).toBe("zip");
    expect(inventory.commonTopLevelDirectory).toBe("SkipFishingMinigame");
    expect(inventory.entries.map((entry) => entry.normalizedPath)).toEqual([
      "SkipFishingMinigame/manifest.json",
      "SkipFishingMinigame/SkipFishingMinigame.dll",
    ]);
    expect(
      await stat(path.join(directory, "SkipFishingMinigame")).catch(() => null),
    ).toBeNull();
  });

  it("rejects case-colliding Windows paths", async () => {
    const directory = await makeTemporaryDirectory();
    const archivePath = path.join(directory, "collision.zip");
    await writeZip(archivePath, [
      { path: "Mod/Config.json", content: "{}" },
      { path: "mod/config.json", content: "{}" },
    ]);
    const archiveInfo = await stat(archivePath);

    await expect(
      inspectZipArchive({
        archive: {
          absolutePath: archivePath,
          fileName: path.basename(archivePath),
          bytes: archiveInfo.size,
          sha256: await sha256File(archivePath),
        },
      }),
    ).rejects.toMatchObject({
      code: "ARCHIVE_UNSAFE",
    });
  });

  it("enforces configurable entry limits before extraction", async () => {
    const directory = await makeTemporaryDirectory();
    const archivePath = path.join(directory, "many.zip");
    await writeZip(archivePath, [
      { path: "Mod/one.txt", content: "one" },
      { path: "Mod/two.txt", content: "two" },
    ]);
    const archiveInfo = await stat(archivePath);

    await expect(
      inspectZipArchive({
        archive: {
          absolutePath: archivePath,
          fileName: path.basename(archivePath),
          bytes: archiveInfo.size,
          sha256: await sha256File(archivePath),
        },
        limits: { maxEntries: 1 },
      }),
    ).rejects.toMatchObject({
      code: "ARCHIVE_LIMIT_EXCEEDED",
    });
  });

  it("rejects non-ZIP inputs in the first implementation", async () => {
    const directory = await makeTemporaryDirectory();
    const archivePath = path.join(directory, "mod.7z");
    await writeFile(archivePath, "not-a-supported-archive");

    await expect(
      inspectZipArchive({
        archive: {
          absolutePath: archivePath,
          fileName: path.basename(archivePath),
          bytes: (await stat(archivePath)).size,
          sha256: await sha256File(archivePath),
        },
      }),
    ).rejects.toBeInstanceOf(NexusError);
  });
});

describe("analyzePackageInventory", () => {
  it("recognizes a standard SMAPI folder from its bounded manifest", async () => {
    const directory = await makeTemporaryDirectory();
    const archivePath = path.join(directory, "SkipFishingMinigame.zip");
    await writeZip(archivePath, [
      {
        path: "SkipFishingMinigame/manifest.json",
        content: JSON.stringify({
          Name: "Skip Fishing Minigame",
          Author: "DewMods",
          Version: "0.7.4",
          UniqueID: "DewMods.SkipFishingMinigame",
          EntryDll: "SkipFishingMinigame.dll",
          MinimumApiVersion: "3.0.0",
        }),
      },
      {
        path: "SkipFishingMinigame/SkipFishingMinigame.dll",
        content: "test-dll",
      },
    ]);
    const archiveInfo = await stat(archivePath);
    const inventory = await inspectZipArchive({
      archive: {
        absolutePath: archivePath,
        fileName: path.basename(archivePath),
        bytes: archiveInfo.size,
        sha256: await sha256File(archivePath),
      },
    });

    const analysis = await analyzePackageInventory(inventory);

    expect(analysis.packages).toHaveLength(1);
    expect(analysis.packages[0]).toMatchObject({
      packageType: "loader-plugin",
      packageRoot: "SkipFishingMinigame",
      identity: {
        uniqueId: "DewMods.SkipFishingMinigame",
        name: "Skip Fishing Minigame",
        version: "0.7.4",
      },
    });
    expect(analysis.packages[0]?.dependencies).toContainEqual(
      expect.objectContaining({
        dependencyId: "Pathoschild.SMAPI",
        kind: "external",
        versionConstraint: "3.0.0",
      }),
    );
    expect(analysis.ambiguities).toEqual([]);
  });

  it("reports a missing declared entry DLL instead of guessing", async () => {
    const directory = await makeTemporaryDirectory();
    const archivePath = path.join(directory, "broken.zip");
    await writeZip(archivePath, [
      {
        path: "Broken/manifest.json",
        content: JSON.stringify({
          Name: "Broken Mod",
          Version: "1.0.0",
          UniqueID: "Example.Broken",
          EntryDll: "Missing.dll",
        }),
      },
    ]);
    const archiveInfo = await stat(archivePath);
    const inventory = await inspectZipArchive({
      archive: {
        absolutePath: archivePath,
        fileName: path.basename(archivePath),
        bytes: archiveInfo.size,
        sha256: await sha256File(archivePath),
      },
    });

    const analysis = await analyzePackageInventory(inventory);

    expect(analysis.ambiguities).toContainEqual(
      expect.objectContaining({
        code: "missing-entry-file",
      }),
    );
    expect(analysis.packages[0]?.negativeSignals[0]).toContain("Missing.dll");
  });
});
