import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { BrowserContext, BrowserType, Page } from "playwright";
import { chromium } from "playwright";
import { NexusError } from "../errors.js";
import type { BrowserConfig } from "./browser-config.js";
import { loadBrowserConfig } from "./browser-config.js";
import { BrowserProfileLock } from "./browser-lock.js";

export interface BrowserRuntimeStatus {
  engineInstalled: boolean;
  profileExists: boolean;
  profilePathConfigured: true;
  profileBusy: boolean;
  running: boolean;
}

export type PersistentContextLauncher = (
  profileDir: string,
  options: Parameters<BrowserType["launchPersistentContext"]>[1]
) => Promise<BrowserContext>;

export class BrowserManager {
  readonly config: BrowserConfig;
  readonly #lock: BrowserProfileLock;
  readonly #engineExecutablePath: string;
  readonly #launch: PersistentContextLauncher;
  #context: BrowserContext | undefined;
  #page: Page | undefined;
  #starting: Promise<BrowserContext> | undefined;
  #closing = false;

  constructor(
    config: BrowserConfig = loadBrowserConfig(),
    dependencies: {
      engineExecutablePath?: string;
      launch?: PersistentContextLauncher;
    } = {}
  ) {
    this.config = config;
    this.#lock = new BrowserProfileLock(config.profileDir);
    this.#engineExecutablePath = dependencies.engineExecutablePath ?? chromium.executablePath();
    this.#launch =
      dependencies.launch ??
      ((profileDir, options) => chromium.launchPersistentContext(profileDir, options));
  }

  get running(): boolean {
    return this.#context !== undefined;
  }

  async status(): Promise<BrowserRuntimeStatus> {
    return {
      engineInstalled: existsSync(this.#engineExecutablePath),
      profileExists: existsSync(this.config.profileDir),
      profilePathConfigured: true,
      profileBusy: await this.#lock.isBusy(),
      running: this.running
    };
  }

  async ensureStarted(): Promise<BrowserContext> {
    if (this.#context) return this.#context;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start();
    try {
      return await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async #start(): Promise<BrowserContext> {
    if (!existsSync(this.#engineExecutablePath)) {
      throw new NexusError(
        "BROWSER_NOT_INSTALLED",
        "Playwright Chromium is not installed. Run `pnpm setup:browser` in nexus-mods-server.",
        { retryable: true }
      );
    }

    await mkdir(this.config.profileDir, { recursive: true });
    await this.#lock.acquire();
    try {
      const context = await this.#launch(this.config.profileDir, {
        headless: false,
        acceptDownloads: true,
        viewport: null,
        timeout: this.config.launchTimeoutMs
      });
      this.#context = context;
      this.#page = context.pages()[0];
      context.once("close", () => {
        this.#context = undefined;
        this.#page = undefined;
        if (!this.#closing) void this.#lock.release();
      });
      return context;
    } catch (error) {
      await this.#lock.release();
      if (error instanceof NexusError) throw error;
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (
        message.includes("processsingleton") ||
        message.includes("profile is already in use") ||
        message.includes("user data directory is already in use")
      ) {
        throw new NexusError(
          "BROWSER_PROFILE_BUSY",
          "The dedicated Nexus Chromium profile is already in use by another browser process.",
          { retryable: true, cause: error }
        );
      }
      throw new NexusError("BROWSER_LAUNCH_FAILED", "Could not start the dedicated Nexus Chromium profile.", {
        retryable: true,
        cause: error
      });
    }
  }

  async getPage(): Promise<Page> {
    const context = await this.ensureStarted();
    if (this.#page && !this.#page.isClosed()) return this.#page;
    const existing = context.pages().find((page) => !page.isClosed());
    this.#page = existing ?? (await context.newPage());
    return this.#page;
  }

  async close(): Promise<void> {
    this.#closing = true;
    try {
      const context = this.#context;
      this.#context = undefined;
      this.#page = undefined;
      if (context) await context.close();
    } finally {
      await this.#lock.release();
      this.#closing = false;
    }
  }
}
