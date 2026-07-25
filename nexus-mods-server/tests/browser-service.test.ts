import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserConfig } from "../src/browser/browser-config.js";
import type { BrowserRuntimeStatus } from "../src/browser/browser-manager.js";
import {
  NexusBrowserService,
  type NexusBrowserManager
} from "../src/browser/browser-service.js";

const services: NexusBrowserService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => service.close()));
});

describe("NexusBrowserService production backend", () => {
  it("defaults to ordinary Chromium attached over loopback CDP", async () => {
    const service = new NexusBrowserService();
    services.push(service);
    expect(await service.status()).toMatchObject({
      launchMode: "ordinary_chromium_cdp",
      profilePathConfigured: true,
      running: false
    });
  });

  it("opens the exact Nexus file URL before creating the production controller", async () => {
    const config: BrowserConfig = {
      profileDir: "C:\\dedicated-profile",
      launchTimeoutMs: 30_000,
      navigationTimeoutMs: 45_000,
      downloadStartTimeoutMs: 120_000,
      downloadTimeoutMs: 0,
      loginWaitMs: 900_000,
      keepOpen: true
    };
    const getPage = vi.fn(async () => ({}) as Page);
    const manager: NexusBrowserManager = {
      launchMode: "ordinary_chromium_cdp",
      config,
      running: false,
      status: vi.fn(async (): Promise<BrowserRuntimeStatus> => ({
        launchMode: "ordinary_chromium_cdp",
        engineInstalled: true,
        profileExists: true,
        profilePathConfigured: true,
        profileBusy: false,
        running: false
      })),
      getPage,
      close: vi.fn(async () => undefined)
    };
    const service = new NexusBrowserService(manager);
    services.push(service);

    await service.createDownloadController({
      domainName: "eldenring",
      modId: 9531,
      fileId: 47215
    });

    expect(getPage).toHaveBeenCalledWith(
      "https://www.nexusmods.com/eldenring/mods/9531?tab=files&file_id=47215"
    );
  });
});
