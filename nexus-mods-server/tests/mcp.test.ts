import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NexusBrowserAutomation, NexusBrowserStatus } from "../src/browser/browser-service.js";
import type {
  BrowserDownloadStateListener,
  BrowserPageDownloadController
} from "../src/browser/nexus-download-page-controller.js";
import type { NexusLoginStatus } from "../src/browser/nexus-login-controller.js";
import { NexusClient } from "../src/nexus-client.js";
import { createNexusMcpServer, type NexusMcpService } from "../src/server.js";
import type { NexusMod, NexusModFile, QuotaSnapshot } from "../src/types.js";

let service: NexusMcpService | undefined;
let client: Client | undefined;
const temporaryDirectories: string[] = [];

const quota: QuotaSnapshot = {
  dailyLimit: 20_000,
  dailyRemaining: 19_999,
  hourlyLimit: 2_000,
  hourlyRemaining: 1_999
};
const emptyZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
const targetFile: NexusModFile = {
  fileId: 47215,
  name: "ErdGameTools 20260607",
  version: "1.3.1",
  categoryId: 1,
  categoryName: "MAIN",
  fileName: "ErdGameTools.zip",
  sizeKb: 1,
  sizeInBytes: emptyZip.length,
  uploadedAt: "2026-06-07T00:00:00.000Z",
  isPrimary: true,
  description: "",
  contentPreviewLink: null
};
const targetMod: NexusMod = {
  modId: 9531,
  name: "ErdGameTools",
  summary: "Test mod",
  description: "",
  version: "1.3.1",
  author: "fixture",
  uploadedBy: "fixture",
  domainName: "eldenring",
  categoryId: 1,
  containsAdultContent: false,
  status: "published",
  available: true,
  totalDownloads: 1,
  uniqueDownloads: 1,
  endorsements: 1,
  createdAt: "2026-06-07T00:00:00.000Z",
  updatedAt: "2026-06-07T00:00:00.000Z",
  pictureUrl: null,
  canonicalUrl: "https://www.nexusmods.com/eldenring/mods/9531"
};

class McpDownloadClient extends NexusClient {
  override async validateCredentials() {
    return {
      valid: true as const,
      isPremium: false,
      isSupporter: false,
      capabilities: {
        research: true as const,
        downloadWithoutInteractiveNxmAuthorization: false
      },
      quota
    };
  }

  override async getMod(): Promise<{ mod: NexusMod; quota: QuotaSnapshot }> {
    return { mod: targetMod, quota };
  }

  override async getModFiles(): Promise<{ files: NexusModFile[]; quota: QuotaSnapshot }> {
    return { files: [targetFile], quota };
  }
}

function browserWithDownloadFactory(
  factory: (onState?: BrowserDownloadStateListener) => Promise<BrowserPageDownloadController>
): NexusBrowserAutomation {
  return {
    status: vi.fn(async (): Promise<NexusBrowserStatus> => ({
      engineInstalled: true,
      profileExists: true,
      profilePathConfigured: true,
      profileBusy: false,
      running: true,
      authState: "authenticated",
      authCheckedAt: new Date().toISOString(),
      requiresUserInteraction: false,
      interactionReason: null
    })),
    openLogin: vi.fn(async (): Promise<NexusLoginStatus> => ({
      state: "authenticated",
      checkedAt: new Date().toISOString(),
      expiresAt: null,
      requiresUserInteraction: false,
      interactionReason: null
    })),
    createDownloadController: vi.fn(factory),
    close: vi.fn(async () => undefined)
  };
}

afterEach(async () => {
  if (client) await client.close();
  if (service) await service.close();
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true }))
  );
  client = undefined;
  service = undefined;
});

