import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { loadBrowserConfig } from "../src/browser/browser-config.js";
import { BrowserProfileLock } from "../src/browser/browser-lock.js";

const TARGET_URL = "https://www.nexusmods.com/eldenring/mods/9531?tab=files&file_id=47215";
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = path.resolve(projectDirectory, "..");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDirectory = path.join(workspaceDirectory, ".codex-work", "phase5-cdp-clearance", runId);
const statusPath = path.join(runDirectory, "status.json");
const attachSignalPath = path.join(runDirectory, "attach-after-clearance.flag");
const config = loadBrowserConfig();

async function writeStatus(value: Record<string, unknown>): Promise<void> {
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    statusPath,
    `${JSON.stringify(
      {
        targetUrl: TARGET_URL,
        attachSignalPath,
        updatedAt: new Date().toISOString(),
        ...value
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function report(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`);
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a loopback CDP port.");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForCdp(port: number, child: ChildProcess, timeoutMs = 15_000): Promise<string> {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Ordinary Chromium exited with code ${String(child.exitCode)}.`);
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) return endpoint;
    } catch {
      // Chromium has not opened the loopback endpoint yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the ordinary Chromium CDP endpoint.");
}

async function waitForAttachSignal(child: ChildProcess, timeoutMs = 30 * 60_000): Promise<void> {
  await rm(attachSignalPath, { force: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Ordinary Chromium closed before the attach signal.");
    try {
      await access(attachSignalPath);
      await rm(attachSignalPath, { force: true });
      return;
    } catch {
      // Keep the ordinary Nexus page untouched until the user confirms clearance.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for the post-clearance attach signal.");
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000))
  ]);
  if (!exited && child.pid) process.kill(child.pid);
}

async function main(): Promise<void> {
  if (process.env.NEXUS_LIVE_TEST !== "1") {
    throw new Error("Set NEXUS_LIVE_TEST=1 to run the real Nexus CDP clearance experiment.");
  }
  await mkdir(runDirectory, { recursive: true });
  const lock = new BrowserProfileLock(config.profileDir);
  await lock.acquire();
  const port = await reserveLoopbackPort();
  const child = spawn(
    chromium.executablePath(),
    [
      `--user-data-dir=${config.profileDir}`,
      "--password-store=basic",
      "--use-mock-keychain",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      "--start-maximized",
      "--new-window",
      TARGET_URL
    ],
    {
      stdio: "ignore",
      windowsHide: false
    }
  );

  try {
    const endpoint = await waitForCdp(port, child);
    await writeStatus({ phase: "waiting_for_human_clearance" });
    report({
      phase: "waiting_for_human_clearance",
      attachSignalPath,
      message: "Complete the visible Cloudflare challenge. Do not create the signal until the Nexus file page is visible."
    });
    await waitForAttachSignal(child);
    report({ phase: "attaching_cdp" });

    const browser = await chromium.connectOverCDP(endpoint);
    try {
      const context = browser.contexts()[0];
      if (!context) throw new Error("CDP did not expose the ordinary Chromium context.");
      const pages = context.pages();
      const page =
        [...pages].reverse().find((candidate) => candidate.url().includes("nexusmods.com/eldenring/mods/9531")) ??
        pages.at(-1);
      if (!page) throw new Error("The ordinary Chromium Nexus page was not found after CDP attach.");
      const signals = await page.evaluate<{
        webdriver: boolean;
        userAgentContainsHeadless: boolean;
      }>(
        "({ webdriver: navigator.webdriver, userAgentContainsHeadless: /headless/i.test(navigator.userAgent) })"
      );
      const pageSignals = await page.evaluate<{
        title: string;
        body: string;
        manualDownload: boolean;
        passwordField: boolean;
      }>(`(() => {
        const text = (document.body?.innerText ?? "").slice(0, 12000).toLowerCase();
        return {
          title: document.title.toLowerCase(),
          body: text,
          manualDownload: Array.from(document.querySelectorAll("button, a, [role='button']"))
            .some((element) => /\\bmanual\\s+download\\b/i.test(element.textContent ?? "")),
          passwordField: document.querySelector('input[type="password"]') !== null
        };
      })()`);
      const currentUrl = new URL(page.url());
      const captcha =
        pageSignals.title.includes("just a moment") ||
        pageSignals.body.includes("verify you are human") ||
        pageSignals.body.includes("checking your browser") ||
        pageSignals.body.includes("cloudflare ray id");
      const login =
        currentUrl.hostname === "users.nexusmods.com" ||
        pageSignals.passwordField ||
        pageSignals.body.includes("sign in to continue");
      const modFiles =
        currentUrl.hostname === "www.nexusmods.com" &&
        /^\/[^/]+\/mods\/\d+\/?$/.test(currentUrl.pathname) &&
        (currentUrl.searchParams.get("tab") === "files" ||
          currentUrl.searchParams.has("file_id") ||
          pageSignals.manualDownload);
      const pageKind = captcha ? "captcha" : login ? "login" : modFiles ? "mod_files" : "unknown";
      const result = {
        phase: "attached",
        webdriver: signals.webdriver,
        userAgentContainsHeadless: signals.userAgentContainsHeadless,
        pageKind,
        pagePath: currentUrl.hostname.endsWith("nexusmods.com") ? currentUrl.pathname : null
      };
      await writeStatus(result);
      report(result);
      if (signals.webdriver !== false) {
        throw new Error("navigator.webdriver changed after delayed CDP attach.");
      }
      if (pageKind === "captcha") {
        throw new Error("Cloudflare clearance did not survive delayed CDP attach.");
      }
      if (pageKind !== "mod_files") {
        throw new Error(`Expected the Nexus file page after clearance, observed ${pageKind}.`);
      }
    } finally {
      await browser.close();
    }
  } finally {
    await terminate(child);
    await lock.release();
  }
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown Nexus CDP clearance experiment failure.";
  await writeStatus({ phase: "failed", message, failedAt: new Date().toISOString() }).catch(() => undefined);
  console.error(`CDP_CLEARANCE_FAILED: ${message}`);
  process.exitCode = 1;
});
