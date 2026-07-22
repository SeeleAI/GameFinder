import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { NexusClient } from "../src/nexus-client.js";
import { createNexusMcpServer, type NexusMcpService } from "../src/server.js";

let service: NexusMcpService | undefined;
let client: Client | undefined;

afterEach(async () => {
  if (client) await client.close();
  if (service) await service.close();
  client = undefined;
  service = undefined;
});

describe("MCP protocol", () => {
  it("initializes, lists the required tools, and returns structured health", async () => {
    service = createNexusMcpServer(new NexusClient("fake-api-key"));
    client = new Client({ name: "nexus-mods-server-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([service.server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "health_check",
        "validate_credentials",
        "resolve_game",
        "search_mods",
        "get_mod",
        "get_mod_files",
        "get_mod_changelogs",
        "get_mod_requirements",
        "prepare_download",
        "get_download_status",
        "download_mod_file"
      ])
    );
    const health = await client.callTool({ name: "health_check", arguments: {} });
    expect(health.isError).not.toBe(true);
    expect(health.structuredContent).toMatchObject({ ok: true, apiKeyConfigured: true });
  });
});
