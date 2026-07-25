import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserConfig } from "../src/browser/browser-config.js";
import {
  NexusDownloadPageController,
  type BrowserDownloadState
} from "../src/browser/nexus-download-page-controller.js";

const enabled = process.env.NEXUS_BROWSER_INTEGRATION_TEST === "1";
const temporaryDirectories: string[] = [];
let browser: Browser;

const config: BrowserConfig = {
  profileDir: "C:\\fixture-profile-not-used",
  launchTimeoutMs: 10_000,
  navigationTimeoutMs: 5_000,
  downloadStartTimeoutMs: 5_000,
  downloadTimeoutMs: 5_000,
  loginWaitMs: 60_000,
  keepOpen: true
};

function fixtureHtml(options: {
  duplicateRows?: boolean;
  resumableOnly?: boolean;
  standardDirectDownload?: boolean;
  slowDelayMs?: number;
} = {}): string {
  const row = `
    <section data-fileid="47215">
      <h2>ErdGameTools 20260607</h2>
      <button id="manual">Manual Download</button>
    </section>`;
  const rows = options.duplicateRows ? `${row}${row.replace('id="manual"', 'id="manual-duplicate"')}` : row;
  const optionsMarkup = options.resumableOnly
    ? '<section data-testid="download-options"><button>Resumable Download</button></section>'
    : '<section data-testid="download-options"><button id="standard">Standard Download</button><button>Resumable Download</button></section>';

  return `<!doctype html>
    <html>
      <head><title>Local Nexus download fixture</title></head>
      <body>
        <main>${rows}</main>
        <script>
          function triggerFixtureDownload() {
            const blob = new Blob(["fixture archive bytes"], { type: "application/octet-stream" });
            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = "fixture-mod.zip";
            document.body.appendChild(link);
            link.click();
          }
          for (const manual of document.querySelectorAll('[id^="manual"]')) {
            manual.addEventListener("click", () => {
              document.body.insertAdjacentHTML(
                "beforeend",
                '<section role="dialog" aria-modal="true" data-testid="requirements-dialog"><h2>Requirements</h2><button id="continue">Continue Download</button></section>'
              );
              document.querySelector("#continue").addEventListener("click", () => {
                document.querySelector('[data-testid="requirements-dialog"]').remove();
                document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(optionsMarkup)});
                const standard = document.querySelector("#standard");
                if (standard) {
                  standard.addEventListener("click", () => {
                    if (${options.standardDirectDownload === true}) {
                      triggerFixtureDownload();
                      return;
                    }
                    document.querySelector('[data-testid="download-options"]').remove();
                    document.body.insertAdjacentHTML(
                      "beforeend",
                      '<button id="slow" disabled>Slow Download</button>'
                    );
                    const slow = document.querySelector("#slow");
                    setTimeout(() => { slow.disabled = false; }, ${options.slowDelayMs ?? 30});
                    slow.addEventListener("click", triggerFixtureDownload);
                  });
                }
              });
            });
          }
        </script>
      </body>
    </html>`;
}

function shadowDirectSlowFixtureHtml(): string {
  return `<!doctype html>
    <html>
      <head><title>Local Nexus Shadow DOM download fixture</title></head>
      <body>
        <mod-file-download></mod-file-download>
        <script>
          function triggerFixtureDownload() {
            const blob = new Blob(["shadow fixture archive bytes"], { type: "application/octet-stream" });
            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = "shadow-fixture-mod.zip";
            document.body.appendChild(link);
            link.click();
          }
          customElements.define("mod-file-download", class extends HTMLElement {
            connectedCallback() {
              const root = this.attachShadow({ mode: "open" });
              root.innerHTML =
                '<div id="download-section"><span>ErdGameTools 20260607</span><button type="button">Slow Download</button></div>';
              root.querySelector("button").addEventListener("click", triggerFixtureDownload);
            }
          });
        </script>
      </body>
    </html>`;
}

async function routeFixture(page: Page, html: string, status = 200): Promise<void> {
  await page.route("https://www.nexusmods.com/**", async (route: Route) => {
    await route.fulfill({ status, contentType: "text/html; charset=utf-8", body: html });
  });
}

