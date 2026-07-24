import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OrdinaryCdpBrowserManager } from "./browser/ordinary-cdp-browser-manager.js";
import { NexusDownloadPageController } from "./browser/nexus-download-page-controller.js";
import { createStagingPath, finalizeDownloadedFile } from "./download-verifier.js";
import { asNexusError } from "./errors.js";
import { NexusClient } from "./nexus-client.js";

const TARGET_MOD_URL = "https://www.nexusmods.com/eldenring/mods/9531";
const TARGET_FILE_ID = 47215;
const EXPECTED_BYTES = 1_474_885;
const EXPECTED_SHA256 = "f3e339ea655b5eba4173f401005baef68506fa125de0b823dd27a733f94e4abd";
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = path.resolve(projectDirectory, "..");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outputDirectory = path.join(
  workspaceDirectory,
  ".codex-work",
  "acceptance-downloads-cdp",
  "eldenring",
  "mod-9531",
  runId
);
const statusPath = path.join(outputDirectory, "status.json");

async function writeStatus(value: Record<string, unknown>): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    statusPath,
    `${JSON.stringify(
      {
        target: {
          modUrl: TARGET_MOD_URL,
          fileId: TARGET_FILE_ID,
          expectedBytes: EXPECTED_BYTES,
          expectedSha256: EXPECTED_SHA256
        },
        outputDirectory,
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

async function main(): Promise<void> {
  if (process.env.NEXUS_LIVE_TEST !== "1") {
    throw new Error("Set NEXUS_LIVE_TEST=1 to run the real ordinary-Chromium CDP download acceptance.");
  }

  const client = new NexusClient();
  const browser = new OrdinaryCdpBrowserManager();
  await writeStatus({ phase: "starting" });

  try {
    const [{ mod }, { files }] = await Promise.all([
      client.getMod("eldenring", 9531),
      client.getModFiles("eldenring", 9531)
    ]);
    if (!mod.available || mod.status.toLowerCase() !== "published") {
      throw new Error("Target Mod is not currently published and available.");
    }
    const file = files.find((item) => item.fileId === TARGET_FILE_ID);
    if (!file) throw new Error(`Target fileId ${TARGET_FILE_ID} was not found.`);
    if (file.sizeInBytes !== EXPECTED_BYTES) {
      throw new Error(
        `Nexus metadata size changed: expected ${EXPECTED_BYTES}, received ${String(file.sizeInBytes)}.`
      );
    }

    const targetUrl = `${TARGET_MOD_URL}?tab=files&file_id=${TARGET_FILE_ID}`;
    const page = await browser.getPage(targetUrl);
    const signals = await page.evaluate<{
      webdriver: boolean;
      userAgentContainsHeadless: boolean;
    }>(
      "({ webdriver: navigator.webdriver, userAgentContainsHeadless: /headless/i.test(navigator.userAgent) })"
    );
    if (signals.webdriver !== false || signals.userAgentContainsHeadless) {
      throw new Error("Ordinary Chromium exposed an automated or headless browser signal.");
    }

    const staging = await createStagingPath({
      outputDirectory,
      sessionId: `phase5-cdp-${Date.now()}`,
      preferredFileName: file.fileName
    });
    const controller = new NexusDownloadPageController(page, browser.config, (state) => {
      report({ phase: "browser_flow", state });
    });
    await writeStatus({
      phase: "browser_flow",
      file: {
        fileId: file.fileId,
        fileName: file.fileName,
        sizeInBytes: file.sizeInBytes
      },
      webdriver: signals.webdriver,
      userAgentContainsHeadless: signals.userAgentContainsHeadless
    });
    const result = await controller.run({
      domainName: "eldenring",
      modId: 9531,
      fileId: TARGET_FILE_ID,
      fileName: file.fileName,
      saveAsPath: staging.stagingPath
    });
    const receipt = await finalizeDownloadedFile({
      backend: "persistent_chromium",
      canonicalModUrl: TARGET_MOD_URL,
      domainName: "eldenring",
      modId: 9531,
      fileId: TARGET_FILE_ID,
      expectedSizeInBytes: EXPECTED_BYTES,
      outputDirectory,
      stagingPath: staging.stagingPath,
      suggestedFileName: result.suggestedFilename,
      apiFileName: file.fileName
    });
    if (receipt.bytes !== EXPECTED_BYTES || receipt.sha256 !== EXPECTED_SHA256) {
      throw new Error(
        `Baseline mismatch after verification: bytes=${receipt.bytes}, sha256=${receipt.sha256}.`
      );
    }
    if (receipt.archiveCheck.valid === false) {
      throw new Error(`Archive validation failed: ${receipt.archiveCheck.detail}`);
    }
    await writeStatus({ phase: "completed", receipt });
    report({
      phase: "completed",
      absolutePath: receipt.absolutePath,
      receiptPath: receipt.receiptPath,
      bytes: receipt.bytes,
      sha256: receipt.sha256,
      archiveCheck: receipt.archiveCheck,
      backend: receipt.backend
    });
  } catch (error) {
    const nexusError = asNexusError(error);
    await writeStatus({
      phase: "failed",
      error: {
        code: nexusError.code,
        message: nexusError.message,
        retryable: nexusError.retryable
      },
      failedAt: new Date().toISOString()
    });
    throw nexusError;
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  const nexusError = asNexusError(error);
  console.error(`CDP_DOWNLOAD_FAILED: ${nexusError.code}: ${nexusError.message}`);
  process.exitCode = 1;
});
