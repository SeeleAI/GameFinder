import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { chromium } from "playwright";

function localAppData(): string {
  const value = process.env.LOCALAPPDATA?.trim();
  if (!value || !path.isAbsolute(value)) throw new Error("LOCALAPPDATA is unavailable or invalid.");
  return path.resolve(value);
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
  const probeRoot = path.join(localAppData(), "GameFinder", "cdp-probes");
  const profileDirectory = path.join(probeRoot, `probe-${process.pid}-${Date.now()}`);
  const resolvedProfile = path.resolve(profileDirectory);
  const expectedPrefix = `${path.resolve(probeRoot)}${path.sep}`.toLowerCase();
  if (!resolvedProfile.toLowerCase().startsWith(expectedPrefix)) {
    throw new Error("Refusing to use a CDP probe Profile outside the dedicated probe root.");
  }

  const port = await reserveLoopbackPort();
  const executablePath = chromium.executablePath();
  const child = spawn(
    executablePath,
    [
      `--user-data-dir=${resolvedProfile}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      "about:blank"
    ],
    {
      stdio: "ignore",
      windowsHide: true
    }
  );

  try {
    const endpoint = await waitForCdp(port, child);
    const browser = await chromium.connectOverCDP(endpoint);
    try {
      const context = browser.contexts()[0];
      if (!context) throw new Error("CDP did not expose the ordinary Chromium context.");
      const page = context.pages()[0] ?? (await context.newPage());
      const signals = await page.evaluate(() => ({
        webdriver: navigator.webdriver,
        userAgent: navigator.userAgent,
        languages: [...navigator.languages],
        pluginCount: navigator.plugins.length
      }));
      process.stdout.write(
        `${JSON.stringify({
          ok: signals.webdriver === false,
          launchMode: "ordinary_chromium_fixed_cdp",
          cdpAddress: "127.0.0.1",
          webdriver: signals.webdriver,
          userAgentContainsHeadless: /headless/i.test(signals.userAgent),
          languageCount: signals.languages.length,
          pluginCount: signals.pluginCount
        })}\n`
      );
      if (signals.webdriver !== false) {
        throw new Error("The fixed-port ordinary Chromium launch still exposes navigator.webdriver.");
      }
    } finally {
      await browser.close();
    }
  } finally {
    await terminate(child);
    await rm(resolvedProfile, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown ordinary Chromium CDP probe failure.";
  console.error(`CDP_PROBE_FAILED: ${message}`);
  process.exitCode = 1;
});
