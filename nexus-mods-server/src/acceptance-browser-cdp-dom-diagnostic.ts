import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OrdinaryCdpBrowserManager } from "./browser/ordinary-cdp-browser-manager.js";
import { asNexusError } from "./errors.js";

const TARGET_URL = "https://www.nexusmods.com/eldenring/mods/9531?tab=files&file_id=47215";
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = path.resolve(projectDirectory, "..");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outputDirectory = path.join(workspaceDirectory, ".codex-work", "phase5-cdp-dom-diagnostic", runId);
const diagnosticPath = path.join(outputDirectory, "diagnostic.json");

async function main(): Promise<void> {
  if (process.env.NEXUS_LIVE_TEST !== "1") {
    throw new Error("Set NEXUS_LIVE_TEST=1 to run the real Nexus DOM diagnostic.");
  }
  await mkdir(outputDirectory, { recursive: true });
  const browser = new OrdinaryCdpBrowserManager();
  try {
    const page = await browser.getPage(TARGET_URL);
    await page.waitForLoadState("domcontentloaded", { timeout: browser.config.navigationTimeoutMs });
    await page.waitForTimeout(5_000);
    let filesTabClicked = false;
    const displayName = page.getByText("ErdGameTools 20260607", { exact: false });
    if ((await displayName.count()) === 0) {
      filesTabClicked = await page.evaluate(() => {
        const link = Array.from(document.querySelectorAll("a")).find(
          (element) =>
            ((element as HTMLElement).innerText ?? element.textContent ?? "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase() === "files 2"
        );
        if (!(link instanceof HTMLAnchorElement)) return false;
        link.click();
        return true;
      });
      if (filesTabClicked) {
        await page.waitForTimeout(5_000);
      }
    }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3_000);
    const pageDiagnostic = await page.evaluate(() => {
      const visible = (element: Element): boolean => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 180);
      const safeHref = (value: string): string => {
        try {
          const url = new URL(value, location.href);
          if (!url.hostname.endsWith("nexusmods.com")) return `${url.hostname}${url.pathname}`.slice(0, 240);
          const safe = new URL(`${url.origin}${url.pathname}`);
          for (const key of ["tab", "file_id", "id", "fid"]) {
            const parameter = url.searchParams.get(key);
            if (parameter !== null) safe.searchParams.set(key, parameter);
          }
          return `${safe.pathname}${safe.search}`.slice(0, 240);
        } catch {
          return value.split("?")[0]?.slice(0, 240) ?? "";
        }
      };
      const actions = Array.from(document.querySelectorAll("button, a, [role='button']"))
        .filter(visible)
        .map((element) => {
          const text = normalize((element as HTMLElement).innerText ?? element.textContent ?? "");
          const href = element instanceof HTMLAnchorElement ? safeHref(element.href) : null;
          return { tag: element.tagName.toLowerCase(), text, href };
        })
        .filter(
          (item) =>
            /download|file|manual|slow|standard|requirement/i.test(item.text) ||
            /file|download/i.test(item.href ?? "")
        )
        .slice(0, 80);
      const references = Array.from(document.querySelectorAll("*"))
        .filter((element) => {
          if (element.attributes.length === 0) return false;
          return Array.from(element.attributes).some((attribute) => {
            const combined = `${attribute.name}=${attribute.value}`;
            return /47215|file.?id|download|file-expander|file-row/i.test(combined);
          });
        })
        .slice(0, 120)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          id: normalize(element.id),
          className: normalize(
            typeof element.className === "string" ? element.className : element.getAttribute("class") ?? ""
          ),
          text: normalize((element as HTMLElement).innerText ?? element.textContent ?? ""),
          attributes: Object.fromEntries(
            Array.from(element.attributes)
              .filter((attribute) => /^(?:data-|aria-|href$|id$|class$)/i.test(attribute.name))
              .slice(0, 20)
              .map((attribute) => [
                attribute.name,
                attribute.name.toLowerCase() === "href" ? safeHref(attribute.value) : attribute.value.slice(0, 240)
              ])
          )
        }));
      const bodyText = (document.body?.innerText ?? "").slice(0, 50_000);
      return {
        url: `${location.pathname}${location.search}`,
        title: document.title,
        readyState: document.readyState,
        bodyTextLength: bodyText.length,
        bodySignals: {
          fileId: bodyText.includes("47215"),
          apiFileName: bodyText.includes("ErdGameTools 20260607-9531-1-3-1-1780798908.zip"),
          displayName: bodyText.includes("ErdGameTools 20260607"),
          manualDownload: /\bmanual\s+download\b/i.test(bodyText),
          loginPrompt: /sign in|log in/i.test(bodyText),
          cloudflare: /cloudflare|verify you are human|checking your browser/i.test(bodyText)
        },
        actionCount: actions.length,
        actions,
        referenceCount: references.length,
        references
      };
    });
    const nameMatches = page.getByText("ErdGameTools 20260607", { exact: false });
    const nameMatchCount = await nameMatches.count();
    const nameMatchDetails: Array<Record<string, unknown>> = [];
    for (let index = 0; index < Math.min(nameMatchCount, 5); index += 1) {
      nameMatchDetails.push(
        await nameMatches.nth(index).evaluate((element) => {
          const attributes = (target: Element): Record<string, string> =>
            Object.fromEntries(
              Array.from(target.attributes)
                .filter((attribute) => /^(?:data-|aria-|id$|class$)/i.test(attribute.name))
                .map((attribute) => [attribute.name, attribute.value.slice(0, 240)])
            );
          const ancestors: Array<Record<string, unknown>> = [];
          let current: Element | null = element;
          for (let depth = 0; current && depth < 8; depth += 1) {
            ancestors.push({
              tag: current.tagName.toLowerCase(),
              attributes: attributes(current)
            });
            current = current.parentElement;
          }
          const root = element.getRootNode();
          return {
            text: ((element as HTMLElement).innerText ?? element.textContent ?? "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 240),
            ancestors,
            shadowHost:
              root instanceof ShadowRoot
                ? {
                    tag: root.host.tagName.toLowerCase(),
                    attributes: attributes(root.host)
                  }
                : null
          };
        })
      );
    }
    const manualActions = page
      .getByRole("button", { name: /\bmanual\s+download\b/i })
      .or(page.getByRole("link", { name: /\bmanual\s+download\b/i }));
    const downloadComponent = page.locator("mod-file-download");
    const componentActions = downloadComponent.locator("button, a, [role='button']");
    const componentActionCount = await componentActions.count();
    const componentActionDetails: Array<Record<string, unknown>> = [];
    for (let index = 0; index < Math.min(componentActionCount, 40); index += 1) {
      componentActionDetails.push(
        await componentActions.nth(index).evaluate((element) => ({
          tag: element.tagName.toLowerCase(),
          text: ((element as HTMLElement).innerText ?? element.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 240),
          href:
            element instanceof HTMLAnchorElement
              ? `${new URL(element.href).pathname}${new URL(element.href).search}`.slice(0, 240)
              : null,
          attributes: Object.fromEntries(
            Array.from(element.attributes)
              .filter((attribute) => /^(?:data-|aria-|id$|class$|type$)/i.test(attribute.name))
              .map((attribute) => [attribute.name, attribute.value.slice(0, 240)])
          )
        }))
      );
    }
    const diagnostic = {
      ...pageDiagnostic,
      filesTabClicked,
      playwrightLocators: {
        nameMatchCount,
        nameMatchDetails,
        manualDownloadCount: await manualActions.count(),
        modFileDownloadCount: await page.locator("mod-file-download").count(),
        modDownloadModalCount: await page.locator("mod-download-modal").count(),
        componentText:
          (await downloadComponent.count()) === 1
            ? (await downloadComponent.innerText()).replace(/\s+/g, " ").trim().slice(0, 2_000)
            : null,
        componentActionCount,
        componentActionDetails
      }
    };
    await writeFile(diagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        diagnosticPath,
        url: diagnostic.url,
        title: diagnostic.title,
        readyState: diagnostic.readyState,
        bodyTextLength: diagnostic.bodyTextLength,
        bodySignals: diagnostic.bodySignals,
        actionCount: diagnostic.actionCount,
        referenceCount: diagnostic.referenceCount
      })}\n`
    );
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  const nexusError = asNexusError(error);
  console.error(`CDP_DOM_DIAGNOSTIC_FAILED: ${nexusError.code}: ${nexusError.message}`);
  process.exitCode = 1;
});
