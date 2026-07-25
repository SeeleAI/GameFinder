import type { Page } from "playwright";
import type { BrowserConfig } from "./browser-config.js";
import type { BrowserRuntimeStatus } from "./browser-manager.js";
import {
  buildNexusFileUrl,
  NexusDownloadPageController,
  type BrowserDownloadStateListener,
  type BrowserPageDownloadController
} from "./nexus-download-page-controller.js";
import type { NexusLoginStatus } from "./nexus-login-controller.js";
import { NexusLoginController } from "./nexus-login-controller.js";
import { OrdinaryCdpBrowserManager } from "./ordinary-cdp-browser-manager.js";

export interface NexusBrowserStatus extends BrowserRuntimeStatus {
  authState: NexusLoginStatus["state"];
  authCheckedAt: string | null;
  requiresUserInteraction: boolean;
  interactionReason: NexusLoginStatus["interactionReason"];
}

export interface NexusBrowserAutomation {
  status(): Promise<NexusBrowserStatus>;
  openLogin(returnToModUrl?: string): Promise<NexusLoginStatus>;
  createDownloadController(
    input: { domainName: string; modId: number; fileId: number },
    onState?: BrowserDownloadStateListener
  ): Promise<BrowserPageDownloadController>;
  close(): Promise<void>;
}

export interface NexusBrowserManager {
  readonly launchMode: BrowserRuntimeStatus["launchMode"];
  readonly config: BrowserConfig;
  readonly running: boolean;
  status(): Promise<BrowserRuntimeStatus>;
  getPage(startUrl?: string): Promise<Page>;
  close(): Promise<void>;
}

export class NexusBrowserService implements NexusBrowserAutomation {
  readonly #manager: NexusBrowserManager;
  readonly #login: NexusLoginController;

  constructor(
    manager: NexusBrowserManager = new OrdinaryCdpBrowserManager(),
    login = new NexusLoginController(manager)
  ) {
    this.#manager = manager;
    this.#login = login;
  }

  async status(): Promise<NexusBrowserStatus> {
    const runtime = await this.#manager.status();
    const login = runtime.running ? await this.#login.inspectRunningBrowser() : this.#login.cachedStatus();
    return {
      ...runtime,
      authState: login.state,
      authCheckedAt: login.checkedAt,
      requiresUserInteraction: runtime.running && login.requiresUserInteraction,
      interactionReason: runtime.running ? login.interactionReason : null
    };
  }

  async openLogin(returnToModUrl?: string): Promise<NexusLoginStatus> {
    return this.#login.openLogin(returnToModUrl);
  }

  async createDownloadController(
    input: { domainName: string; modId: number; fileId: number },
    onState?: BrowserDownloadStateListener
  ): Promise<BrowserPageDownloadController> {
    const page = await this.#manager.getPage(buildNexusFileUrl(input));
    return new NexusDownloadPageController(page, this.#manager.config, onState);
  }

  async close(): Promise<void> {
    await this.#manager.close();
  }
}
