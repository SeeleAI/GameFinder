import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLAN_ID = "17610bf0-9dc8-47a4-8f23-b3515faf81bb";
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
type ToolResult = { isError?: boolean; structuredContent?: Record<string, any>; content?: Array<{ type: string; text?: string }> };

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = await client.callTool({ name, arguments: args }) as ToolResult;
  if (result.isError || !result.structuredContent) throw new Error(result.content?.map((item) => item.text ?? "").join("; ") || `${name} failed.`);
  return result.structuredContent;
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectDirectory, "dist", "index.js")], cwd: projectDirectory });
  const client = new Client({ name: "save-g7-got-apply", version: "0.1.0" });
  try {
    await client.connect(transport);
    const applied = await call(client, "apply_save_replacement", { replacementPlanId: PLAN_ID });
    const verified = await call(client, "verify_save_replacement", { recordId: applied.record.recordId });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      acceptance: ["GOT-10-apply", "GOT-10-static-verify"],
      planId: PLAN_ID,
      planHash: applied.plan.planHash,
      record: verified.record,
      rescueBackupId: applied.rescueBackupId,
      idempotentReplay: applied.idempotentReplay,
      staticVerification: verified.record.staticVerification,
      runtimeVerification: "not-run",
      baselineRestorePending: true,
    }, null, 2)}\n`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
