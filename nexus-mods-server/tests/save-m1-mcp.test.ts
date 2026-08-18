import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  NexusBrowserAutomation,
  NexusBrowserStatus,
} from "../src/browser/browser-service.js";
import type { NexusLoginStatus } from "../src/browser/nexus-login-controller.js";
import { NexusClient } from "../src/nexus-client.js";
import {
  createNexusMcpServer,
  type NexusMcpService,
} from "../src/server.js";

const STEAM_ID = "76561198127396738";
const temporaryDirectories: string[] = [];
let service: NexusMcpService | undefined;
let client: Client | undefined;

function unusedBrowser(): NexusBrowserAutomation {
  return {
    status: vi.fn(async (): Promise<NexusBrowserStatus> => ({
      launchMode: "ordinary_chromium_cdp",
      engineInstalled: true,
      profileExists: true,
      profilePathConfigured: true,
      profileBusy: false,
      running: false,
      authState: "unknown",
      authCheckedAt: null,
      requiresUserInteraction: false,
      interactionReason: null,
    })),
    openLogin: vi.fn(async (): Promise<NexusLoginStatus> => ({
      state: "waiting_for_user",
      checkedAt: new Date().toISOString(),
      expiresAt: null,
      requiresUserInteraction: true,
      interactionReason: "login",
    })),
    createDownloadController: vi.fn(async () => {
      throw new Error("Browser is not used by save discovery tests.");
    }),
    close: vi.fn(async () => undefined),
  };
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "save-mcp-"));
  temporaryDirectories.push(root);
  const steamApps = path.join(root, "Steam", "steamapps");
  const gameRoot = path.join(
    steamApps,
    "common",
    "ELDEN RING",
    "Game",
  );
  const appData = path.join(root, "User", "AppData", "Roaming");
  const saveRoot = path.join(appData, "EldenRing", STEAM_ID);
  const managerRoot = path.join(root, "manager");
  await Promise.all([
    mkdir(gameRoot, { recursive: true }),
    mkdir(saveRoot, { recursive: true }),
    mkdir(managerRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(gameRoot, "eldenring.exe"), "fixture"),
    writeFile(path.join(saveRoot, "ER0000.sl2"), "save"),
    writeFile(
      path.join(steamApps, "appmanifest_1245620.acf"),
      `"AppState"
{
  "appid" "1245620"
  "name" "ELDEN RING"
  "installdir" "ELDEN RING"
  "buildid" "22984413"
  "LastOwner" "${STEAM_ID}"
}
`,
    ),
  ]);
  return { root, gameRoot, appData, managerRoot, saveRoot };
}

afterEach(async () => {
  if (client) await client.close();
  if (service) await service.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(
        async (directory) =>
          await rm(directory, { recursive: true, force: true }),
      ),
  );
  client = undefined;
  service = undefined;
});

describe("save M1 MCP", () => {
  it("publishes read-only discovery tools and resolves an Elden Ring fixture", async () => {
    const fixture = await createFixture();
    service = createNexusMcpServer(
      new NexusClient("fake-api-key"),
      unusedBrowser(),
      {
        managerRoot: fixture.managerRoot,
        saveEnvironment: {
          platform: "win32",
          appData: fixture.appData,
          localAppData: path.join(
            path.dirname(fixture.appData),
            "Local",
          ),
          userProfile: path.join(fixture.appData, "..", ".."),
          username: "fixture",
        },
      },
    );
    client = new Client({
      name: "save-m1-mcp-test",
      version: "0.1.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      service.server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "list_game_save_profiles",
        "probe_save_game_install",
        "get_save_game_install_context",
        "resolve_save_locations",
        "get_save_context",
        "begin_save_location_probe",
        "complete_save_location_probe",
      ]),
    );

    const probed = await client.callTool({
      name: "probe_save_game_install",
      arguments: { gameRoot: fixture.gameRoot },
    });
    expect(probed.isError).not.toBe(true);
    const install = (
      probed.structuredContent as {
        installContext: { installContextId: string };
      }
    ).installContext;

    const resolved = await client.callTool({
      name: "resolve_save_locations",
      arguments: { installContextId: install.installContextId },
    });
    expect(resolved.isError).not.toBe(true);
    expect(resolved.structuredContent).toMatchObject({
      ok: true,
      saveContext: {
        saveRoots: [
          {
            absolutePath: fixture.saveRoot,
          },
        ],
        verification: {
          state: "confirmed",
          method: "profile+filesystem",
        },
      },
    });
  });
});
