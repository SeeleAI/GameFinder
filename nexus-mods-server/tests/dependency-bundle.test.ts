import { createHash } from "node:crypto";
import {
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  classifyDownloadPlanReview,
  DownloadBundleService,
} from "../src/download-bundle-service.js";
import type { DownloadReceipt } from "../src/download-verifier.js";
import { NexusClient } from "../src/nexus-client.js";
import type {
  ModRequirements,
  NexusGame,
  NexusMod,
  NexusModFile,
  QuotaSnapshot,
} from "../src/types.js";

const quota: QuotaSnapshot = {
  dailyLimit: 20_000,
  dailyRemaining: 19_900,
  hourlyLimit: 2_000,
  hourlyRemaining: 1_900,
};
const game: NexusGame = {
  id: 1303,
  name: "Stardew Valley",
  domainName: "stardewvalley",
};
const rootMod: NexusMod = {
  modId: 2697,
  name: "Skip Fishing Minigame",
  summary: "",
  description: "",
  version: "0.7.4",
  author: "DewMods",
  uploadedBy: "DewMods",
  domainName: "stardewvalley",
  categoryId: 1,
  containsAdultContent: false,
  status: "published",
  available: true,
  totalDownloads: 1,
  uniqueDownloads: 1,
  endorsements: 1,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  pictureUrl: null,
  canonicalUrl: "https://www.nexusmods.com/stardewvalley/mods/2697",
};
const smapiMod: NexusMod = {
  ...rootMod,
  modId: 2400,
  name: "SMAPI - Stardew Modding API",
  version: "4.1.1",
  canonicalUrl: "https://www.nexusmods.com/stardewvalley/mods/2400",
};
const rootFile: NexusModFile = {
  fileId: 115145,
  name: "SkipFishingMinigameDotnet5 0.7.4",
  version: "0.7.4",
  categoryId: 1,
  categoryName: "MAIN",
  fileName: "SkipFishingMinigame.zip",
  sizeKb: 1,
  sizeInBytes: 22,
  uploadedAt: "2024-01-01T00:00:00.000Z",
  isPrimary: true,
  description: "",
  contentPreviewLink: null,
};
const smapiFile: NexusModFile = {
  ...rootFile,
  fileId: 200001,
  name: "SMAPI 4.1.1",
  version: "4.1.1",
  fileName: "SMAPI.zip",
};

function requirementsFor(modId: number): ModRequirements {
  return {
    dlcRequirements: [],
    nexusRequirements:
      modId === 2697
        ? [
            {
              id: "[78263, 1303]",
              modId: "2400",
              modName: "SMAPI - Stardew Modding API",
              gameId: "1303",
              url: "",
              notes: "4.0.6",
              externalRequirement: false,
            },
          ]
        : [],
    modsRequiringThisMod: [],
    counts: {
      nexusRequirements: modId === 2697 ? 1 : 0,
      modsRequiringThisMod: 0,
    },
  };
}

class DependencyClient extends NexusClient {
  override async listGames() {
    return { games: [game], quota };
  }

  override async getGame() {
    return { game, quota };
  }

  override async getMod(_domainName: string, modId: number) {
    return { mod: modId === 2697 ? rootMod : smapiMod, quota };
  }

  override async getModRequirements(_domainName: string, modId: number) {
    return { requirements: requirementsFor(modId), quota };
  }

