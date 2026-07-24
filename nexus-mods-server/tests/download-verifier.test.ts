import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStagingPath,
  finalizeDownloadedFile,
  sanitizeDownloadFileName
} from "../src/download-verifier.js";

const emptyZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixtureDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function finalizeFixture(
  outputDirectory: string,
  content: Buffer,
  overrides: Partial<Parameters<typeof finalizeDownloadedFile>[0]> = {}
) {
  const staging = await createStagingPath({
    outputDirectory,
    sessionId: "fixture-session",
    preferredFileName: "fixture.zip"
  });
  await writeFile(staging.stagingPath, content);
  return finalizeDownloadedFile({
    backend: "persistent_chromium",
    canonicalModUrl: "https://www.nexusmods.com/eldenring/mods/9531",
    domainName: "eldenring",
    modId: 9531,
    fileId: 47215,
    expectedSizeInBytes: content.length,
    outputDirectory,
    stagingPath: staging.stagingPath,
    suggestedFileName: "fixture.zip",
    apiFileName: "ErdGameTools.zip",
    ...overrides
  });
}

describe("shared download verifier", () => {
  it("sanitizes traversal, Windows reserved names, controls, and bidi markers", () => {
    expect(sanitizeDownloadFileName("../CON\u202E?.zip")).toBe(".._CON__.zip");
    expect(sanitizeDownloadFileName("NUL")).toBe("_NUL");
    expect(sanitizeDownloadFileName("  ")).toBe("nexus-mod-file");
  });

  it("finalizes a valid archive and writes a unified browser receipt", async () => {
    const outputDirectory = await fixtureDirectory("nexus-verifier-success-");
    const receipt = await finalizeFixture(outputDirectory, emptyZip);

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      backend: "persistent_chromium",
      fileName: "fixture.zip",
      bytes: emptyZip.length,
      archiveValid: true,
      browser: { engine: "chromium", backend: "playwright" }
    });
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(receipt.absolutePath)).toEqual(emptyZip);
    expect(JSON.parse(await readFile(receipt.receiptPath, "utf8"))).toMatchObject({
      backend: "persistent_chromium",
      sha256: receipt.sha256
    });
  });

  it("rejects a declared-size mismatch and an invalid ZIP", async () => {
    const sizeDirectory = await fixtureDirectory("nexus-verifier-size-");
    await expect(
      finalizeFixture(sizeDirectory, emptyZip, { expectedSizeInBytes: emptyZip.length + 1 })
    ).rejects.toMatchObject({ code: "DOWNLOAD_SIZE_MISMATCH" });

    const archiveDirectory = await fixtureDirectory("nexus-verifier-archive-");
    await expect(
      finalizeFixture(archiveDirectory, Buffer.from("not-a-zip"), {
        suggestedFileName: "broken.zip"
      })
    ).rejects.toMatchObject({ code: "ARCHIVE_INVALID" });
  });

  it("does not overwrite an existing final archive", async () => {
    const outputDirectory = await fixtureDirectory("nexus-verifier-existing-");
    await writeFile(path.join(outputDirectory, "fixture.zip"), Buffer.from("keep"));
    await expect(finalizeFixture(outputDirectory, emptyZip)).rejects.toMatchObject({
      code: "OUTPUT_FILE_EXISTS"
    });
    expect(await readFile(path.join(outputDirectory, "fixture.zip"), "utf8")).toBe("keep");
  });
});
