import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ZipFile } from "yazl";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  NexusBrowserAutomation,
  NexusBrowserStatus,
} from "../src/browser/browser-service.js";
import type { NexusLoginStatus } from "../src/browser/nexus-login-controller.js";
import type { DownloadReceipt } from "../src/download-verifier.js";
import { sha256File } from "../src/install/file-hash.js";
import { NexusClient } from "../src/nexus-client.js";
import {
  createNexusMcpServer,
  type NexusMcpService,
} from "../src/server.js";

const temporaryDirectories: string[] = [];
let service: NexusMcpService | undefined;
let client: Client | undefined;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeZip(
  zipPath: string,
  entries: ReadonlyArray<{ path: string; content: string }>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const archive = new ZipFile();
    const output = createWriteStream(zipPath, { flags: "wx" });
    output.on("close", resolve);
    output.on("error", reject);
    archive.outputStream.on("error", reject);
    archive.outputStream.pipe(output);
    for (const entry of entries) {
      archive.addBuffer(Buffer.from(entry.content), entry.path);
    }
    archive.end();
  });
}

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
      throw new Error("Browser download is not used by installation tests.");
    }),
    close: vi.fn(async () => undefined),
  };
}

async function createInstallFixture(): Promise<{
  archivePath: string;
  receiptPath: string;
  gameRoot: string;
  managerRoot: string;
}> {
  const downloadsRoot = await temporaryDirectory("install-mcp-download-");
  const gameRoot = await temporaryDirectory("install-mcp-game-");
  const managerRoot = await temporaryDirectory("install-mcp-manager-");
  const archivePath = path.join(downloadsRoot, "SkipFishingMinigame.zip");
  const receiptPath = `${archivePath}.nexus-receipt.json`;
  await writeZip(archivePath, [
    {
      path: "SkipFishingMinigame/manifest.json",
      content: JSON.stringify({
        Name: "Skip Fishing Minigame",
        Author: "DewMods",
        Version: "0.7.4",
        UniqueID: "DewMods.SkipFishingMinigame",
        EntryDll: "SkipFishingMinigame.dll",
        MinimumApiVersion: "3.0.0",
      }),
    },
    {
      path: "SkipFishingMinigame/SkipFishingMinigame.dll",
      content: "fixture-dll",
    },
  ]);
  const archiveInfo = await stat(archivePath);
  const receipt: DownloadReceipt = {
    schemaVersion: 1,
    backend: "persistent_chromium",
    canonicalModUrl: "https://www.nexusmods.com/stardewvalley/mods/2697",
    domainName: "stardewvalley",
    modId: 2697,
    fileId: 115145,
    fileName: path.basename(archivePath),
    bytes: archiveInfo.size,
    sha256: await sha256File(archivePath),
    completedAt: new Date().toISOString(),
    absolutePath: archivePath,
    targetPath: archivePath,
    receiptPath,
    archiveValid: true,
    archiveCheck: {
      format: "zip",
      valid: true,
      detail: "Fixture ZIP central directory is readable.",
    },
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  await writeFile(path.join(gameRoot, "Stardew Valley.exe"), "");
  await writeFile(path.join(gameRoot, "StardewModdingAPI.exe"), "");
  await mkdir(path.join(gameRoot, "Content"));
  await mkdir(path.join(gameRoot, "Mods"));
  return { archivePath, receiptPath, gameRoot, managerRoot };
}

afterEach(async () => {
  if (client) await client.close();
  if (service) await service.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  client = undefined;
  service = undefined;
});

describe("Phase 6B-4 installation MCP", () => {
  it("publishes bounded installation tools and applies only by planId", async () => {
    const fixture = await createInstallFixture();
    service = createNexusMcpServer(
      new NexusClient("fake-api-key"),
      unusedBrowser(),
      { managerRoot: fixture.managerRoot },
    );
    client = new Client({
      name: "install-mcp-test",
      version: "0.1.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      service.server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "probe_game_context",
        "get_game_context",
        "prepare_install_evidence",
        "get_install_evidence",
        "query_install_methods",
        "submit_install_proposal",
        "get_install_proposal",
        "freeze_install_plan",
        "get_agentic_install_plan",
        "apply_agentic_install_plan",
        "list_game_profiles",
        "detect_game_installs",
        "probe_game_install",
        "inspect_mod_archive",
        "match_install_adapters",
        "plan_mod_install",
        "apply_mod_install",
        "get_install_status",
        "verify_mod_install",
        "rollback_mod_install",
      ]),
    );
    const applyTool = listed.tools.find(
      (tool) => tool.name === "apply_mod_install",
    );
    expect(applyTool?.inputSchema).toMatchObject({
      type: "object",
      properties: { planId: expect.any(Object) },
      required: ["planId"],
    });
    expect(Object.keys(applyTool?.inputSchema.properties ?? {})).toEqual([
      "planId",
    ]);
    const agenticApplyTool = listed.tools.find(
      (tool) => tool.name === "apply_agentic_install_plan",
    );
    expect(agenticApplyTool?.inputSchema).toMatchObject({
      type: "object",
      properties: { planId: expect.any(Object) },
      required: ["planId"],
    });
    expect(
      Object.keys(agenticApplyTool?.inputSchema.properties ?? {}),
    ).toEqual(["planId"]);

    const inspected = await client.callTool({
      name: "inspect_mod_archive",
      arguments: {
        archivePath: fixture.archivePath,
        receiptPath: fixture.receiptPath,
      },
    });
    expect(inspected.isError).not.toBe(true);
    expect(inspected.structuredContent).toMatchObject({
      ok: true,
      source: { modId: 2697, fileId: 115145 },
      analysis: {
        packages: [
          {
            identity: { uniqueId: "DewMods.SkipFishingMinigame" },
          },
        ],
      },
    });

    const planned = await client.callTool({
      name: "plan_mod_install",
      arguments: {
        archivePath: fixture.archivePath,
        receiptPath: fixture.receiptPath,
        profileId: "stardew-valley",
        gameRoot: fixture.gameRoot,
      },
    });
    expect(planned.isError).not.toBe(true);
    expect(planned.structuredContent).toMatchObject({
      ok: true,
      plan: {
        requiresExplicitApplyConfirmation: true,
        operations: [
          {
            kind: "install_tree",
            targetRelativePath: "Mods/SkipFishingMinigame",
          },
        ],
      },
    });
    expect(
      await stat(
        path.join(fixture.gameRoot, "Mods", "SkipFishingMinigame"),
      ).catch(() => null),
    ).toBeNull();
    const planId = (
      planned.structuredContent as { plan: { planId: string } }
    ).plan.planId;

    const applied = await client.callTool({
      name: "apply_mod_install",
      arguments: { planId },
    });
    expect(applied.isError).not.toBe(true);
    expect(applied.structuredContent).toMatchObject({
      ok: true,
      installation: {
        state: "runtime_unverified",
        sourcePlanId: planId,
        staticVerification: { state: "passed" },
        runtimeVerification: "not-run",
      },
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(
            fixture.gameRoot,
            "Mods",
            "SkipFishingMinigame",
            "manifest.json",
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({
      UniqueID: "DewMods.SkipFishingMinigame",
    });
    const installationId = (
      applied.structuredContent as {
        installation: { installationId: string };
      }
    ).installation.installationId;

    const verified = await client.callTool({
      name: "verify_mod_install",
      arguments: { installationId },
    });
    expect(verified.structuredContent).toMatchObject({
      ok: true,
      passed: true,
      staticVerification: { state: "passed" },
      runtimeVerification: { state: "not-run" },
    });
  });

  it("runs the Agentic V2 file workflow through MCP without a profile or Adapter match", async () => {
    const fixture = await createInstallFixture();
    service = createNexusMcpServer(
      new NexusClient("fake-api-key"),
      unusedBrowser(),
      { managerRoot: fixture.managerRoot },
    );
    client = new Client({ name: "install-v2-mcp-test", version: "0.1.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      service.server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const probed = await client.callTool({
      name: "probe_game_context",
      arguments: {
        gameRoot: fixture.gameRoot,
        gameId: "unregistered-test-game",
        gameName: "Unregistered Test Game",
        nexusDomainName: "unregistered-test-game",
        operatingSystem: "win32",
        anchorPaths: ["Stardew Valley.exe"],
        writableRoots: ["Mods"],
        protectedRoots: ["Content"],
        liveModRoots: ["Mods"],
      },
    });
    expect(probed.isError).not.toBe(true);
    const gameContextId = (
      probed.structuredContent as { context: { gameContextId: string } }
    ).context.gameContextId;

    const prepared = await client.callTool({
      name: "prepare_install_evidence",
      arguments: {
        archivePath: fixture.archivePath,
        receiptPath: fixture.receiptPath,
        gameContextId,
      },
    });
    expect(prepared.isError).not.toBe(true);
    const preparedContent = prepared.structuredContent as {
      evidence: {
        evidencePackId: string;
        packageUnits: Array<{
          packageUnitId: string;
          packageRoot: string;
        }>;
      };
    };
    const evidencePackId = preparedContent.evidence.evidencePackId;
    const packageUnit = preparedContent.evidence.packageUnits[0];
    if (!packageUnit) throw new Error("Expected one package unit.");

    const queried = await client.callTool({
      name: "query_install_methods",
      arguments: { evidencePackId, gameContextId },
    });
    expect(queried.structuredContent).toMatchObject({
      ok: true,
      candidates: [],
      requiresAgentResearch: true,
      operationCapabilities: {
        installTree: { state: "available", executableIn: "M2" },
        runBundledInstaller: {
          state: "available",
          executableIn: "M3",
        },
      },
      proposalReadiness: {
        packageUnitCount: 1,
        canSubmitFileProposal: true,
        canSubmitInstallerProposal: false,
        recommendedAction: "construct_agent_file_proposal",
        blockers: [],
      },
      contextAdvisories: [],
    });

    const proposed = await client.callTool({
      name: "submit_install_proposal",
      arguments: {
        evidencePackId,
        gameContextId,
        draft: {
          strategyBinding: {
            origin: "agent_proposal",
            methodId: null,
            methodRevision: null,
            methodHash: null,
            legacyAdapterBinding: null,
          },
          selection: {
            packageUnitId: packageUnit.packageUnitId,
            packageRoot: packageUnit.packageRoot,
            selectedComponents: [],
          },
          operations: [
            {
              operationId: randomUUID(),
              kind: "install_tree",
              sourceRelativePath: packageUnit.packageRoot,
              targetRelativePath: "Mods/SkipFishingMinigame",
              ownershipMode: "exclusive_tree",
            },
          ],
          preconditions: [],
          verificationRequirements: [],
          unresolvedChoices: [],
          risk: {
            level: "low",
            reasons: ["Self-contained package under the declared Mods root."],
          },
        },
      },
    });
    expect(proposed.isError).not.toBe(true);
    const proposalId = (
      proposed.structuredContent as { proposal: { proposalId: string } }
    ).proposal.proposalId;

    const frozen = await client.callTool({
      name: "freeze_install_plan",
      arguments: { proposalId },
    });
    expect(frozen.isError).not.toBe(true);
    expect(frozen.structuredContent).toMatchObject({
      ok: true,
      plan: {
        approval: { requiresExplicitConfirmation: true },
        operations: [
          {
            kind: "install_tree",
            targetRelativePath: "Mods/SkipFishingMinigame",
          },
        ],
      },
    });
    expect(
      await stat(
        path.join(fixture.gameRoot, "Mods", "SkipFishingMinigame"),
      ).catch(() => null),
    ).toBeNull();
    const planId = (
      frozen.structuredContent as { plan: { planId: string } }
    ).plan.planId;

    const applied = await client.callTool({
      name: "apply_agentic_install_plan",
      arguments: { planId },
    });
    expect(applied.isError).not.toBe(true);
    expect(applied.structuredContent).toMatchObject({
      ok: true,
      planId,
      installation: {
        state: "runtime_unverified",
        methodExecutorId: "agentic-v2-file-method",
        staticVerification: { state: "passed" },
      },
    });
  });

  it("returns actionable dependency errors without modifying the game", async () => {
    const fixture = await createInstallFixture();
    await rm(path.join(fixture.gameRoot, "StardewModdingAPI.exe"));
    service = createNexusMcpServer(
      new NexusClient("fake-api-key"),
      unusedBrowser(),
      { managerRoot: fixture.managerRoot },
    );
    client = new Client({ name: "install-error-test", version: "0.1.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      service.server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const planned = await client.callTool({
      name: "plan_mod_install",
      arguments: {
        archivePath: fixture.archivePath,
        receiptPath: fixture.receiptPath,
        gameRoot: fixture.gameRoot,
      },
    });
    expect(planned.isError).toBe(true);
    expect(planned.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "DEPENDENCY_MISSING",
        nextAction: expect.stringContaining("loader dependency"),
      },
    });
    expect(
      await stat(
        path.join(fixture.gameRoot, "Mods", "SkipFishingMinigame"),
      ).catch(() => null),
    ).toBeNull();
  });
});
