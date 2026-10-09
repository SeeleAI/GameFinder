import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NexusBrowserAutomation, NexusBrowserStatus } from "../src/browser/browser-service.js";
import type { BrowserPageDownloadController } from "../src/browser/nexus-download-page-controller.js";
import type { NexusLoginStatus } from "../src/browser/nexus-login-controller.js";
import type { BrowserDownloadStatus } from "../src/browser-download-manager.js";
import { NexusError } from "../src/errors.js";
import { NexusClient } from "../src/nexus-client.js";
import { SaveService } from "../src/save/save-service.js";
import { createNexusMcpServer, type NexusMcpService } from "../src/server.js";
import type { NexusMod, NexusModFile } from "../src/types.js";

const modUrl = "https://www.nexusmods.com/unregistered-save-fixture/mods/123";
const archive = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
const quota = { dailyLimit: 100, dailyRemaining: 99, hourlyLimit: 10, hourlyRemaining: 9 };
const file: NexusModFile = {
  fileId: 456, name: "Complete save", version: "1", categoryId: 1, categoryName: "MAIN",
  fileName: "complete-save.zip", sizeKb: 1, sizeInBytes: archive.length,
  uploadedAt: "2026-10-08T00:00:00.000Z", isPrimary: true, description: "Fixture save",
  contentPreviewLink: null
};
const mod: NexusMod = {
  modId: 123, name: "Complete save", summary: "Fixture", description: "Fixture", version: "1",
  author: "fixture", uploadedBy: "fixture", domainName: "unregistered-save-fixture", categoryId: 1,
  containsAdultContent: false, status: "published", available: true, totalDownloads: 1,
  uniqueDownloads: 1, endorsements: 1, createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z", pictureUrl: null, canonicalUrl: modUrl
};

class FixtureNexusClient extends NexusClient {
  override async getMod() { return { mod, quota }; }
  override async getModFiles() { return { files: [file], quota }; }
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
let client: Client | undefined;
let service: NexusMcpService | undefined;
const directories: string[] = [];

function text(result: ToolResult): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
}

