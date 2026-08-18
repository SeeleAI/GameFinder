import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPLACEMENT_PLAN_ID = "e393d0a5-a1f8-41cb-b193-73b6e88beda0";
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  if (result.isError || !result.structuredContent) {
    const content = Array.isArray(result.content) ? result.content as Array<{ type: string; text?: string }> : [];
    throw new Error(content.map((item) => item.text ?? "").join("; ") || "M6 apply failed.");
  }
  return result.structuredContent as Record<string, any>;
}

async function main(): Promise<void> {
  if (process.env.SAVE_M6_APPLY !== "1") throw new Error("SAVE_M6_APPLY=1 is required after explicit approval of the exact Replacement Plan.");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectDirectory, "dist", "index.js")],
    cwd: projectDirectory,
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  });
  const client = new Client({ name: "save-m6-replacement-apply", version: "0.1.0" });
  try {
    await client.connect(transport);
    const applied = structured(await client.callTool({ name: "apply_save_replacement", arguments: { replacementPlanId: REPLACEMENT_PLAN_ID } }));
    const recordId = applied.record?.recordId;
    if (!recordId) throw new Error("M6 apply returned no operation record.");
    const verified = structured(await client.callTool({ name: "verify_save_replacement", arguments: { recordId } }));
    process.stdout.write(`${JSON.stringify({ ok: true, replacementPlanId: REPLACEMENT_PLAN_ID, applied, verified }, null, 2)}\n`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