describe("MCP protocol", () => {
  it("initializes, lists the required tools, and returns structured health", async () => {
    const browser: NexusBrowserAutomation = {
      status: vi.fn(async (): Promise<NexusBrowserStatus> => ({
        engineInstalled: true,
        profileExists: true,
        profilePathConfigured: true,
        profileBusy: false,
        running: false,
        authState: "unknown",
        authCheckedAt: null,
        requiresUserInteraction: false,
        interactionReason: null
      })),
      openLogin: vi.fn(async (): Promise<NexusLoginStatus> => ({
        state: "waiting_for_user",
        checkedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        requiresUserInteraction: true,
        interactionReason: "login"
      })),
      createDownloadController: vi.fn(async () => {
        throw new Error("Browser download controller is not used by this MCP smoke test.");
      }),
      close: vi.fn(async () => undefined)
    };
    service = createNexusMcpServer(new NexusClient("fake-api-key"), browser);
    client = new Client({ name: "nexus-mods-server-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([service.server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "health_check",
        "browser_status",
        "open_nexus_login",
        "validate_credentials",
        "resolve_game",
        "search_mods",
        "get_mod",
        "get_mod_files",
        "get_mod_changelogs",
        "get_mod_requirements",
        "prepare_download",
        "get_download_status",
        "start_download",
        "cancel_download",
        "download_mod_file"
      ])
    );
    const health = await client.callTool({ name: "health_check", arguments: {} });
    expect(health.isError).not.toBe(true);
    expect(health.structuredContent).toMatchObject({ ok: true, apiKeyConfigured: true });

    const browserStatus = await client.callTool({ name: "browser_status", arguments: {} });
    expect(browserStatus.structuredContent).toMatchObject({
      ok: true,
      browser: { engineInstalled: true, running: false, authState: "unknown" }
    });

    const login = await client.callTool({
      name: "open_nexus_login",
      arguments: { returnToModUrl: "https://www.nexusmods.com/eldenring/mods/9531?tab=files" }
    });
    expect(login.structuredContent).toMatchObject({
      ok: true,
      login: { state: "waiting_for_user", interactionReason: "login" }
    });
    expect(browser.openLogin).toHaveBeenCalledWith("https://www.nexusmods.com/eldenring/mods/9531");
  });

  it("runs a persistent Chromium download through prepare, start, and status", async () => {
    const browser = browserWithDownloadFactory(async (onState) => ({
      state: "prepared",
      run: async (input) => {
        onState?.("downloading");
        await writeFile(input.saveAsPath, emptyZip);
        return {
          state: "verifying",
          suggestedFilename: "mcp-browser-fixture.zip",
          savedPath: input.saveAsPath,
          sourcePage: "/eldenring/mods/9531"
        };
      },
      cancel: async () => undefined
    }));
    service = createNexusMcpServer(new McpDownloadClient("fake-api-key"), browser);
    client = new Client({ name: "nexus-mods-server-download-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([service.server.connect(serverTransport), client.connect(clientTransport)]);

    const nativePrepared = await client.callTool({
      name: "prepare_download",
      arguments: {
        modUrl: "https://www.nexusmods.com/eldenring/mods/9531",
        fileId: targetFile.fileId
      }
    });
    expect(nativePrepared.isError).not.toBe(true);
    expect(nativePrepared.structuredContent).toMatchObject({
      ok: true,
      download: {
        backend: "native",
        state: "awaiting_authorization",
        capability: { interactiveNxmAuthorizationRequired: true }
      }
    });

    const prepared = await client.callTool({
      name: "prepare_download",
      arguments: {
        modUrl: "https://www.nexusmods.com/eldenring/mods/9531",
        fileId: targetFile.fileId,
        backend: "persistent_chromium"
      }
    });
    expect(prepared.isError).not.toBe(true);
    expect(prepared.structuredContent).toMatchObject({
      ok: true,
      download: {
        backend: "persistent_chromium",
        state: "prepared",
        file: { fileId: targetFile.fileId }
      }
    });
    const sessionId = (
      prepared.structuredContent as { download: { sessionId: string } }
    ).download.sessionId;
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "nexus-mcp-browser-"));
    temporaryDirectories.push(outputDirectory);

    const started = await client.callTool({
      name: "start_download",
      arguments: { sessionId, outputDirectory }
    });
    expect(started.isError).not.toBe(true);
    expect(started.structuredContent).toMatchObject({
      ok: true,
      download: { backend: "persistent_chromium" }
    });

    let completed: Awaited<ReturnType<Client["callTool"]>> | undefined;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      completed = await client.callTool({
        name: "get_download_status",
        arguments: { sessionId }
      });
      if (
        (completed.structuredContent as { download?: { state?: string } } | undefined)?.download?.state ===
        "completed"
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(completed?.structuredContent).toMatchObject({
      ok: true,
      download: {
        state: "completed",
        stagingPath: null,
        receipt: {
          backend: "persistent_chromium",
          fileId: targetFile.fileId,
          bytes: emptyZip.length,
          browser: { engine: "chromium", backend: "playwright" }
        }
      }
    });
  });
});
