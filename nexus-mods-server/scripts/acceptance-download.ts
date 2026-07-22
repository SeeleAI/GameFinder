import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = path.resolve(projectDirectory, "..");
const serverEntry = path.join(projectDirectory, "dist", "index.js");
const outputDirectory = path.join(
  workspaceDirectory,
  ".codex-work",
  "acceptance-downloads",
  "eldenring",
  "mod-9531"
);
const statusPath = path.join(outputDirectory, "acceptance-status.json");

async function writeStatus(value: Record<string, unknown>): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(statusPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function cleanupAcceptanceParts(): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  const entries = await readdir(outputDirectory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(".") && entry.name.endsWith(".part"))
      .map((entry) => rm(path.join(outputDirectory, entry.name), { force: true }))
  );
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: projectDirectory,
  env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
});
const client = new Client({ name: "nexus-mods-server-download-acceptance", version: "0.1.0" });

interface ToolResponse {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
}

function structured(result: unknown): Record<string, unknown> {
  const response = result as ToolResponse;
  if (response.isError || !response.structuredContent) {
    const text = (response.content ?? [])
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("; ");
    throw new Error(text || "MCP tool failed without a safe error message.");
  }
  return response.structuredContent;
}

try {
  await cleanupAcceptanceParts();
  await client.connect(transport);
  const preparedResult = await client.callTool({
    name: "prepare_download",
    arguments: { modUrl: "https://www.nexusmods.com/eldenring/mods/9531" }
  });
  const prepared = structured(preparedResult).download as {
    sessionId: string;
    state: string;
    authorizationPageUrl: string | null;
    nexusFilesUrl: string;
    file: { fileId: number; fileName: string; sizeInBytes: number | null };
  };
  const preparedStatus = {
      phase: "prepared",
      sessionId: prepared.sessionId,
      state: prepared.state,
      authorizationPageUrl: prepared.authorizationPageUrl,
      nexusFilesUrl: prepared.nexusFilesUrl,
      file: prepared.file,
      outputDirectory
  };
  await writeStatus(preparedStatus);
  process.stdout.write(`${JSON.stringify(preparedStatus)}\n`);

  const deadline = Date.now() + 14 * 60_000;
  let state = prepared.state;
  while (state === "awaiting_authorization" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const statusResult = await client.callTool({
      name: "get_download_status",
      arguments: { sessionId: prepared.sessionId }
    });
    const status = structured(statusResult).download as { state: string };
    state = status.state;
  }
  if (state !== "ready") throw new Error(`Download did not become ready before the authorization deadline; final state: ${state}.`);
  await writeStatus({ phase: "authorized", state, outputDirectory });
  process.stdout.write(`${JSON.stringify({ phase: "authorized", state })}\n`);

  const downloadResult = await client.callTool({
    name: "download_mod_file",
    arguments: { sessionId: prepared.sessionId, outputDirectory }
  }, undefined, { timeout: 30 * 60_000 });
  const receipt = structured(downloadResult).receipt;
  await writeStatus({ phase: "completed", receipt });
  process.stdout.write(`${JSON.stringify({ phase: "completed", receipt })}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Acceptance download failed.";
  const code = message.includes("authorization deadline") ? "authorization_timeout" : "acceptance_failed";
  await writeStatus({ phase: "failed", code, message, outputDirectory, failedAt: new Date().toISOString() });
  throw error;
} finally {
  await client.close();
  await cleanupAcceptanceParts();
}
