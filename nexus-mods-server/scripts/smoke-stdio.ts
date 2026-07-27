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
  env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
});
const client = new Client({ name: "nexus-mods-server-stdio-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const required = [
    "health_check",
    "browser_status",
    "open_nexus_login",
    "resolve_game",
    "search_mods",
    "get_mod",
    "get_mod_files",
    "get_mod_requirements",
    "resolve_mod_dependencies",
    "plan_mod_download",
    "create_mod_bundle",
    "inspect_mod_bundle",
    "prepare_download",
    "get_download_status",
    "start_download",
    "cancel_download",
    "download_mod_file",
    "list_game_profiles",
    "detect_game_installs",
    "probe_game_install",
    "inspect_mod_archive",
    "match_install_adapters",
    "plan_mod_install",
    "apply_mod_install",
    "get_install_status",
    "verify_mod_install",
    "rollback_mod_install"
  ];
  const available = new Set(tools.tools.map((tool) => tool.name));
  const missing = required.filter((name) => !available.has(name));
  if (missing.length > 0) throw new Error(`Missing MCP tools: ${missing.join(", ")}`);

  const health = await client.callTool({ name: "health_check", arguments: {} });
  if (health.isError) throw new Error("health_check failed");
  const browser = await client.callTool({ name: "browser_status", arguments: {} });
  if (browser.isError) throw new Error("browser_status failed");

  let browserLaunched = false;
  if (process.env.NEXUS_BROWSER_STDIO_LAUNCH_TEST === "1") {
    const login = await client.callTool({ name: "open_nexus_login", arguments: {} });
    if (login.isError) throw new Error("open_nexus_login STDIO launch smoke failed");
    browserLaunched = true;
  }

  let liveValidated = false;
  if (process.env.NEXUS_API_KEY) {
    const validation = await client.callTool({ name: "validate_credentials", arguments: {} });
    if (validation.isError) throw new Error("validate_credentials failed");
    const mod = await client.callTool({
      name: "get_mod",
      arguments: { modUrl: "https://www.nexusmods.com/eldenring/mods/9531" }
    });
    if (mod.isError) throw new Error("get_mod acceptance smoke failed");
    liveValidated = true;
  }

  process.stdout.write(
    `${JSON.stringify({ ok: true, toolCount: tools.tools.length, liveValidated, browserLaunched })}\n`
  );
} finally {
  await client.close();
}