describe.skipIf(!enabled)("Nexus browser download HTML fixture", () => {
  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      executablePath: chromium.executablePath()
    });
  });

  afterAll(async () => {
    await browser?.close();
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("completes Manual → Requirements → Standard → Slow and saves the Playwright download", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nexus-browser-flow-"));
    temporaryDirectories.push(directory);
    const stagingPath = path.join(directory, "fixture.part");
    const page = await browser.newPage({ acceptDownloads: true });
    await routeFixture(page, fixtureHtml());
    const states: BrowserDownloadState[] = [];
    const controller = new NexusDownloadPageController(page, config, (state) => states.push(state));

    try {
      const result = await controller.run({
        domainName: "eldenring",
        modId: 9531,
        fileId: 47215,
        fileName: "ErdGameTools 20260607-9531-1-3-1-1780798908.zip",
        saveAsPath: stagingPath
      });

      expect(result).toMatchObject({
        state: "verifying",
        suggestedFilename: "fixture-mod.zip",
        savedPath: stagingPath,
        sourcePage: "/eldenring/mods/9531"
      });
      expect(await readFile(stagingPath, "utf8")).toBe("fixture archive bytes");
      expect(states).toEqual(
        expect.arrayContaining([
          "navigating",
          "locating_file",
          "handling_requirements",
          "waiting_download_option",
          "waiting_slow_download",
          "downloading",
          "verifying"
        ])
      );
    } finally {
      await page.close();
    }
  });

  it("rejects an ambiguous fileId container before clicking", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nexus-browser-ambiguous-"));
    temporaryDirectories.push(directory);
    const page = await browser.newPage({ acceptDownloads: true });
    await routeFixture(page, fixtureHtml({ duplicateRows: true }));
    const controller = new NexusDownloadPageController(page, config);

    try {
      await expect(
        controller.run({
          domainName: "eldenring",
          modId: 9531,
          fileId: 47215,
          fileName: "ErdGameTools.zip",
          saveAsPath: path.join(directory, "fixture.part")
        })
      ).rejects.toMatchObject({ code: "FILE_ROW_AMBIGUOUS" });
    } finally {
      await page.close();
    }
  });

  it("maps the live-site Cloudflare shape to CAPTCHA_REQUIRED without clicking", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nexus-browser-cloudflare-"));
    temporaryDirectories.push(directory);
    const page = await browser.newPage({ acceptDownloads: true });
    await routeFixture(
      page,
      "<!doctype html><html><head><title>Just a moment...</title></head><body>Performing security verification by Cloudflare</body></html>"
    );
    const controller = new NexusDownloadPageController(page, config);

    try {
      await expect(
        controller.run({
          domainName: "eldenring",
          modId: 9531,
          fileId: 47215,
          fileName: "ErdGameTools.zip",
          saveAsPath: path.join(directory, "fixture.part")
        })
      ).rejects.toMatchObject({ code: "CAPTCHA_REQUIRED", retryable: true });
      expect(controller.state).toBe("user_interaction_required");
    } finally {
      await page.close();
    }
  });

  it("recognizes the localized short Cloudflare challenge currently returned by Nexus", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nexus-browser-cloudflare-localized-"));
    temporaryDirectories.push(directory);
    const page = await browser.newPage({ acceptDownloads: true });
    await routeFixture(
      page,
      "<!doctype html><html><head><title>请稍候…</title></head><body>Request verification is provided by Cloudflare.</body></html>"
    );
    const controller = new NexusDownloadPageController(page, config);

    try {
      await expect(
        controller.run({
          domainName: "eldenring",
          modId: 9531,
          fileId: 47215,
          fileName: "ErdGameTools.zip",
          saveAsPath: path.join(directory, "fixture.part")
        })
      ).rejects.toMatchObject({ code: "CAPTCHA_REQUIRED" });
    } finally {
      await page.close();
    }
  });

  it.each([
    [
      "logged-out file page",
      "<!doctype html><html><head><title>Mod files</title></head><body><a href='https://users.nexusmods.com/auth/sign_in'>Log in</a><section data-fileid='47215'>ErdGameTools</section></body></html>",
      200,
      "LOGIN_REQUIRED",
      "login_required"
    ],
    [
      "two-factor authentication",
      "<!doctype html><html><head><title>Verify account</title></head><body>Enter your authentication code to continue.</body></html>",
      200,
      "TWO_FACTOR_REQUIRED",
      "user_interaction_required"
    ],
    [
      "adult-content confirmation",
      "<!doctype html><html><head><title>Adult content</title></head><body>Adult content requires confirmation in your preferences.</body></html>",
      200,
      "ADULT_CONTENT_CONFIRMATION_REQUIRED",
      "user_interaction_required"
    ],
    [
      "cookie consent",
      "<!doctype html><html><head><title>Privacy choices</title></head><body><div role='dialog'>We use cookies.<button>Accept all cookies</button></div></body></html>",
      200,
      "COOKIE_CONSENT_REQUIRED",
      "user_interaction_required"
    ],
    [
      "rate limiting",
      "<!doctype html><html><head><title>Too many requests</title></head><body>Rate limit exceeded.</body></html>",
      429,
      "NEXUS_RATE_LIMITED",
      "failed"
    ],
    [
      "maintenance",
      "<!doctype html><html><head><title>Maintenance</title></head><body>Service temporarily unavailable for maintenance.</body></html>",
      503,
      "NEXUS_MAINTENANCE",
      "failed"
    ]
  ])("classifies %s and stops safely", async (_name, html, status, code, finalState) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nexus-browser-interaction-"));
    temporaryDirectories.push(directory);
    const page = await browser.newPage({ acceptDownloads: true });
    await routeFixture(page, html, status);
    const controller = new NexusDownloadPageController(page, config);

    try {
      await expect(
        controller.run({
          domainName: "eldenring",
          modId: 9531,
          fileId: 47215,
          fileName: "ErdGameTools.zip",
          saveAsPath: path.join(directory, "fixture.part")
        })
      ).rejects.toMatchObject({ code, retryable: true });
      expect(controller.state).toBe(finalState);
    } finally {
      await page.close();
    }
  });

  it("registers the download event before a direct Standard Download starts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nexus-browser-standard-direct-"));
    temporaryDirectories.push(directory);
    const stagingPath = path.join(directory, "fixture.part");
    const page = await browser.newPage({ acceptDownloads: true });
    await routeFixture(page, fixtureHtml({ standardDirectDownload: true }));
    const controller = new NexusDownloadPageController(page, config);

    try {
      const result = await controller.run({
        domainName: "eldenring",
        modId: 9531,
        fileId: 47215,
        fileName: "ErdGameTools.zip",
        saveAsPath: stagingPath
      });
      expect(result.state).toBe("verifying");
      expect(await readFile(stagingPath, "utf8")).toBe("fixture archive bytes");
    } finally {
      await page.close();
    }
  });

  it("recognizes a direct Slow Download action inside the real-site Shadow DOM shape", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nexus-browser-shadow-direct-"));
    temporaryDirectories.push(directory);
    const stagingPath = path.join(directory, "fixture.part");
    const page = await browser.newPage({ acceptDownloads: true });
    await routeFixture(page, shadowDirectSlowFixtureHtml());
    const controller = new NexusDownloadPageController(page, config);

    try {
      const result = await controller.run({
        domainName: "eldenring",
        modId: 9531,
        fileId: 47215,
        fileName: "ErdGameTools 20260607-9531-1-3-1.zip",
        saveAsPath: stagingPath
      });
      expect(result).toMatchObject({
        state: "verifying",
        suggestedFilename: "shadow-fixture-mod.zip",
        savedPath: stagingPath
      });
      expect((await readFile(stagingPath, "utf8"))).toBe("shadow fixture archive bytes");
    } finally {
      await page.close();
    }
  });

  it("does not fall back to Resumable Download", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nexus-browser-resumable-"));
    temporaryDirectories.push(directory);
    const page = await browser.newPage({ acceptDownloads: true });
    await routeFixture(page, fixtureHtml({ resumableOnly: true }));
    const controller = new NexusDownloadPageController(page, config);

    try {
      await expect(
        controller.run({
          domainName: "eldenring",
          modId: 9531,
          fileId: 47215,
          fileName: "ErdGameTools.zip",
          saveAsPath: path.join(directory, "fixture.part")
        })
      ).rejects.toMatchObject({ code: "RESUMABLE_DOWNLOAD_NOT_SUPPORTED" });
    } finally {
      await page.close();
    }
  });

  it("cancels before the disabled Slow Download action is clicked", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nexus-browser-cancel-"));
    temporaryDirectories.push(directory);
    const page = await browser.newPage({ acceptDownloads: true });
    await routeFixture(page, fixtureHtml({ slowDelayMs: 30_000 }));
    let releaseSlowState: (() => void) | undefined;
    const reachedSlowState = new Promise<void>((resolve) => {
      releaseSlowState = resolve;
    });
    const controller = new NexusDownloadPageController(page, config, (state) => {
      if (state === "waiting_slow_download") releaseSlowState?.();
    });

    try {
      const running = controller.run({
        domainName: "eldenring",
        modId: 9531,
        fileId: 47215,
        fileName: "ErdGameTools.zip",
        saveAsPath: path.join(directory, "fixture.part")
      });
      await reachedSlowState;
      await controller.cancel();
      await expect(running).rejects.toMatchObject({ code: "DOWNLOAD_CANCELED" });
      expect(controller.state).toBe("canceled");
    } finally {
      await page.close();
    }
  });
});
