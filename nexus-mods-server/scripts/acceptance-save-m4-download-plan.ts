import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(projectDirectory, "dist", "index.js");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: projectDirectory,
  env: Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ),
});
const client = new Client({ name: "save-m4-download-plan", version: "0.1.0" });

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: "plan_mod_download",
    arguments: {
      modUrl: "https://www.nexusmods.com/eldenring/mods/6732",
      rootFileId: 46818,
      authorizationScope: "root_only",
    },
  });
  if (result.isError || !result.structuredContent) {
    const content = Array.isArray(result.content)
      ? result.content as Array<{ type: string; text?: string }>
      : [];
    throw new Error(content.map((item) => item.type === "text" ? item.text ?? "" : "").join("; "));
  }
  process.stdout.write(`${JSON.stringify(result.structuredContent, null, 2)}\n`);
} finally {
  await client.close();
}
