import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STAGED_IMPORT_ID = "09a9ae8c-576d-4b22-b769-a6b13de7cf33";
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectDirectory, "dist", "index.js")],
  cwd: projectDirectory,
  env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
});
const client = new Client({ name: "save-m6-replacement-plan", version: "0.1.0" });

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: "plan_elden_ring_staged_replacement",
    arguments: { stagedImportId: STAGED_IMPORT_ID },
  });
  if (result.isError || !result.structuredContent) {
    const content = Array.isArray(result.content) ? result.content as Array<{ type: string; text?: string }> : [];
    throw new Error(content.map((item) => item.text ?? "").join("; ") || "M6 plan failed.");
  }
  process.stdout.write(`${JSON.stringify(result.structuredContent, null, 2)}\n`);
} finally {
  await client.close();
}
