import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_MOD_URL = "https://www.nexusmods.com/eldenring/mods/9531";
const TARGET_FILE_ID = 47215;
const EXPECTED_BYTES = 1_474_885;
const EXPECTED_SHA256 = "f3e339ea655b5eba4173f401005baef68506fa125de0b823dd27a733f94e4abd";
const POLL_INTERVAL_MS = 2_000;
const ACCEPTANCE_TIMEOUT_MS = 30 * 60_000;

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = path.resolve(projectDirectory, "..");
const serverEntry = path.join(projectDirectory, "dist", "index.js");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const configuredOutput = process.env.NEXUS_ACCEPTANCE_OUTPUT_DIR?.trim();
const outputDirectory = configuredOutput
  ? path.resolve(configuredOutput)
  : path.join(workspaceDirectory, ".codex-work", "acceptance-downloads", "eldenring", "mod-9531", runId);
const statusPath = path.join(outputDirectory, "phase5-acceptance-status.json");
const resumeSignalPath = path.join(outputDirectory, "resume-after-interaction.flag");

interface ToolResponse {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
}

interface PreparedDownload {
  sessionId: string;
  backend: "persistent_chromium";
  state: string;
  file: {
    fileId: number;
    fileName: string;
    sizeInBytes: number | null;
  };
}

interface DownloadStatus {
  sessionId: string;
  backend: "persistent_chromium";
  state: string;
  requiresUserInteraction: boolean;
  interactionReason: string | null;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  } | null;
  receipt: AcceptanceReceipt | null;
}

interface AcceptanceReceipt {
  schemaVersion: number;
  backend: "persistent_chromium";
  canonicalModUrl: string;
  modId: number;
  fileId: number;
  fileName: string;
  bytes: number;
  sha256: string;
  completedAt: string;
  absolutePath: string;
  receiptPath: string;
  archiveValid: boolean | null;
  archiveCheck: {
    format: string;
    valid: boolean | null;
    detail: string;
  };
  browser?: {
    engine: string;
    backend: string;
  };
}

function requireLiveOptIn(): void {
  if (process.env.NEXUS_LIVE_TEST !== "1") {
    throw new Error(
      "Real Nexus download acceptance is disabled. Set NEXUS_LIVE_TEST=1 only after explicitly approving one live download."
    );
  }
  if (configuredOutput && !path.isAbsolute(configuredOutput)) {
    throw new Error("NEXUS_ACCEPTANCE_OUTPUT_DIR must be an absolute path when provided.");
  }
  if (!path.isAbsolute(outputDirectory) || path.parse(outputDirectory).root === outputDirectory) {
    throw new Error("NEXUS_ACCEPTANCE_OUTPUT_DIR must resolve to a non-root absolute directory.");
  }
}

function safeToolError(result: unknown): string {
  const response = result as ToolResponse;
  return (response.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("; ");
}

function structured(result: unknown): Record<string, unknown> {
  const response = result as ToolResponse;
  if (response.isError || !response.structuredContent) {
    throw new Error(safeToolError(result) || "MCP tool failed without a safe error message.");
  }
  return response.structuredContent;
}

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

function report(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function validatePrepared(prepared: PreparedDownload): void {
  if (prepared.backend !== "persistent_chromium") {
    throw new Error(`Expected persistent_chromium backend, received ${prepared.backend}.`);
  }
  if (prepared.file.fileId !== TARGET_FILE_ID) {
    throw new Error(`Expected fileId ${TARGET_FILE_ID}, received ${prepared.file.fileId}.`);
  }
  if (prepared.file.sizeInBytes !== EXPECTED_BYTES) {
    throw new Error(
      `Nexus metadata size changed: expected ${EXPECTED_BYTES}, received ${String(prepared.file.sizeInBytes)}.`
    );
  }
}

function validateReceipt(receipt: AcceptanceReceipt): void {
  if (receipt.backend !== "persistent_chromium") throw new Error("Receipt backend is not persistent_chromium.");
  if (receipt.canonicalModUrl !== TARGET_MOD_URL) throw new Error("Receipt canonical Mod URL does not match.");
  if (receipt.modId !== 9531 || receipt.fileId !== TARGET_FILE_ID) throw new Error("Receipt Mod/file identity does not match.");
  if (receipt.bytes !== EXPECTED_BYTES) {
    throw new Error(`Downloaded byte count mismatch: expected ${EXPECTED_BYTES}, received ${receipt.bytes}.`);
  }
  if (receipt.sha256.toLowerCase() !== EXPECTED_SHA256) {
    throw new Error(`Downloaded SHA-256 mismatch: expected ${EXPECTED_SHA256}, received ${receipt.sha256}.`);
  }
  if (receipt.archiveCheck.valid === false) throw new Error(`Archive validation failed: ${receipt.archiveCheck.detail}`);
  if (/\.(?:part|crdownload)$/i.test(receipt.absolutePath)) {
    throw new Error("Final archive still has a temporary download extension.");
  }
  if (!path.isAbsolute(receipt.absolutePath) || !path.isAbsolute(receipt.receiptPath)) {
    throw new Error("Receipt did not return absolute output paths.");
  }
  if (receipt.browser?.engine !== "chromium" || receipt.browser.backend !== "playwright") {
    throw new Error("Receipt browser provenance is missing or invalid.");
  }
}

async function assertNoTemporaryCredentials(receipt: AcceptanceReceipt): Promise<void> {
  const receiptText = await readFile(receipt.receiptPath, "utf8");
  const forbidden = ["nxm://", "key=", "expires=", "cookie", "authorization:"];
  const lowered = receiptText.toLowerCase();
  const match = forbidden.find((value) => lowered.includes(value));
  if (match) throw new Error(`Receipt contains forbidden temporary credential marker: ${match}`);
}

async function waitForResumeSignal(deadline: number): Promise<void> {
  await rm(resumeSignalPath, { force: true });
  report({
    phase: "waiting_for_resume",
    resumeSignalPath,
    message: "Finish the visible browser interaction, then create this empty signal file."
  });
  await writeStatus({
    phase: "waiting_for_resume",
    requiresUserInteraction: true,
    resumeSignalPath
  });
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      await access(resumeSignalPath);
      await rm(resumeSignalPath, { force: true });
      report({ phase: "resume_signal_received" });
      return;
    } catch {
      // The visible page remains untouched until the user/Agent supplies the signal.
    }
  }
  throw new Error("Timed out waiting for the browser-interaction resume signal.");
}