async function connect(browser: NexusBrowserAutomation): Promise<Client> {
  service = createNexusMcpServer(new FixtureNexusClient("fixture-key"), browser);
  client = new Client({ name: "generic-save-download-contract", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await Promise.all([service.server.connect(remote), client.connect(local)]);
  return client;
}

async function waitForState(mcp: Client, sessionId: string, state: string): Promise<ToolResult> {
  const deadline = Date.now() + 3_000;
  do {
    const result = await mcp.callTool({ name: "get_download_status", arguments: { sessionId } });
    expect(result.isError).not.toBe(true);
    const status = (result.structuredContent as { download: BrowserDownloadStatus }).download;
    expect(status.sessionId).toBe(sessionId);
    expect(text(result)).toContain(sessionId);
    if (status.state === state) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error(`Download did not reach ${state}.`);
}

function browserFixture(requireLogin: boolean): NexusBrowserAutomation {
  let loggedIn = !requireLogin;
  return {
    status: vi.fn(async (): Promise<NexusBrowserStatus> => ({
      launchMode: "ordinary_chromium_cdp", engineInstalled: true, profileExists: true,
      profilePathConfigured: true, profileBusy: false, running: true,
      authState: loggedIn ? "authenticated" : "login_required",
      authCheckedAt: null, requiresUserInteraction: !loggedIn, interactionReason: loggedIn ? null : "login"
    })),
    openLogin: vi.fn(async (): Promise<NexusLoginStatus> => {
      loggedIn = true;
      return { state: "authenticated", checkedAt: new Date().toISOString(), expiresAt: null,
        requiresUserInteraction: false, interactionReason: null };
    }),
    createDownloadController: vi.fn(async (_identity, onState): Promise<BrowserPageDownloadController> => ({
      state: "prepared",
      run: async (input) => {
        if (!loggedIn) throw new NexusError("LOGIN_REQUIRED", "Log in to Nexus.", { retryable: true });
        onState?.("downloading");
        await writeFile(input.saveAsPath, archive);
        return { state: "verifying", suggestedFilename: file.fileName,
          savedPath: input.saveAsPath, sourcePage: "/unregistered-save-fixture/mods/123" };
      },
      cancel: async () => undefined
    })),
    close: vi.fn(async () => undefined)
  };
}

afterEach(async () => {
  if (client) await client.close();
  if (service) await service.close();
  client = undefined;
  service = undefined;
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Recipe-free save download MCP contract", () => {
  it("prepares an unknown game and resumes the original session after explicit login", async () => {
    const saveCreation = vi.spyOn(SaveService, "create");
    const browser = browserFixture(true);
    const mcp = await connect(browser);
    const prepared = await mcp.callTool({ name: "prepare_download",
      arguments: { modUrl, fileId: file.fileId, backend: "persistent_chromium" } });
    expect(prepared.isError).not.toBe(true);
    const download = (prepared.structuredContent as { download: BrowserDownloadStatus }).download;
    const sessionId = download.sessionId;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(text(prepared).match(/^sessionId: (.+)$/m)?.[1]).toBe(sessionId);
    expect(download).toMatchObject({ state: "prepared", mod: { canonicalUrl: modUrl }, file: { fileId: 456 } });
    expect(browser.createDownloadController).not.toHaveBeenCalled();
    expect(browser.openLogin).not.toHaveBeenCalled();
    expect(saveCreation).not.toHaveBeenCalled();

    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "generic-save-download-"));
    directories.push(outputDirectory);
    const started = await mcp.callTool({ name: "start_download", arguments: { sessionId, outputDirectory } });
    expect(started.isError).not.toBe(true);
    const blocked = await waitForState(mcp, sessionId, "login_required");
    expect(blocked.structuredContent).toMatchObject({ download: {
      sessionId, outputDirectory, requiresUserInteraction: true, interactionReason: "login"
    } });
    // Status polling must be observational, with no implicit login/profile workflow.
    for (let index = 0; index < 3; index++) await waitForState(mcp, sessionId, "login_required");
    expect(browser.openLogin).not.toHaveBeenCalled();
    expect(browser.createDownloadController).toHaveBeenCalledTimes(1);

    const login = await mcp.callTool({ name: "open_nexus_login", arguments: { returnToModUrl: modUrl } });
    expect(login.isError).not.toBe(true);
    const resumed = await mcp.callTool({ name: "start_download", arguments: { sessionId, outputDirectory } });
    expect(resumed.isError).not.toBe(true);
    const completed = await waitForState(mcp, sessionId, "completed");
    const status = (completed.structuredContent as { download: BrowserDownloadStatus }).download;
    expect(status).toMatchObject({ sessionId, outputDirectory, requiresUserInteraction: false,
      receipt: { canonicalModUrl: modUrl, fileId: file.fileId, bytes: archive.length } });
    expect(await readFile(status.finalPath!)).toEqual(archive);
    expect(browser.openLogin).toHaveBeenCalledTimes(1);
    expect(browser.createDownloadController).toHaveBeenCalledTimes(2);
    expect(saveCreation).not.toHaveBeenCalled();

    // A complete serialized MCP result retains both representations, including the stable ID.
    const retained = JSON.parse(JSON.stringify([prepared, started, blocked, login, resumed, completed])) as ToolResult[];
    expect(retained[0]?.structuredContent).toEqual(prepared.structuredContent);
    expect(text(retained[0]!)).toContain(sessionId);
  });

  it("rejects absent, malformed and unknown session IDs without creating a browser workflow", async () => {
    const browser = browserFixture(false);
    const mcp = await connect(browser);
    for (const sessionId of [undefined, "not-a-session-id", randomUUID()]) {
      const result = await mcp.callTool({ name: "start_download", arguments: {
        ...(sessionId === undefined ? {} : { sessionId }), outputDirectory: os.tmpdir()
      } });
      expect(result.isError).toBe(true);
    }
    const unknown = await mcp.callTool({ name: "get_download_status", arguments: { sessionId: randomUUID() } });
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(browser.createDownloadController).not.toHaveBeenCalled();
    expect(browser.openLogin).not.toHaveBeenCalled();
  });
});
