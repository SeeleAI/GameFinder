import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import { NexusError } from "../errors.js";
import type { BrowserConfig } from "./browser-config.js";
import { loadBrowserConfig } from "./browser-config.js";
import { BrowserProfileLock } from "./browser-lock.js";
import type { BrowserRuntimeStatus } from "./browser-manager.js";

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new NexusError("BROWSER_LAUNCH_FAILED", "Could not allocate a loopback CDP port.");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForCdp(port: number, child: ChildProcess, timeoutMs: number): Promise<string> {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new NexusError("BROWSER_LAUNCH_FAILED", `Ordinary Chromium exited with code ${String(child.exitCode)}.`);
    }
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) return endpoint;
    } catch {
      // Chromium has not opened the loopback endpoint yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new NexusError("BROWSER_LAUNCH_FAILED", "Timed out waiting for the ordinary Chromium CDP endpoint.", {
    retryable: true
  });
}

async function terminate(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill();
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000))
  ]);
  if (!exited && child.pid) process.kill(child.pid);
}

async function waitForExit(child: ChildProcess | undefined, timeoutMs: number): Promise<boolean> {
  if (!child || child.exitCode !== null) return true;
  return Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))
  ]);
}

export class OrdinaryCdpBrowserManager {
  readonly launchMode = "ordinary_chromium_cdp" as const;
  readonly config: BrowserConfig;
  readonly #lock: BrowserProfileLock;
  readonly #engineExecutablePath: string;
  #browser: Browser | undefined;
  #context: BrowserContext | undefined;
  #page: Page | undefined;
  #child: ChildProcess | undefined;
  #starting: Promise<Page> | undefined;

  constructor(
    config: BrowserConfig = loadBrowserConfig(),
    engineExecutablePath = chromium.executablePath()
  ) {
    this.config = config;
    this.#lock = new BrowserProfileLock(config.profileDir);
    this.#engineExecutablePath = engineExecutablePath;
  }

  get running(): boolean {
    return this.#browser?.isConnected() === true && this.#child?.exitCode === null;
  }

  async status(): Promise<BrowserRuntimeStatus> {
    return {
      launchMode: this.launchMode,
      engineInstalled: existsSync(this.#engineExecutablePath),
      profileExists: existsSync(this.config.profileDir),
      profilePathConfigured: true,
      profileBusy: await this.#lock.isBusy(),
      running: this.running
    };
  }

  async getPage(startUrl = "about:blank"): Promise<Page> {
    if (this.#page && !this.#page.isClosed()) return this.#page;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start(startUrl);
    try {
      return await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async #start(startUrl: string): Promise<Page> {
    if (!existsSync(this.#engineExecutablePath)) {
      throw new NexusError(
        "BROWSER_NOT_INSTALLED",
        "Playwright Chromium is not installed. Run `pnpm setup:browser` in nexus-mods-server.",
        { retryable: true }
      );
    }
    await this.#lock.acquire();
    try {
      const port = await reserveLoopbackPort();
      const child = spawn(
        this.#engineExecutablePath,
        [
          `--user-data-dir=${this.config.profileDir}`,
          "--password-store=basic",
          "--use-mock-keychain",
          "--remote-debugging-address=127.0.0.1",
          `--remote-debugging-port=${port}`,
          "--start-maximized",
          "--new-window",
          startUrl
        ],
        {
          stdio: "ignore",
          windowsHide: false
        }
      );
      this.#child = child;
      const endpoint = await waitForCdp(port, child, this.config.launchTimeoutMs);
      const browser = await chromium.connectOverCDP(endpoint);
      this.#browser = browser;
      browser.once("disconnected", () => {
        this.#browser = undefined;
        this.#context = undefined;
        this.#page = undefined;
      });
      const context = browser.contexts()[0];
      if (!context) throw new NexusError("BROWSER_LAUNCH_FAILED", "CDP did not expose the ordinary Chromium context.");
      this.#context = context;
      const pages = context.pages();
      const page = pages.at(-1) ?? (await context.newPage());
      this.#page = page;
      return page;
    } catch (error) {
      await terminate(this.#child);
      this.#child = undefined;
      await this.#lock.release();
      if (error instanceof NexusError) throw error;
      throw new NexusError("BROWSER_LAUNCH_FAILED", "Could not start or attach to ordinary Chromium.", {
        retryable: true,
        cause: error
      });
    }
  }

  async close(): Promise<void> {
    const browser = this.#browser;
    this.#browser = undefined;
    this.#context = undefined;
    this.#page = undefined;
    try {
      if (browser?.isConnected()) await browser.close();
    } finally {
      if (!(await waitForExit(this.#child, 5_000))) {
        await terminate(this.#child);
      }
      this.#child = undefined;
      await this.#lock.release();
    }
  }
}
