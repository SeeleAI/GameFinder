import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterAll, describe, expect, it } from "vitest";
import { BrowserManager } from "../src/browser/browser-manager.js";

const enabled = process.env.NEXUS_BROWSER_INTEGRATION_TEST === "1";
const temporaryDirectories: string[] = [];

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
});
