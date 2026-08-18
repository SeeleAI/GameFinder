import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256File } from "../src/install/file-hash.js";

const PACKAGE_ID = "savepkg-9cca21c6c22701505e7b02c8169b9a394d5ec92652d46a5460e52c4f2101ebf4";
const SAVE_CONTEXT_ID = "2e2bc97b-8f70-41a4-8288-f8507b52ec72";
const SAVE_ROOT = "C:\\Users\\64617\\AppData\\Roaming\\EldenRing\\76561198127396738";
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  if (result.isError || !result.structuredContent) {
    const content = Array.isArray(result.content) ? result.content as Array<{ type: string; text?: string }> : [];
    throw new Error(content.map((item) => item.text ?? "").join("; ") || "MCP call failed.");
  }
  return result.structuredContent as Record<string, any>;
}

async function main(): Promise<void> {
  const files = ["ER0000.sl2", "ER0000.sl2.bak", "steam_autocloud.vdf"];
  const before = Object.fromEntries(await Promise.all(files.map(async (name) => [name, await sha256File(path.join(SAVE_ROOT, name))])));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectDirectory, "dist", "index.js")],
    cwd: projectDirectory,
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  });
  const client = new Client({ name: "save-m5-acceptance", version: "0.1.0" });
  try {
    await client.connect(transport);
    const source = structured(await client.callTool({ name: "analyze_elden_ring_package", arguments: { packageId: PACKAGE_ID } })).analysis;
    const target = structured(await client.callTool({ name: "analyze_elden_ring_save_context", arguments: { saveContextId: SAVE_CONTEXT_ID } })).analysis;
    const plan = structured(await client.callTool({ name: "plan_elden_ring_slot_import", arguments: { packageId: PACKAGE_ID, saveContextId: SAVE_CONTEXT_ID } })).plan;
    const staged = structured(await client.callTool({ name: "stage_elden_ring_slot_import", arguments: { slotImportPlanId: plan.slotImportPlanId } })).stagedImport;
    structured(await client.callTool({ name: "verify_elden_ring_staged_import", arguments: { stagedImportId: staged.stagedImportId } }));
    const after = Object.fromEntries(await Promise.all(files.map(async (name) => [name, await sha256File(path.join(SAVE_ROOT, name))])));
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("M5 staging changed the live Save Unit.");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      source: { analysisId: source.analysisId, steamId64: source.steamId64, activeSlots: source.slots.filter((slot: any) => slot.active) },
      target: { analysisId: target.analysisId, steamId64: target.steamId64, activeSlots: target.slots.filter((slot: any) => slot.active) },
      plan,
      staged,
      liveSaveUnitHashes: after,
    }, null, 2)}\n`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
