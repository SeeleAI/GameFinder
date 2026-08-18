import { createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ZipFile } from "yazl";
import { afterEach, describe, expect, it } from "vitest";

import { inspectArchive, type DownloadReceipt } from "../src/download-verifier.js";
import { sha256File } from "../src/install/file-hash.js";
import type { NexusSaveResearchClient } from "../src/save/source/save-source-service.js";
import { SaveSourceService } from "../src/save/source/save-source-service.js";
import { parseSpeedrunResourcesPage } from "../src/save/source/speedrun-resources-parser.js";
import { SaveService } from "../src/save/save-service.js";
import {
  parseBsdtarList,
  type RarCommandRunner,
  SaveInputInspector,
} from "../src/save/package/input-inspector.js";
import { SavePackageNormalizer } from "../src/save/package/package-normalizer.js";
import { SaveContextStore } from "../src/save/storage/context-store.js";
import type { ModRequirements, NexusMod, NexusModFile } from "../src/types.js";
import { gameInstallContextFixture } from "./fixtures/save-contract-fixtures.js";

const temporaryDirectories: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "save-m4-source-"));
  temporaryDirectories.push(root);
  return root;
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
    for (const entry of entries) archive.addBuffer(Buffer.from(entry.content), entry.path);
    archive.end();
  });
}

const requirements: ModRequirements = {
  dlcRequirements: [{ id: "dlc", gameId: "1245620", name: "Shadow of the Erdtree", notes: null }],
  nexusRequirements: [],
  modsRequiringThisMod: [],
  counts: { nexusRequirements: 0, modsRequiringThisMod: 0 },
};

function nexusMod(description = "100 percent complete base game and DLC save. Patch 1.16.1. Multiplayer safe."): NexusMod {
  return {
    modId: 6732,
    name: "Base Game and DLC 100 Percent Complete Save File",
    summary: "Level 200 first run NG Plus ready save",
    description,
    version: "1.2.0",
    author: "fixture-author",
    uploadedBy: "fixture-author",
    domainName: "eldenring",
    categoryId: 7,
    containsAdultContent: false,
    status: "published",
    available: true,
    totalDownloads: 50_000,
    uniqueDownloads: 40_000,
    endorsements: 1_200,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
    pictureUrl: null,
    canonicalUrl: "https://www.nexusmods.com/eldenring/mods/6732",
  };
}

const nexusFile: NexusModFile = {
  fileId: 46818,
  name: "LVL 200 Wretch NG plus 0",
  version: "1.2.0",
  categoryId: 1,
  categoryName: "MAIN",
  fileName: "LVL-200-Wretch-NG-plus-0.zip",
  sizeKb: 1,
  sizeInBytes: null,
  uploadedAt: "2026-05-24T00:00:00.000Z",
  isPrimary: true,
  description: "DLC 100 percent complete save for patch 1.16.1",
  contentPreviewLink: "https://file-metadata.nexusmods.com/file/nexus-files/4333/46818.json",
};

class FakeNexusSaveClient implements NexusSaveResearchClient {
  description = nexusMod().description;

  async searchMods() {
    const mod = nexusMod(this.description);
    return {
      mods: [{
        modId: mod.modId,
        name: mod.name,
        summary: mod.summary,
        totalDownloads: mod.totalDownloads,
        endorsements: mod.endorsements,
      }],
      totalCount: 1,
      quota: null,
    };
  }

  async getMod() { return { mod: nexusMod(this.description), quota: null }; }
  async getModFiles() { return { files: [nexusFile], quota: null }; }
  async getModRequirements() { return { requirements, quota: null }; }
}

const oriResourcesHtml = `
  <h2>Tools</h2>
  <table><tr><td><a href="/ori_wotw/resources/tool1">Routing Tool</a></td></tr></table>
  <h2>Splits</h2><p>No Splits</p>
  <h2>Saves</h2>
  <table><tr><td><a href="/ori_wotw/resources/d8tcc">All Cell Fragment Saves</a></td><td>BigDeutsch</td></tr></table>
  <h2>Patches</h2><p>No Patches</p>
`;