async function startAndWait(client: Client, prepared: PreparedDownload, deadline: number): Promise<AcceptanceReceipt> {
  let interactionReported = "";
  let shouldStart = true;

  while (Date.now() < deadline) {
    if (shouldStart) {
      const startedResult = await client.callTool({
        name: "start_download",
        arguments: {
          sessionId: prepared.sessionId,
          outputDirectory
        }
      });
      const started = structured(startedResult).download as DownloadStatus;
      report({ phase: "download", state: started.state });
      shouldStart = false;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const statusResult = await client.callTool({
      name: "get_download_status",
      arguments: { sessionId: prepared.sessionId }
    });
    const status = structured(statusResult).download as DownloadStatus;
    await writeStatus({
      phase: "downloading",
      sessionId: prepared.sessionId,
      state: status.state,
      requiresUserInteraction: status.requiresUserInteraction,
      interactionReason: status.interactionReason,
      error: status.error
    });

    if (status.state === "completed" && status.receipt) return status.receipt;
    if (status.state === "failed" || status.state === "canceled") {
      throw new Error(
        `Browser download ended in ${status.state}: ${status.error?.code ?? "UNKNOWN"} ${status.error?.message ?? ""}`.trim()
      );
    }
    if (
      ["login_required", "waiting_for_user", "user_interaction_required"].includes(status.state) ||
      status.requiresUserInteraction
    ) {
      const interactionKey = `${status.state}:${status.interactionReason ?? "unknown"}:${status.error?.code ?? ""}`;
      if (interactionKey !== interactionReported) {
        interactionReported = interactionKey;
        report({
          phase: "user_interaction",
          state: status.state,
          reason: status.interactionReason,
          errorCode: status.error?.code ?? null,
          message: "Complete the visible Nexus page interaction; the acceptance runner will retry this session."
        });
      }
      await waitForResumeSignal(deadline);
      shouldStart = true;
    }
  }
  throw new Error("Timed out waiting for the persistent Chromium download to complete.");
}

async function main(): Promise<void> {
  requireLiveOptIn();
  await mkdir(outputDirectory, { recursive: true });
  await writeStatus({ phase: "starting" });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: projectDirectory,
    env: Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    )
  });
  const client = new Client({ name: "nexus-browser-download-acceptance", version: "0.1.0" });
  const deadline = Date.now() + ACCEPTANCE_TIMEOUT_MS;

  try {
    await writeStatus({ phase: "connecting" });
    await client.connect(transport);
    await writeStatus({ phase: "connected" });
    const preparedResult = await client.callTool({
      name: "prepare_download",
      arguments: {
        modUrl: TARGET_MOD_URL,
        fileId: TARGET_FILE_ID,
        backend: "persistent_chromium"
      }
    });
    const prepared = structured(preparedResult).download as unknown as PreparedDownload;
    validatePrepared(prepared);
    await writeStatus({
      phase: "prepared",
      sessionId: prepared.sessionId,
      state: prepared.state,
      file: prepared.file
    });
    report({
      phase: "prepared",
      sessionId: prepared.sessionId,
      fileId: prepared.file.fileId,
      fileName: prepared.file.fileName,
      bytes: prepared.file.sizeInBytes
    });

    const receipt = await startAndWait(client, prepared, deadline);
    validateReceipt(receipt);
    await assertNoTemporaryCredentials(receipt);
    await writeStatus({ phase: "completed", receipt });
    report({
      phase: "completed",
      fileName: receipt.fileName,
      absolutePath: receipt.absolutePath,
      receiptPath: receipt.receiptPath,
      bytes: receipt.bytes,
      sha256: receipt.sha256,
      archiveCheck: receipt.archiveCheck,
      backend: receipt.backend
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Phase 5 acceptance failure.";
    await writeStatus({ phase: "failed", message, failedAt: new Date().toISOString() });
    throw error;
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown Phase 5 acceptance failure.";
  console.error(`PHASE5_ACCEPTANCE_FAILED: ${message}`);
  process.exitCode = 1;
});
