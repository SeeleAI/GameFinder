import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLAN_ID = "f798a51f-f2e4-4ed2-a694-2856617165ba";
const CANDIDATE_ID = "48734317-89f7-492f-926a-834059df3ed2";
const MOD_URL = "https://www.nexusmods.com/eldenring/mods/6732";
const MOD_ID = 6732;
const FILE_ID = 46818;
const EXPECTED_BYTES = 3_408_823;
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(projectDirectory, "dist", "index.js");
const outputDirectory = path.resolve(projectDirectory, "..", ".codex-work", "acceptance-save-m4", "elden-ring", "mod-6732");
const resumeSignalPath = path.join(outputDirectory, "resume-after-nexus-login.flag");

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content?: Array<{type: string; text?: string}> };

function data(result: unknown): Record<string, any> {
  const value = result as ToolResult;
  if (value.isError || !value.structuredContent) {
    throw new Error((value.content ?? []).map((item) => item.text ?? "").join("; ") || "MCP tool failed.");
  }
  return value.structuredContent as Record<string, any>;
}

function report(phase: string, value: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), phase, ...value })}\n`);
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  return data(await client.callTool({ name, arguments: args }));
}

async function main(): Promise<void> {
  if (process.env.NEXUS_LIVE_TEST !== "1") throw new Error("NEXUS_LIVE_TEST=1 is required for the approved live download.");
  await mkdir(outputDirectory, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: projectDirectory,
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  });
  const client = new Client({ name: "save-m4-approved-download", version: "0.1.0" });
  try {
    await client.connect(transport);
    const prepared = (await call(client, "prepare_nexus_save_download", {
      candidateId: CANDIDATE_ID,
      backend: "persistent_chromium"
    })).download;
    if (prepared.backend !== "persistent_chromium" || prepared.file?.fileId !== FILE_ID || prepared.file?.sizeInBytes !== EXPECTED_BYTES) {
      throw new Error("Prepared download does not match the approved immutable file selection.");
    }
    report("prepared", { sessionId: prepared.sessionId, file: prepared.file });
    await call(client, "start_download", { sessionId: prepared.sessionId, outputDirectory });
    const deadline = Date.now() + 30 * 60_000;
    let receipt: Record<string, any> | undefined;
    let lastState = "";
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const status = (await call(client, "get_download_status", { sessionId: prepared.sessionId })).download;
      if (status.state !== lastState) {
        lastState = status.state;
        report("download_status", { state: status.state, requiresUserInteraction: status.requiresUserInteraction, interactionReason: status.interactionReason });
      }
      if (status.state === "completed") { receipt = status.receipt; break; }
      if (["failed", "canceled"].includes(status.state)) throw new Error(`Download ${status.state}: ${status.error?.code ?? "UNKNOWN"} ${status.error?.message ?? ""}`);
      if (status.requiresUserInteraction || ["login_required", "waiting_for_user", "user_interaction_required"].includes(status.state)) {
        await rm(resumeSignalPath, { force: true });
        report("waiting_for_user", {
          reason: status.interactionReason ?? status.state,
          resumeSignalPath,
          message: "Complete the visible Nexus interaction, then create the resume signal file."
        });
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          try { await access(resumeSignalPath); break; } catch { /* keep the browser session alive */ }
        }
        await rm(resumeSignalPath, { force: true });
        await call(client, "start_download", { sessionId: prepared.sessionId, outputDirectory });
        lastState = "";
      }
    }
    if (!receipt) throw new Error("Timed out waiting for the approved download.");
    if (receipt.canonicalModUrl !== MOD_URL || receipt.modId !== MOD_ID || receipt.fileId !== FILE_ID || receipt.bytes !== EXPECTED_BYTES) {
      throw new Error("Completed receipt identity or byte count differs from the approved Plan.");
    }
    if (receipt.archiveCheck?.valid === false) throw new Error(`Archive verification failed: ${receipt.archiveCheck.detail}`);
    report("download_completed", { absolutePath: receipt.absolutePath, receiptPath: receipt.receiptPath, sha256: receipt.sha256, bytes: receipt.bytes });

    const bundle = (await call(client, "create_mod_bundle", {
      downloadPlanId: PLAN_ID,
      receiptPaths: [receipt.receiptPath],
      outputDirectory
    })).bundle;
    report("bundle_created", { bundleId: bundle.bundleId, bundlePath: bundle.manifestPath ?? bundle.bundlePath, state: bundle.state });

    const saveReceipt = (await call(client, "record_nexus_save_download", {
      candidateId: CANDIDATE_ID,
      nexusReceiptPath: receipt.receiptPath
    })).receipt;
    report("save_receipt_recorded", { receiptId: saveReceipt.receiptId, receiptPath: saveReceipt.receiptPath });

    const inspection = (await call(client, "inspect_downloaded_save", { receiptId: saveReceipt.receiptId })).inspection;
    report("save_inspected", { inspectionId: inspection.inspectionId, payloadCandidates: inspection.payloadCandidates });
    if (inspection.payloadCandidates?.length !== 1) {
      throw new Error(`Expected exactly one safe payload candidate, found ${inspection.payloadCandidates?.length ?? 0}.`);
    }
    const savePackage = (await call(client, "normalize_downloaded_save_package", {
      receiptId: saveReceipt.receiptId,
      inspectionId: inspection.inspectionId,
      payloadSelectionId: inspection.payloadCandidates[0].payloadSelectionId
    })).package;
    report("standard_package_created", {
      packageId: savePackage.packageId,
      manifestPath: savePackage.manifestPath,
      packagePath: savePackage.packagePath,
      contentHash: savePackage.contentHash
    });
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
