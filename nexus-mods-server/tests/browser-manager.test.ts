import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserManager } from "../src/browser/browser-manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function fakeContext(): BrowserContext {
  const events = new EventEmitter();
  const page = { isClosed: () => false } as Page;
  return {
    pages: () => [page],
    newPage: async () => page,
    once: events.once.bind(events),
    close: async () => {
      events.emit("close");
    }
  } as unknown as BrowserContext;
}

describe("BrowserManager", () => {
  it("starts one persistent context, reuses it, and releases the profile lock", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nexus-browser-manager-"));
    temporaryDirectories.push(directory);
    const executablePath = path.join(directory, "chromium.exe");
    await writeFile(executablePath, "");
    const profileDir = path.join(directory, "profile");
    const context = fakeContext();
    const launch = vi.fn(async () => context);
    const manager = new BrowserManager(
      {
        profileDir,
        launchTimeoutMs: 30_000,
        navigationTimeoutMs: 45_000,
        downloadStartTimeoutMs: 120_000,
        downloadTimeoutMs: 0,
        loginWaitMs: 900_000,
        keepOpen: true
      },
      { engineExecutablePath: executablePath, launch }
    );

    expect(await manager.status()).toMatchObject({ engineInstalled: true, profileExists: false, running: false });
    const first = await manager.ensureStarted();
    const second = await manager.ensureStarted();
    expect(first).toBe(context);
    expect(second).toBe(context);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(
      profileDir,
      expect.objectContaining({ headless: false, acceptDownloads: true, viewport: null })
    );
    expect(await manager.status()).toMatchObject({ profileExists: true, profileBusy: false, running: true });

    await manager.close();
    expect(await manager.status()).toMatchObject({ profileBusy: false, running: false });
  });

  it("reports a missing Playwright Chromium with the setup command", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nexus-browser-missing-"));
    temporaryDirectories.push(directory);
    const manager = new BrowserManager(
      {
        profileDir: path.join(directory, "profile"),
        launchTimeoutMs: 30_000,
        navigationTimeoutMs: 45_000,
        downloadStartTimeoutMs: 120_000,
        downloadTimeoutMs: 0,
        loginWaitMs: 900_000,
        keepOpen: true
      },
      { engineExecutablePath: path.join(directory, "missing.exe"), launch: vi.fn() }
    );

    await expect(manager.ensureStarted()).rejects.toMatchObject({
      code: "BROWSER_NOT_INSTALLED",
      message: expect.stringContaining("pnpm setup:browser")
    });
  });
});
