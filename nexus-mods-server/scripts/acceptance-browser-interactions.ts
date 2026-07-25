import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = path.resolve(projectDirectory, "..");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDirectory = path.join(workspaceDirectory, ".codex-work", "acceptance-pc5", runId);
const evidencePath = path.join(evidenceDirectory, "pc5-interaction-status.json");
const vitestEntry = path.join(projectDirectory, "node_modules", "vitest", "vitest.mjs");

const scenarios = [
  { page: "CAPTCHA", outcome: "user_interaction_required", reason: "captcha" },
  { page: "two-factor authentication", outcome: "user_interaction_required", reason: "two_factor" },
  { page: "adult-content confirmation", outcome: "user_interaction_required", reason: "adult_content" },
  { page: "cookie consent", outcome: "user_interaction_required", reason: "cookie_consent" },
  { page: "rate limiting", outcome: "failed", reason: null },
  { page: "maintenance", outcome: "failed", reason: null }
] as const;

async function runTests(): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      vitestEntry,
      "run",
      "tests/page-classifier.test.ts",
      "tests/browser-download-manager.test.ts",
      "tests/browser-download-flow.integration.test.ts"
    ],
    {
      cwd: projectDirectory,
      env: {
        ...process.env,
        NEXUS_BROWSER_INTEGRATION_TEST: "1"
      },
      stdio: "inherit",
      windowsHide: true
    }
  );
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`PC-5 controlled-browser tests exited with code ${exitCode}.`);
}

async function writeEvidence(ok: boolean, message?: string): Promise<void> {
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        ok,
        case: "PC-5",
        method: "controlled Chromium pages plus same-session manager recovery",
        scenarios,
        assertions: {
          visibleBrowserFlowClassified: ok,
          captchaBypassAttempted: false,
          sameSessionRecoveryCovered: ok,
          technicalFailuresSeparatedFromUserInteraction: ok
        },
        ...(message ? { message } : {}),
        checkedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function main(): Promise<void> {
  try {
    await runTests();
    await writeEvidence(true);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        case: "PC-5",
        scenarioCount: scenarios.length,
        evidencePath
      })}\n`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown PC-5 acceptance failure.";
    await writeEvidence(false, message).catch(() => undefined);
    throw error;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown PC-5 acceptance failure.";
  console.error(`PC5_ACCEPTANCE_FAILED: ${message}`);
  process.exitCode = 1;
});
