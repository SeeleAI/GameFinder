import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CANDIDATE_ID = "c215dd7a-bb95-4552-9c21-7c554790e282";
const MOD_ID = 834;
const FILE_ID = 2617;
const EXPECTED_BYTES = 2_153_536;
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.resolve(projectDirectory, "..", ".codex-work", "acceptance-save-g5", "got-mod-834");

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content?: Array<{ type: string; text?: string }> };

function data(result: unknown): Record<string, any> {
  const value = result as ToolResult;
  if (value.isError || !value.structuredContent) {
    throw new Error((value.content ?? []).map((item) => item.text ?? "").join("; ") || "MCP tool failed.");
  }
  return value.structuredContent as Record<string, any>;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  return data(await client.callTool({ name, arguments: args }));
}

function report(phase: string, value: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), phase, ...value })}\n`);
}

async function main(): Promise<void> {
  if (process.env.NEXUS_LIVE_TEST !== "1") throw new Error("NEXUS_LIVE_TEST=1 is required.");
  await mkdir(outputDirectory, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectDirectory, "dist", "index.js")],
    cwd: projectDirectory,
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  });
  const client = new Client({ name: "save-g5-got-download", version: "0.1.0" });
  try {
    await client.connect(transport);
    const prepared = (await call(client, "prepare_nexus_save_download", {
      candidateId: CANDIDATE_ID,
      backend: "persistent_chromium",
    })).download;
    if (prepared.file?.fileId !== FILE_ID || prepared.file?.sizeInBytes !== EXPECTED_BYTES) {
      throw new Error("Prepared Nexus file identity drifted from the researched candidate.");
    }
    report("prepared", { sessionId: prepared.sessionId, modId: MOD_ID, fileId: FILE_ID });
    await call(client, "start_download", { sessionId: prepared.sessionId, outputDirectory });
    const deadline = Date.now() + 30 * 60_000;
    let loginOpened = false;
    let receipt: Record<string, any> | null = null;
    let lastState = "";
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const status = (await call(client, "get_download_status", { sessionId: prepared.sessionId })).download;
      if (status.state !== lastState) {
        lastState = status.state;
        report("download_status", { state: status.state, interactionReason: status.interactionReason ?? null });
      }
      if (status.state === "completed") { receipt = status.receipt; break; }
      if (["failed", "canceled"].includes(status.state)) throw new Error(`Download ${status.state}: ${status.error?.message ?? "unknown error"}`);
      if (status.requiresUserInteraction || ["login_required", "waiting_for_user", "user_interaction_required"].includes(status.state)) {
        if (!loginOpened) {
          await call(client, "open_nexus_login");
          loginOpened = true;
          report("login_window_opened", { message: "Complete Nexus login in the single persistent Chromium window." });
        }
        const browser = await call(client, "browser_status");
        if (browser.browser?.authenticated === true || browser.authenticated === true) {
          await call(client, "start_download", { sessionId: prepared.sessionId, outputDirectory });
          lastState = "";
        }
      }
    }
    if (!receipt) throw new Error("Timed out waiting for Nexus download.");
    if (receipt.modId !== MOD_ID || receipt.fileId !== FILE_ID || receipt.bytes !== EXPECTED_BYTES) throw new Error("Downloaded receipt identity drifted.");
    report("download_completed", { absolutePath: receipt.absolutePath, receiptPath: receipt.receiptPath, sha256: receipt.sha256 });
    const saveReceipt = (await call(client, "record_nexus_save_download", {
      candidateId: CANDIDATE_ID,
      nexusReceiptPath: receipt.receiptPath,
    })).receipt;
    const inspection = (await call(client, "inspect_downloaded_save", { receiptId: saveReceipt.receiptId })).inspection;
    report("save_inspected", { receiptId: saveReceipt.receiptId, inspectionId: inspection.inspectionId, payloadCandidates: inspection.payloadCandidates });
    if (inspection.payloadCandidates?.length !== 1) throw new Error(`Expected one payload candidate, found ${inspection.payloadCandidates?.length ?? 0}.`);
    const savePackage = (await call(client, "normalize_downloaded_save_package", {
      receiptId: saveReceipt.receiptId,
      inspectionId: inspection.inspectionId,
      payloadSelectionId: inspection.payloadCandidates[0].payloadSelectionId,
    })).package;
    report("package_created", { package: savePackage });
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
