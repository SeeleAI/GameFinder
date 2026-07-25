import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserDownloadManager } from "../src/browser-download-manager.js";
import type {
  NexusBrowserAutomation,
  NexusBrowserStatus
} from "../src/browser/browser-service.js";
import type {
  BrowserDownloadState,
  BrowserDownloadStateListener,
  BrowserPageDownloadController
} from "../src/browser/nexus-download-page-controller.js";
import type { NexusLoginStatus } from "../src/browser/nexus-login-controller.js";
import { NexusError } from "../src/errors.js";
import type { NexusModFile } from "../src/types.js";

const emptyZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
const targetFile: NexusModFile = {
  fileId: 47215,
  name: "ErdGameTools 20260607",
  version: "1.3.1",
  categoryId: 1,
  categoryName: "MAIN",
  fileName: "ErdGameTools.zip",
  sizeKb: 1,
  sizeInBytes: emptyZip.length,
  uploadedAt: "2026-06-07T00:00:00.000Z",
  isPrimary: true,
  description: "",
  contentPreviewLink: null
};

const managers: BrowserDownloadManager[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function browserWithFactory(
  factory: (onState?: BrowserDownloadStateListener) => Promise<BrowserPageDownloadController>
): NexusBrowserAutomation {
  return {
    status: vi.fn(async (): Promise<NexusBrowserStatus> => ({
      launchMode: "ordinary_chromium_cdp",
      engineInstalled: true,
      profileExists: true,
      profilePathConfigured: true,
      profileBusy: false,
      running: true,
      authState: "authenticated",
      authCheckedAt: new Date().toISOString(),
      requiresUserInteraction: false,
      interactionReason: null
    })),
    openLogin: vi.fn(async (): Promise<NexusLoginStatus> => ({
      state: "authenticated",
      checkedAt: new Date().toISOString(),
      expiresAt: null,
      requiresUserInteraction: false,
      interactionReason: null
    })),
    createDownloadController: vi.fn(async (_input, onState) => factory(onState)),
    close: vi.fn(async () => undefined)
  };
}

function prepare(manager: BrowserDownloadManager): string {
  return manager.prepare({
    domainName: "eldenring",
    modId: 9531,
    canonicalUrl: "https://www.nexusmods.com/eldenring/mods/9531",
    file: targetFile
  }).sessionId;
}

async function waitForState(
  manager: BrowserDownloadManager,
  sessionId: string,
  expected: BrowserDownloadState,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (manager.status(sessionId).state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Session did not reach ${expected}; current state is ${manager.status(sessionId).state}.`);
}

describe("persistent Chromium download sessions", () => {
  it("starts asynchronously, verifies staging, and completes with a browser receipt", async () => {
    const browser = browserWithFactory(async (onState) => ({
      state: "prepared",
      run: async (input) => {
        onState?.("navigating");
        onState?.("downloading");
        await writeFile(input.saveAsPath, emptyZip);
        onState?.("verifying");
        return {
          state: "verifying",
          suggestedFilename: "fixture-browser.zip",
          savedPath: input.saveAsPath,
          sourcePage: "/eldenring/mods/9531"
        };
      },
      cancel: async () => undefined
    }));
    const manager = new BrowserDownloadManager(browser);
    managers.push(manager);
    const sessionId = prepare(manager);
    const output = await mkdtemp(path.join(os.tmpdir(), "browser-download-manager-"));
    temporaryDirectories.push(output);

    const started = await manager.start(sessionId, output);
    expect(started).toMatchObject({
      sessionId,
      backend: "persistent_chromium",
      state: expect.stringMatching(/checking_login|navigating|downloading|verifying|completed/)
    });
    await waitForState(manager, sessionId, "completed");
    const completed = manager.status(sessionId);

    expect(completed).toMatchObject({
      state: "completed",
      authState: "authenticated",
      requiresUserInteraction: false,
      stagingPath: null,
      receipt: {
        schemaVersion: 1,
        backend: "persistent_chromium",
        browser: { engine: "chromium", backend: "playwright" },
        fileName: "fixture-browser.zip",
        bytes: emptyZip.length
      }
    });
    expect(await readFile(completed.finalPath as string)).toEqual(emptyZip);
    expect(await readFile(completed.receipt?.receiptPath as string, "utf8")).not.toContain("cookie");
  });

  it("surfaces CAPTCHA as resumable visible user interaction", async () => {
    const browser = browserWithFactory(async (onState) => ({
      state: "prepared",
      run: async () => {
        onState?.("navigating");
        throw new NexusError("CAPTCHA_REQUIRED", "Complete browser verification.", { retryable: true });
      },
      cancel: async () => undefined
    }));
    const manager = new BrowserDownloadManager(browser);
    managers.push(manager);
    const sessionId = prepare(manager);
    const output = await mkdtemp(path.join(os.tmpdir(), "browser-download-captcha-"));
    temporaryDirectories.push(output);

    await manager.start(sessionId, output);
    await waitForState(manager, sessionId, "user_interaction_required");
    expect(manager.status(sessionId)).toMatchObject({
      requiresUserInteraction: true,
      interactionReason: "captcha",
      error: { code: "CAPTCHA_REQUIRED", retryable: true }
    });
  });

  it("cancels a workflow before the Playwright download event", async () => {
    let rejectRun: ((error: NexusError) => void) | undefined;
    const browser = browserWithFactory(async (onState) => ({
      state: "prepared",
      run: async () => {
        onState?.("waiting_slow_download");
        return await new Promise<never>((_resolve, reject) => {
          rejectRun = reject;
        });
      },
      cancel: async () => {
        rejectRun?.(new NexusError("DOWNLOAD_CANCELED", "Canceled."));
      }
    }));
    const manager = new BrowserDownloadManager(browser);
    managers.push(manager);
    const sessionId = prepare(manager);
    const output = await mkdtemp(path.join(os.tmpdir(), "browser-download-cancel-"));
    temporaryDirectories.push(output);

    await manager.start(sessionId, output);
    await waitForState(manager, sessionId, "waiting_slow_download");
    const canceled = await manager.cancel(sessionId);
    expect(canceled.state).toBe("canceled");
    expect(manager.status(sessionId)).toMatchObject({
      state: "canceled",
      error: { code: "DOWNLOAD_CANCELED" },
      stagingPath: null
    });
  });

  it("allows only one active persistent browser workflow", async () => {
    let rejectRun: ((error: NexusError) => void) | undefined;
    const browser = browserWithFactory(async (onState) => ({
      state: "prepared",
      run: async () => {
        onState?.("waiting_download_option");
        return await new Promise<never>((_resolve, reject) => {
          rejectRun = reject;
        });
      },
      cancel: async () => {
        rejectRun?.(new NexusError("DOWNLOAD_CANCELED", "Canceled."));
      }
    }));
    const manager = new BrowserDownloadManager(browser);
    managers.push(manager);
    const first = prepare(manager);
    const second = prepare(manager);
    const output = await mkdtemp(path.join(os.tmpdir(), "browser-download-busy-"));
    temporaryDirectories.push(output);

    await manager.start(first, output);
    await waitForState(manager, first, "waiting_download_option");
    await expect(manager.start(second, output)).rejects.toMatchObject({ code: "DOWNLOAD_BUSY" });
    expect((await manager.cancel(first)).state).toBe("canceled");
  });
});
