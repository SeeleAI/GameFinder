import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DownloadManager, selectDownloadFile } from "../src/download-manager.js";
import { NexusClient } from "../src/nexus-client.js";
import type { NexusModFile, QuotaSnapshot } from "../src/types.js";

const quota: QuotaSnapshot = {
  dailyLimit: 20_000,
  dailyRemaining: 19_999,
  hourlyLimit: 2_000,
  hourlyRemaining: 1_999
};

const targetFile: NexusModFile = {
  fileId: 47215,
  name: "ErdGameTools 20260607",
  version: "1.3.1",
  categoryId: 1,
  categoryName: "MAIN",
  fileName: "ErdGameTools.zip",
  sizeKb: 1,
  sizeInBytes: 22,
  uploadedAt: "2026-06-07T00:00:00.000Z",
  isPrimary: true,
  description: "",
  contentPreviewLink: null
};

class DownloadClient extends NexusClient {
  override async getDownloadLinks(): Promise<{
    links: Array<{ name: string; shortName: string; uri: string }>;
    quota: QuotaSnapshot;
  }> {
    return {
      links: [{ name: "Test CDN", shortName: "test", uri: "https://test.nexus-cdn.com/ErdGameTools.zip" }],
      quota
    };
  }
}

const managers: DownloadManager[] = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(managers.splice(0).map(async (manager) => manager.close()));
  await Promise.all(tempDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

describe("download file selection", () => {
  it("selects the primary latest MAIN file", () => {
    const older = { ...targetFile, fileId: 47149, isPrimary: false, uploadedAt: "2026-06-04T00:00:00.000Z" };
    const archived = { ...targetFile, fileId: 47150, categoryName: "ARCHIVED", isPrimary: false };
    expect(selectDownloadFile([archived, older, targetFile]).fileId).toBe(47215);
  });

  it("does not auto-select archived files", () => {
    expect(() => selectDownloadFile([{ ...targetFile, categoryName: "ARCHIVED" }])).toThrow(/No active MAIN/);
  });
});

describe("non-Premium authorization broker", () => {
  it("keeps temporary NXM credentials inside the loopback broker", async () => {
    const manager = new DownloadManager(new NexusClient("fake-api-key"));
    managers.push(manager);
    const prepared = await manager.prepare({
      domainName: "eldenring",
      modId: 9531,
      canonicalUrl: "https://www.nexusmods.com/eldenring/mods/9531",
      file: targetFile,
      isPremium: false
    });
    expect(prepared.authorizationPageUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    const expires = Math.floor(Date.now() / 1000) + 300;
    const response = await fetch(prepared.authorizationPageUrl as string, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        nxmUrl: `nxm://eldenring/mods/9531/files/47215?key=fake-one-time-key&expires=${expires}`
      })
    });
    expect(response.status).toBe(200);
    expect(manager.status(prepared.sessionId).state).toBe("ready");
    expect(JSON.stringify(manager.status(prepared.sessionId))).not.toContain("fake-one-time-key");
  });
});

describe("download integrity", () => {
  it("writes a complete archive and non-secret receipt", async () => {
    const emptyZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(emptyZip, {
          status: 200,
          headers: { "content-length": String(emptyZip.length), "content-type": "application/zip" }
        }))
    );
    const manager = new DownloadManager(new DownloadClient("fake-api-key"));
    managers.push(manager);
    const prepared = await manager.prepare({
      domainName: "eldenring",
      modId: 9531,
      canonicalUrl: "https://www.nexusmods.com/eldenring/mods/9531",
      file: targetFile,
      isPremium: true
    });
    const output = await mkdtemp(path.join(os.tmpdir(), "nexus-mods-server-test-"));
    tempDirectories.push(output);
    const receipt = await manager.download(prepared.sessionId, output);
    expect(receipt.backend).toBe("native");
    expect(receipt.bytes).toBe(22);
    expect(receipt.archiveCheck).toMatchObject({ format: "zip", valid: true });
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(receipt.targetPath)).toEqual(emptyZip);
    const receiptText = await readFile(receipt.receiptPath, "utf8");
    expect(receiptText).toContain(receipt.sha256);
    expect(receiptText).not.toContain("fake-api-key");
    expect(receiptText).not.toContain("nexus-cdn.com");
  });
});
