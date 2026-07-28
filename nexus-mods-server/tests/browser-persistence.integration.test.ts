import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterAll, describe, expect, it } from "vitest";
import { BrowserManager } from "../src/browser/browser-manager.js";
import { OrdinaryCdpBrowserManager } from "../src/browser/ordinary-cdp-browser-manager.js";

const enabled = process.env.NEXUS_BROWSER_INTEGRATION_TEST === "1";
const temporaryDirectories: string[] = [];

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Condition was not met within ${timeoutMs} ms.`);
}

afterAll(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe.skipIf(!enabled)("persistent Chromium integration", () => {
  it("preserves browser cookies across a dedicated profile restart", async () => {
    const executableOverride = process.env.NEXUS_BROWSER_INTEGRATION_EXECUTABLE;
    const engineExecutablePath = executableOverride ?? chromium.executablePath();
    expect(existsSync(engineExecutablePath)).toBe(true);
    const directory = await mkdtemp(path.join(os.tmpdir(), "nexus-browser-persistence-"));
    temporaryDirectories.push(directory);
    const profileDir = path.join(directory, "profile");
    const config = {
      profileDir,
      launchTimeoutMs: 30_000,
      navigationTimeoutMs: 45_000,
      downloadStartTimeoutMs: 120_000,
      downloadTimeoutMs: 0,
      loginWaitMs: 900_000,
      keepOpen: true
    };
    const launchVisible = (userDataDir: string, options: Parameters<typeof chromium.launchPersistentContext>[1]) =>
      chromium.launchPersistentContext(userDataDir, {
        ...options,
        headless: false,
        ...(executableOverride === undefined ? {} : { executablePath: executableOverride })
      });

    const first = new BrowserManager(config, { engineExecutablePath, launch: launchVisible });
    const firstContext = await first.ensureStarted();
    await firstContext.addCookies([
      {
        name: "gamefinder_persistence_test",
        value: "present",
        domain: "example.test",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 3_600,
        httpOnly: true,
        secure: true,
        sameSite: "Lax"
      }
    ]);
    await first.close();

    const second = new BrowserManager(config, { engineExecutablePath, launch: launchVisible });
    try {
      const secondContext = await second.ensureStarted();
      const cookies = await secondContext.cookies("https://example.test");
      expect(cookies).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "gamefinder_persistence_test", value: "present" })])
      );
    } finally {
      await second.close();
    }
  }, 60_000);

  it("preserves ordinary Chromium Profile storage across a CDP-attached restart", async () => {
    const engineExecutablePath = process.env.NEXUS_BROWSER_INTEGRATION_EXECUTABLE ?? chromium.executablePath();
    const directory = await mkdtemp(path.join(os.tmpdir(), "nexus-ordinary-browser-persistence-"));
    temporaryDirectories.push(directory);
    const config = {
      profileDir: path.join(directory, "profile"),
      launchTimeoutMs: 30_000,
      navigationTimeoutMs: 45_000,
      downloadStartTimeoutMs: 120_000,
      downloadTimeoutMs: 0,
      loginWaitMs: 900_000,
      keepOpen: true
    };
    const html = "<!doctype html><html><body>ordinary CDP persistence fixture</body></html>";

    const first = new OrdinaryCdpBrowserManager(config, engineExecutablePath);
    const firstPage = await first.getPage();
    await firstPage.route("https://example.test/**", async (route) => {
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
    });
    await firstPage.goto("https://example.test/persistence");
    await firstPage.evaluate(() => localStorage.setItem("gamefinder_cdp_persistence", "present"));
    await first.close();

    const second = new OrdinaryCdpBrowserManager(config, engineExecutablePath);
    try {
      const secondPage = await second.getPage();
      await secondPage.route("https://example.test/**", async (route) => {
        await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
      });
      await secondPage.goto("https://example.test/persistence");
      expect(await secondPage.evaluate(() => localStorage.getItem("gamefinder_cdp_persistence"))).toBe("present");
      expect(await second.status()).toMatchObject({
        launchMode: "ordinary_chromium_cdp",
        running: true,
        profileBusy: false
      });
    } finally {
      await second.close();
    }
  }, 60_000);

  it("releases the ordinary Chromium Profile lock after an external CDP disconnect", async () => {
    const engineExecutablePath = process.env.NEXUS_BROWSER_INTEGRATION_EXECUTABLE ?? chromium.executablePath();
    const directory = await mkdtemp(path.join(os.tmpdir(), "nexus-ordinary-browser-disconnect-"));
    temporaryDirectories.push(directory);
    const config = {
      profileDir: path.join(directory, "profile"),
      launchTimeoutMs: 30_000,
      navigationTimeoutMs: 45_000,
      downloadStartTimeoutMs: 120_000,
      downloadTimeoutMs: 0,
      loginWaitMs: 900_000,
      keepOpen: true
    };
    const first = new OrdinaryCdpBrowserManager(config, engineExecutablePath);
    const second = new OrdinaryCdpBrowserManager(config, engineExecutablePath);

    try {
      const firstPage = await first.getPage();
      const attachedBrowser = firstPage.context().browser();
      if (!attachedBrowser) throw new Error("Expected a CDP-attached Browser.");
      await attachedBrowser.close();

      await waitUntil(async () => !(await second.status()).profileBusy);
      const secondPage = await second.getPage();
      expect(secondPage.isClosed()).toBe(false);
      expect(await second.status()).toMatchObject({
        running: true,
        profileBusy: false
      });
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
    }
  }, 60_000);
});
