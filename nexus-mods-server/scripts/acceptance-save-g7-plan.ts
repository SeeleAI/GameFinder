import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GAME_ROOT = "E:\\Program Files (x86)\\Ghost of Tsushima DIRECTORS CUT";
const RECEIPT_ID = "597000be-20cf-4243-bd09-90190bf5e9cc";
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type ToolResult = { isError?: boolean; structuredContent?: Record<string, any>; content?: Array<{ type: string; text?: string }> };

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = await client.callTool({ name, arguments: args }) as ToolResult;
  if (result.isError || !result.structuredContent) {
    throw new Error(result.content?.map((item) => item.text ?? "").join("; ") || `${name} failed.`);
  }
  return result.structuredContent;
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectDirectory, "dist", "index.js")],
    cwd: projectDirectory,
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  });
  const client = new Client({ name: "save-g7-got-plan", version: "0.1.0" });
  try {
    await client.connect(transport);
    const install = (await call(client, "probe_save_game_install", {
      gameRoot: GAME_ROOT,
      recipeId: "ghost-of-tsushima-directors-cut-windows",
      resolverHint: "rune-steam-emulator",
    })).installContext;
    const context = (await call(client, "resolve_save_locations", { installContextId: install.installContextId })).saveContext;
    const inspection = (await call(client, "inspect_downloaded_save", { receiptId: RECEIPT_ID })).inspection;
    if (inspection.payloadCandidates?.length !== 1) throw new Error("Expected one GoT payload candidate.");
    const savePackage = (await call(client, "normalize_downloaded_save_package", {
      receiptId: RECEIPT_ID,
      inspectionId: inspection.inspectionId,
      payloadSelectionId: inspection.payloadCandidates[0].payloadSelectionId,
    })).package;
    const adapter = (await call(client, "assess_save_adapter_requirement", {
      saveContextId: context.saveContextId,
      packageId: savePackage.packageId,
      intendedOperation: "replace-whole-unit",
    })).assessment;
    if (adapter.requirement !== "required" || adapter.adapterAvailability !== "matched" || !adapter.replacementPlanAllowed) {
      throw new Error(`GoT Adapter did not authorize its scoped exact replacement: ${adapter.requirement}/${adapter.adapterAvailability}.`);
    }
    const compatibility = (await call(client, "assess_save_package_compatibility", {
      saveContextId: context.saveContextId,
      packageId: savePackage.packageId,
    })).assessment;
    if (compatibility.state !== "compatible_direct" || !compatibility.replacementPlanAllowed) {
      throw new Error(`GoT Compatibility did not authorize planning: ${compatibility.state}.`);
    }
    const planned = await call(client, "plan_save_replacement", {
      assessmentId: compatibility.assessmentId,
      strategy: "direct_replace",
      reviewMode: "auto_safe",
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      acceptance: ["GOT-08-refresh", "GOT-09-refresh", "GOT-10-plan"],
      installContext: { id: install.installContextId, hash: install.contextHash },
      saveContext: { id: context.saveContextId, hash: context.contextHash, root: context.saveRoots[0]?.absolutePath },
      package: { id: savePackage.packageId, hash: savePackage.manifestHash },
      adapter,
      compatibility,
      plan: planned.plan,
      review: planned.review,
      liveSaveChanged: false,
    }, null, 2)}\n`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
