import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_MOD_URL = "https://www.nexusmods.com/eldenring/mods/9531";
const TARGET_FILE_ID = 47215;
const POLL_INTERVAL_MS = 500;
const STATE_TIMEOUT_MS = 90_000;

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = path.resolve(projectDirectory, "..");
const serverEntry = path.join(projectDirectory, "dist", "index.js");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDirectory = path.join(workspaceDirectory, ".codex-work", "acceptance-pc4", runId);
const evidencePath = path.join(evidenceDirectory, "pc4-expired-login-status.json");

interface ToolResponse {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
}

interface DownloadStatus {
  sessionId: string;
  state: string;
  authState: string;
  requiresUserInteraction: boolean;
  interactionReason: string | null;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  } | null;
}

function structured(result: unknown): Record<string, unknown> {
  const response = result as ToolResponse;
  if (!response.isError && response.structuredContent) return response.structuredContent;
  const message = (response.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("; ");
  throw new Error(message || "MCP tool failed without a safe error message.");
}

function localAppData(): string {
  const value = process.env.LOCALAPPDATA?.trim();
  if (!value || !path.isAbsolute(value)) {
    throw new Error("LOCALAPPDATA is unavailable or is not an absolute path.");
  }
  return path.resolve(value);
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function waitForLoginRequired(client: Client, sessionId: string): Promise<DownloadStatus> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  let previousState = "";
  let lastStatus: DownloadStatus | undefined;
  while (Date.now() < deadline) {
    const result = await client.callTool({
      name: "get_download_status",
      arguments: { sessionId }
    });
    const status = structured(result).download as unknown as DownloadStatus;
    lastStatus = status;
    if (status.state !== previousState) {
      previousState = status.state;
      process.stdout.write(
        `${JSON.stringify({
          case: "PC-4",
          phase: "download_status",
          state: status.state,
          authState: status.authState,
          requiresUserInteraction: status.requiresUserInteraction,
          interactionReason: status.interactionReason,
          errorCode: status.error?.code ?? null
        })}\n`
      );
      await writeFile(
        evidencePath,
        `${JSON.stringify(
          {
            ok: false,
            case: "PC-4",
            phase: "running",
            lastStatus: {
              state: status.state,
              authState: status.authState,
              requiresUserInteraction: status.requiresUserInteraction,
              interactionReason: status.interactionReason,
              errorCode: status.error?.code ?? null
            },
            checkedAt: new Date().toISOString()
          },
          null,
          2
        )}\n`,
        "utf8"
      );
    }
    if (status.state === "login_required") return status;
    if (["failed", "canceled", "completed"].includes(status.state)) {
      throw new Error(
        `Expected login_required, observed ${status.state}: ${status.error?.code ?? "NO_ERROR_CODE"}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Timed out waiting for login_required; last state was ${lastStatus?.state ?? "unknown"} ` +
      `(${lastStatus?.error?.code ?? "NO_ERROR_CODE"}).`
  );
}

function assertLoginRequired(status: DownloadStatus): void {
  if (
    status.state !== "login_required" ||
    status.authState !== "login_required" ||
    status.requiresUserInteraction !== true ||
    status.interactionReason !== "login" ||
    status.error?.code !== "LOGIN_REQUIRED" ||
    status.error.retryable !== true
  ) {
    throw new Error(`Invalid expired-login state: ${JSON.stringify(status)}`);
  }
}

async function removeTemporaryProfile(profileRoot: string, profileDirectory: string): Promise<void> {
  if (!isInside(profileRoot, profileDirectory)) {
    throw new Error("Refusing to remove a PC-4 Profile outside the dedicated acceptance root.");
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(profileDirectory, { recursive: true, force: true, maxRetries: 2, retryDelay: 250 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const message = lastError instanceof Error ? lastError.message : "unknown cleanup error";
  process.stderr.write(`PC4_PROFILE_CLEANUP_WARNING: ${message}\n`);
}

async function main(): Promise<void> {
  if (process.env.NEXUS_LIVE_TEST !== "1") {
    throw new Error("Set NEXUS_LIVE_TEST=1 to run PC-4 against a real Nexus login page.");
  }

  const profileRoot = path.join(localAppData(), "GameFinder", "acceptance-profiles");
  await mkdir(profileRoot, { recursive: true });
  const profileDirectory = await mkdtemp(path.join(profileRoot, "pc4-clean-"));
  if (!isInside(profileRoot, profileDirectory)) {
    throw new Error("Refusing to use or remove a PC-4 Profile outside the dedicated acceptance root.");
  }
  await mkdir(evidenceDirectory, { recursive: true });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: projectDirectory,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
      ),
      NEXUS_BROWSER_PROFILE_DIR: profileDirectory
    }
  });
  const client = new Client({ name: "nexus-pc4-expired-login-acceptance", version: "0.1.0" });

  try {
    await client.connect(transport);
    const preparedResult = await client.callTool({
      name: "prepare_download",
      arguments: {
        modUrl: TARGET_MOD_URL,
        fileId: TARGET_FILE_ID,
        backend: "persistent_chromium"
      }
    });
    const prepared = structured(preparedResult).download as {
      sessionId: string;
      state: string;
      file: { fileId: number };
    };
    if (prepared.state !== "prepared" || prepared.file.fileId !== TARGET_FILE_ID) {
      throw new Error("PC-4 did not prepare the exact target file.");
    }

    await client.callTool({
      name: "start_download",
      arguments: { sessionId: prepared.sessionId, outputDirectory: evidenceDirectory }
    });
    const first = await waitForLoginRequired(client, prepared.sessionId);
    assertLoginRequired(first);

    const browserResult = await client.callTool({ name: "browser_status", arguments: {} });
    const browser = structured(browserResult).browser as {
      launchMode: string;
      running: boolean;
      authState: string;
      requiresUserInteraction: boolean;
      interactionReason: string | null;
    };
    if (
      browser.launchMode !== "ordinary_chromium_cdp" ||
      browser.running !== true ||
      browser.authState !== "login_required"
    ) {
      throw new Error(`PC-4 browser state is invalid: ${JSON.stringify(browser)}`);
    }

    const retryResult = await client.callTool({
      name: "start_download",
      arguments: { sessionId: prepared.sessionId, outputDirectory: evidenceDirectory }
    });
    const retryStarted = structured(retryResult).download as DownloadStatus;
    if (retryStarted.sessionId !== prepared.sessionId) {
      throw new Error("PC-4 retry did not preserve the prepared session.");
    }
    const second = await waitForLoginRequired(client, prepared.sessionId);
    assertLoginRequired(second);

    const evidence = {
      ok: true,
      case: "PC-4",
      target: { modUrl: TARGET_MOD_URL, fileId: TARGET_FILE_ID },
      launchMode: browser.launchMode,
      firstAttempt: {
        state: first.state,
        authState: first.authState,
        requiresUserInteraction: first.requiresUserInteraction,
        interactionReason: first.interactionReason,
        errorCode: first.error?.code,
        retryable: first.error?.retryable
      },
      sameSessionRetry: {
        preservedSession: true,
        state: second.state,
        errorCode: second.error?.code
      },
      primaryProfileUntouched: true,
      checkedAt: new Date().toISOString()
    };
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ...evidence, evidencePath })}\n`);
  } finally {
    await client.close().catch(() => undefined);
    await removeTemporaryProfile(profileRoot, profileDirectory);
  }
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown PC-4 acceptance failure.";
  await mkdir(evidenceDirectory, { recursive: true }).catch(() => undefined);
  await writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        ok: false,
        case: "PC-4",
        phase: "failed",
        message,
        failedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    "utf8"
  ).catch(() => undefined);
  console.error(`PC4_ACCEPTANCE_FAILED: ${message}`);
  process.exitCode = 1;
});