  override async getModFiles(_domainName: string, modId: number) {
    return { files: [modId === 2697 ? rootFile : smapiFile], quota };
  }
}

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeReceipt(input: {
  directory: string;
  mod: NexusMod;
  file: NexusModFile;
}): Promise<string> {
  const archivePath = path.join(input.directory, input.file.fileName);
  const receiptPath = `${archivePath}.nexus-receipt.json`;
  const archive = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    Buffer.alloc(18),
  ]);
  await writeFile(archivePath, archive);
  const info = await stat(archivePath);
  const receipt: DownloadReceipt = {
    schemaVersion: 1,
    backend: "persistent_chromium",
    canonicalModUrl: input.mod.canonicalUrl,
    domainName: input.mod.domainName,
    modId: input.mod.modId,
    fileId: input.file.fileId,
    fileName: input.file.fileName,
    bytes: info.size,
    sha256: createHash("sha256").update(archive).digest("hex"),
    completedAt: new Date().toISOString(),
    absolutePath: archivePath,
    targetPath: archivePath,
    receiptPath,
    archiveValid: true,
    archiveCheck: {
      format: "zip",
      valid: true,
      detail: "ZIP end-of-central-directory record found.",
    },
    browser: { engine: "chromium", backend: "playwright" },
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receiptPath;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("dependency-aware Download Plan and Bundle Manifest", () => {
  it("canonicalizes SMAPI, freezes both files, and builds dependency-first bundle", async () => {
    const managerRoot = await temporaryDirectory("bundle-manager-");
    const outputDirectory = await temporaryDirectory("bundle-output-");
    const downloadDirectory = await temporaryDirectory("bundle-downloads-");
    const service = await DownloadBundleService.create({
      client: new DependencyClient("fake-key"),
      managerRoot,
    });

    const plan = await service.plan({
      modUrl: rootMod.canonicalUrl,
      rootFileId: rootFile.fileId,
    });

    expect(plan.status).toBe("planned");
    expect(plan.blockers).toEqual([]);
    expect(plan.dependencyResolution.nodes).toContainEqual(
      expect.objectContaining({
        nodeId: "nexus:stardewvalley:2400",
        kind: "loader_runtime",
        canonicalModUrl:
          "https://www.nexusmods.com/stardewvalley/mods/2400",
        versionConstraint: "4.0.6",
      }),
    );
    expect(plan.items.map((item) => item.nodeId)).toEqual([
      "nexus:stardewvalley:2400",
      "nexus:stardewvalley:2697",
    ]);
    expect(plan.items.map((item) => item.selectedFile?.fileId)).toEqual([
      smapiFile.fileId,
      rootFile.fileId,
    ]);
    expect(classifyDownloadPlanReview(plan, "root_only")).toMatchObject({
      classification: "review_required",
      reasons: expect.arrayContaining([
        expect.stringContaining("root-only authorization"),
        expect.stringContaining("version note"),
      ]),
    });

    const [rootReceipt, smapiReceipt] = await Promise.all([
      writeReceipt({
        directory: downloadDirectory,
        mod: rootMod,
        file: rootFile,
      }),
      writeReceipt({
        directory: downloadDirectory,
        mod: smapiMod,
        file: smapiFile,
      }),
    ]);
    const bundle = await service.createBundle({
      planId: plan.planId,
      receiptPaths: [rootReceipt, smapiReceipt],
      outputDirectory,
    });

    expect(bundle.state).toBe("download_complete");
    expect(bundle.installOrder).toEqual([
      "nexus:stardewvalley:2400",
      "nexus:stardewvalley:2697",
    ]);
    expect(bundle.archives).toHaveLength(2);
    await expect(service.inspectBundle(bundle.bundlePath)).resolves.toEqual(
      bundle,
    );
  });

  it("refuses to create a bundle when a planned dependency receipt is missing", async () => {
    const managerRoot = await temporaryDirectory("bundle-manager-");
    const outputDirectory = await temporaryDirectory("bundle-output-");
    const downloadDirectory = await temporaryDirectory("bundle-downloads-");
    const service = await DownloadBundleService.create({
      client: new DependencyClient("fake-key"),
      managerRoot,
    });
    const plan = await service.plan({ modUrl: rootMod.canonicalUrl });
    const rootReceipt = await writeReceipt({
      directory: downloadDirectory,
      mod: rootMod,
      file: rootFile,
    });

    await expect(
      service.createBundle({
        planId: plan.planId,
        receiptPaths: [rootReceipt],
        outputDirectory,
      }),
    ).rejects.toMatchObject({
      code: "BUNDLE_INCOMPLETE",
    });
  });

  it("can freeze an independently proven loader as satisfied instead of downloading it", async () => {
    const managerRoot = await temporaryDirectory("bundle-manager-");
    const service = await DownloadBundleService.create({
      client: new DependencyClient("fake-key"),
      managerRoot,
    });
    const plan = await service.plan({
      modUrl: rootMod.canonicalUrl,
      satisfiedNodeIds: ["nexus:stardewvalley:2400"],
    });

    expect(plan.status).toBe("planned");
    expect(plan.items).toContainEqual(
      expect.objectContaining({
        nodeId: "nexus:stardewvalley:2400",
        action: "satisfied",
        selectedFile: null,
      }),
    );
    expect(
      plan.items.filter((item) => item.action === "download"),
    ).toHaveLength(1);
    expect(classifyDownloadPlanReview(plan, "root_only")).toEqual({
      classification: "auto_safe",
      authorizationScope: "root_only",
      reasons: [],
    });
  });

  it("classifies one unambiguous dependency-free MAIN file as auto-safe", async () => {
    const managerRoot = await temporaryDirectory("bundle-manager-");
    const service = await DownloadBundleService.create({
      client: new DependencyClient("fake-key"),
      managerRoot,
    });
    const plan = await service.plan({
      modUrl: smapiMod.canonicalUrl,
      rootFileId: smapiFile.fileId,
    });

    expect(plan.items).toEqual([
      expect.objectContaining({
        nodeId: "nexus:stardewvalley:2400",
        role: "root",
        action: "download",
        selectedFile: expect.objectContaining({ fileId: smapiFile.fileId }),
      }),
    ]);
    expect(
      classifyDownloadPlanReview(
        plan,
        "root_and_required_dependencies",
      ),
    ).toEqual({
      classification: "auto_safe",
      authorizationScope: "root_and_required_dependencies",
      reasons: [],
    });
  });
});
