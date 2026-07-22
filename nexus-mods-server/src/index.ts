#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createNexusMcpServer } from "./server.js";

async function main(): Promise<void> {
  const service = createNexusMcpServer();
  const transport = new StdioServerTransport();
  await service.server.connect(transport);

  const shutdown = (): void => {
    void service.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown server error";
  console.error(`nexus-mods-server failed: ${message}`);
  process.exitCode = 1;
});