const oriDetailHtml = `
  <h1>Save: All Cell Fragment Saves</h1>
  <div>Updated 2 years ago by BigDeutsch</div>
  <p>Check the readme for information about the save states.</p>
  <a href="https://downloads.example.test/AllCellFragmentsSaveStates.zip?token=secret">Download AllCellFragmentsSaveStates.zip</a>
  <h2>Game stats</h2>
`;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(
      async (directory) => await rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("save M4 Speedrun resources parser", () => {
  it("parses only the Saves section and resolves resource detail downloads", () => {
    const parsed = parseSpeedrunResourcesPage({
      html: oriResourcesHtml,
      pageUrl: "https://www.speedrun.com/ori_wotw/resources",
      detailPages: {
        "https://www.speedrun.com/ori_wotw/resources/d8tcc": oriDetailHtml,
      },
    });
    expect(parsed.noSaves).toBe(false);
    expect(parsed.resources).toHaveLength(1);
    expect(parsed.resources[0]).toMatchObject({
      resourceId: "d8tcc",
      title: "All Cell Fragment Saves",
      downloadUrl: "https://downloads.example.test/AllCellFragmentsSaveStates.zip?token=secret",
    });
    expect(parsed.resources.some((resource) => resource.title === "Routing Tool")).toBe(false);
  });

  it("treats an explicit No Saves section as empty without promoting Tools", () => {
    const parsed = parseSpeedrunResourcesPage({
      html: "<h2>Tools</h2><a href='/eldenring/resources/tool'>Tool</a><h2>Saves</h2><p>No Saves</p><h2>Patches</h2>",
      pageUrl: "https://www.speedrun.com/eldenring/resources",
    });
    expect(parsed).toMatchObject({ gameSlug: "eldenring", noSaves: true, resources: [] });
  });
});

describe("save M4 7z input capability", () => {
  it("safely inventories and normalizes a bsdtar-backed 7z save payload", async () => {
    const root = await tempRoot();
    const managerRoot = path.join(root, "manager");
    const sourceRoot = path.join(root, "source", "76561198127396738");
    const archivePath = path.join(root, "downloaded-save.7z");
    await mkdir(sourceRoot, { recursive: true });
    await Promise.all([
      writeFile(path.join(sourceRoot, "ER0000.sl2"), "7z-main"),
      writeFile(path.join(sourceRoot, "ER0000.sl2.bak"), "7z-bak"),
      writeFile(archivePath, "fixture-7z-container"),
    ]);
    const names = [
      "76561198127396738/",
      "76561198127396738/ER0000.sl2",
      "76561198127396738/ER0000.sl2.bak",
    ].join("\n");
    const verbose = [
      "drwxrwxrwx  0 0 0 0 Aug 18 00:00 76561198127396738/",
      "-rw-rw-rw-  0 0 0 7 Aug 18 00:00 76561198127396738/ER0000.sl2",
      "-rw-rw-rw-  0 0 0 6 Aug 18 00:00 76561198127396738/ER0000.sl2.bak",
    ].join("\n");
    const runner: RarCommandRunner = {
      async run(_executablePath, args) {
        if (args[0] === "-tf") return { stdout: names, stderr: "" };
        if (args[0] === "-tvf") return { stdout: verbose, stderr: "" };
        if (args[0] === "-xf") {
          const destination = args[args.indexOf("-C") + 1]!;
          const target = path.join(destination, "76561198127396738");
          await mkdir(target, { recursive: true });
          await Promise.all([
            copyFile(path.join(sourceRoot, "ER0000.sl2"), path.join(target, "ER0000.sl2")),
            copyFile(path.join(sourceRoot, "ER0000.sl2.bak"), path.join(target, "ER0000.sl2.bak")),
          ]);
        }
        return { stdout: "", stderr: "" };
      },
    };
    const inspector = await SaveInputInspector.create({
      managerRoot,
      rarCapability: null,
      sevenZipCapability: {
        kind: "bsdtar",
        executablePath: path.join(root, "tar.exe"),
        version: "3.8.4",
        runner,
      },
    });
    const normalizer = await SavePackageNormalizer.create({ managerRoot, inspector });
    const inspection = await inspector.inspect(archivePath);
    expect(inspection).toMatchObject({
      input: { kind: "7z" },
      archive: { format: "7z", extractor: { kind: "bsdtar", version: "3.8.4" } },
    });
    expect(inspection.payloadCandidates).toHaveLength(1);
    const savePackage = await normalizer.normalize({
      inspectionId: inspection.inspectionId,
      payloadSelectionId: inspection.payloadCandidates[0]!.payloadSelectionId,
    });
    expect(savePackage.payload.files.map((file) => file.relativePath)).toEqual([
      "ER0000.sl2",
      "ER0000.sl2.bak",
    ]);
    expect(await normalizer.verify(savePackage.packageId)).toEqual(savePackage);
  });

  it("rejects link-like 7z entries before extraction", () => {
    expect(() => parseBsdtarList({
      names: "save/link",
      verbose: "lrwxrwxrwx  0 0 0 0 Aug 18 00:00 save/link -> target",
    })).toThrowError(expect.objectContaining({ code: "SAVE_ARCHIVE_UNSAFE" }));
  });
});

describe("save M4 immutable source research", () => {
  it("freezes exact Nexus Mod/File metadata and reports changed/removed drift", async () => {
    const root = await tempRoot();
    const client = new FakeNexusSaveClient();
    const service = await SaveSourceService.create({
      managerRoot: path.join(root, "manager"),
      nexus: client,
    });
    const game = { canonicalId: "steam:1245620", displayName: "ELDEN RING", storeAppId: "1245620" };
    const first = await service.researchNexus({ game, domainName: "eldenring", maxCandidates: 5 });
    expect(first.candidates).toHaveLength(1);
    expect(first.candidates[0]).toMatchObject({
      source: "nexus",
      status: "available",
      claims: {
        gameVersion: "1.16.1",
        onlineSafety: "author-claimed",
      },
      selection: { kind: "nexus", modId: 6732, fileId: 46818, categoryName: "MAIN" },
    });
    expect(first.candidates[0]!.claims.dlc).toContain("Shadow of the Erdtree");

    await new Promise((resolve) => setTimeout(resolve, 2));
    client.description = "Complete save metadata changed. Patch 1.16.2.";
    const second = await service.researchNexus({ game, domainName: "eldenring", maxCandidates: 5 });
    expect(second.snapshot.previousSnapshotId).toBe(first.snapshot.snapshotId);
    expect(second.snapshot.drift).toContainEqual(expect.objectContaining({
      stableKey: "nexus:eldenring:6732:46818",
      state: "changed",
    }));

    const removedClient: NexusSaveResearchClient = {
      searchMods: async () => ({ mods: [], totalCount: 0, quota: null }),
      getMod: async () => await client.getMod(),
      getModFiles: async () => await client.getModFiles(),
      getModRequirements: async () => await client.getModRequirements(),
    };
    const removedService = await SaveSourceService.create({
      managerRoot: path.join(root, "manager"),
      nexus: removedClient,
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const removed = await removedService.researchNexus({ game, domainName: "eldenring" });
    expect(removed.snapshot.drift).toContainEqual(expect.objectContaining({
      stableKey: "nexus:eldenring:6732:46818",
      state: "removed",
    }));
  });

  it("downloads a direct Speedrun resource with redacted redirect provenance", async () => {
    const root = await tempRoot();
    const zipPath = path.join(root, "source.zip");
    await writeZip(zipPath, [{ path: "save.dat", content: "speedrun-save" }]);
    const zipBytes = await import("node:fs/promises").then(async ({ readFile }) => await readFile(zipPath));
    const client = new FakeNexusSaveClient();
    const source = await SaveSourceService.create({
      managerRoot: path.join(root, "manager"),
      nexus: client,
      fetch: async (url) => {
        if (url.startsWith("https://downloads.example.test/")) {
          return new Response(null, { status: 302, headers: { location: "https://cdn.example.test/save.zip?signature=private" } });
        }
        return new Response(zipBytes, {
          status: 200,
          headers: {
            "content-length": String(zipBytes.length),
            "content-type": "application/zip",
            "content-disposition": 'attachment; filename="ori-practice-saves.zip"',
          },
        });
      },
    });
    const research = await source.researchSpeedrunFromSnapshot({
      game: { canonicalId: "steam:1057090", displayName: "Ori", storeAppId: "1057090" },
      pageUrl: "https://www.speedrun.com/ori_wotw/resources",
      pageHtml: oriResourcesHtml,
      detailPages: { "https://www.speedrun.com/ori_wotw/resources/d8tcc": oriDetailHtml },
      fetchMode: "fixture",
    });
    const receipt = await source.downloadSpeedrun({
      candidateId: research.candidates[0]!.candidateId,
      outputDirectory: path.join(root, "downloads"),
    });
    expect(receipt).toMatchObject({
      backend: "http",
      finalFileName: "ori-practice-saves.zip",
      contentType: "application/zip",
      status: "verified",
    });
    expect(receipt.finalUrl).toBe("https://cdn.example.test/save.zip");
    expect(receipt.redirectChain.join(" ")).not.toContain("secret");
    expect(receipt.redirectChain.join(" ")).not.toContain("private");
    expect(await source.verifyReceipt(receipt.receiptId)).toEqual(receipt);
  });
});

describe("save M4 verified receipt to Standard Save Package", () => {
  it("binds an existing Nexus receipt and preserves source claims through normalization", async () => {
    const root = await tempRoot();
    const managerRoot = path.join(root, "manager");
    const archivePath = path.join(root, nexusFile.fileName);
    await writeZip(archivePath, [
      { path: "DLC 100 percent/ER0000.sl2", content: "downloaded-save" },
    ]);
    const info = await stat(archivePath);
    const [sha256, archiveCheck] = await Promise.all([
      sha256File(archivePath),
      inspectArchive(archivePath, path.basename(archivePath), info.size),
    ]);
    const nexusReceiptPath = `${archivePath}.nexus-receipt.json`;
    const nexusReceipt: DownloadReceipt = {
      schemaVersion: 1,
      backend: "native",
      canonicalModUrl: "https://www.nexusmods.com/eldenring/mods/6732",
      domainName: "eldenring",
      modId: 6732,
      fileId: 46818,
      fileName: path.basename(archivePath),
      bytes: info.size,
      sha256,
      completedAt: new Date().toISOString(),
      absolutePath: archivePath,
      targetPath: archivePath,
      receiptPath: nexusReceiptPath,
      archiveValid: archiveCheck.valid,
      archiveCheck,
    };
    await writeFile(nexusReceiptPath, `${JSON.stringify(nexusReceipt, null, 2)}\n`);

    const contexts = await SaveContextStore.create(managerRoot);
    const install = gameInstallContextFixture();
    await contexts.saveInstallContext(install);
    const service = await SaveService.create({
      managerRoot,
      nexusClient: new FakeNexusSaveClient(),
    });
    const research = await service.researchNexusSaveSources({
      installContextId: install.installContextId,
      maxCandidates: 5,
    });
    const receipt = await service.recordNexusSaveDownload({
      candidateId: research.candidates[0]!.candidateId,
      nexusReceiptPath,
    });
    const inspection = await service.inspectDownloadedSave(receipt.receiptId);
    expect(inspection.payloadCandidates).toHaveLength(1);
    const savePackage = await service.normalizeDownloadedSavePackage({
      receiptId: receipt.receiptId,
      inspectionId: inspection.inspectionId,
      payloadSelectionId: inspection.payloadCandidates[0]!.payloadSelectionId,
    });
    expect(savePackage.source).toMatchObject({
      kind: "nexus",
      downloadReceiptId: receipt.receiptId,
      pageUrl: "https://www.nexusmods.com/eldenring/mods/6732",
      originalInputPath: null,
      originalInputSha256: sha256,
    });
    expect(savePackage.claims.progress).toContain("100");
    expect(savePackage.claims.onlineSafety).toBe("author-claimed");
    expect(await service.verifyStandardSavePackage(savePackage.packageId)).toEqual(savePackage);

    await writeFile(archivePath, "tampered");
    await expect(service.verifySaveDownloadReceipt(receipt.receiptId)).rejects.toMatchObject({
      code: "SAVE_SOURCE_UNAVAILABLE",
    });
  });
});
