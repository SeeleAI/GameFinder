import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NexusBrowserAutomation } from "../src/browser/browser-service.js";
import { sha256CanonicalJson } from "../src/install/content-hash.js";
import { NexusClient } from "../src/nexus-client.js";
import type { SaveContext } from "../src/save/contracts.js";
import { saveContextSchema } from "../src/save/contracts.js";
import { SaveContextStore } from "../src/save/storage/context-store.js";
import { createNexusMcpServer, type NexusMcpService } from "../src/server.js";
import {
  gameInstallContextFixture,
  saveContextFixture,
} from "./fixtures/save-contract-fixtures.js";

let client: Client | undefined;
let service: NexusMcpService | undefined;
const temporaryDirectories: string[] = [];

const unusedBrowser: NexusBrowserAutomation = {
  status: vi.fn(async () => ({
    launchMode: "ordinary_chromium_cdp" as const,
    engineInstalled: true as const,
    profileExists: true as const,
    profilePathConfigured: true as const,
    profileBusy: false,
    running: false,
    authState: "unknown" as const,
    authCheckedAt: null,
    requiresUserInteraction: false as const,
    interactionReason: null,
  })),
  openLogin: vi.fn(async () => ({
    state: "waiting_for_user" as const,
    checkedAt: new Date().toISOString(),
    expiresAt: null,
    requiresUserInteraction: true as const,
    interactionReason: "login" as const,
  })),
  createDownloadController: vi.fn(async () => {
    throw new Error("Browser is outside the M2 save fixture.");
  }),
  close: vi.fn(async () => undefined),
};

afterEach(async () => {
  await client?.close();
  await service?.close();
  client = undefined;
  service = undefined;
  await Promise.all(
    temporaryDirectories.splice(0).map(
      async (directory) => await rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("save M2 MCP workflow", () => {
  it("backs up, verifies, plans, applies, and verifies a sandbox restore by IDs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "save-m2-mcp-"));
    temporaryDirectories.push(root);
    const managerRoot = path.join(root, "manager");
    const saveRoot = path.join(root, "save");
    const manualInput = path.join(root, "manual-input", "76561198127396738");
    await Promise.all([
      mkdir(saveRoot, { recursive: true }),
      mkdir(manualInput, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(saveRoot, "ER0000.sl2"), "mcp-primary"),
      writeFile(path.join(saveRoot, "ER0000.sl2.bak"), "mcp-companion"),
      writeFile(path.join(saveRoot, "steam_autocloud.vdf"), "mcp-cloud"),
      writeFile(path.join(manualInput, "ER0000.sl2"), "mcp-old-primary"),
      writeFile(path.join(manualInput, "ER0000.sl2.bak"), "mcp-old-companion"),
      writeFile(path.join(manualInput, "steam_autocloud.vdf"), "mcp-old-cloud"),
    ]);
    const contexts = await SaveContextStore.create(managerRoot);
    const install = gameInstallContextFixture();
    await contexts.saveInstallContext(install);
    const base = saveContextFixture(install.installContextId);
    const { contextHash: _oldHash, ...withoutOldHash } = base;
    const withoutHash = {
      ...withoutOldHash,
      saveRoots: [
        { rootId: "primary", absolutePath: saveRoot, role: "primary" as const },
      ],
    };
    const context: SaveContext = saveContextSchema.parse({
      ...withoutHash,
      contextHash: sha256CanonicalJson(withoutHash),
    });
    await contexts.saveSaveContext(context);

    service = createNexusMcpServer(new NexusClient("fake-api-key"), unusedBrowser, {
      managerRoot,
      saveProcessGuard: async () => undefined,
    });
    client = new Client({ name: "save-m2-mcp-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([service.server.connect(serverTransport), client.connect(clientTransport)]);

    const speedrunSnapshotResult = await client.callTool({
      name: "record_speedrun_save_page_snapshot",
      arguments: {
        installContextId: install.installContextId,
        pageHtml:
          "<h2>Tools</h2><a href='/eldenring/resources/tool'>Tool</a><h2>Saves</h2><p>No Saves</p><h2>Patches</h2>",
      },
    });
    expect(speedrunSnapshotResult.isError).not.toBe(true);
    expect(speedrunSnapshotResult.structuredContent).toMatchObject({
      ok: true,
      snapshot: {
        source: "speedrun",
        candidateIds: [],
        warnings: [expect.stringContaining("No Saves")],
      },
      candidates: [],
    });
    const sourceSnapshotId = (speedrunSnapshotResult.structuredContent as {
      snapshot: { snapshotId: string };
    }).snapshot.snapshotId;
    const verifiedSourceSnapshot = await client.callTool({
      name: "get_save_source_snapshot",
      arguments: { snapshotId: sourceSnapshotId },
    });
    expect(verifiedSourceSnapshot.structuredContent).toMatchObject({
      ok: true,
      snapshot: { snapshotId: sourceSnapshotId },
    });

    const created = await client.callTool({
      name: "create_save_backup",
      arguments: {
        saveContextId: context.saveContextId,
        unitId: "vanilla-main",
        reason: "manual",
      },
    });
    expect(created.isError).not.toBe(true);
    const backupId = (created.structuredContent as {
      backup: { backupId: string };
    }).backup.backupId;
    const verified = await client.callTool({
      name: "verify_save_backup",
      arguments: { backupId },
    });
    expect(verified.structuredContent).toMatchObject({
      ok: true,
      integrity: "verified",
    });
    const planned = await client.callTool({
      name: "plan_save_restore",
      arguments: {
        backupId,
        saveContextId: context.saveContextId,
        mode: "exact_managed_snapshot",
        targetKind: "sandbox",
      },
    });
    expect(planned.structuredContent).toMatchObject({
      review: {
        classification: "auto_safe",
        nextAction: "apply_now",
        requestScope: { mode: "auto_safe", action: "restore" },
      },
    });
    const restorePlanId = (planned.structuredContent as {
      plan: { restorePlanId: string };
    }).plan.restorePlanId;
    const applied = await client.callTool({
      name: "apply_save_restore",
      arguments: { restorePlanId },
    });
    expect(applied.isError).not.toBe(true);
    const recordId = (applied.structuredContent as {
      record: { recordId: string };
    }).record.recordId;
    const restored = await client.callTool({
      name: "verify_save_restore",
      arguments: { recordId },
    });
    expect(restored.structuredContent).toMatchObject({
      ok: true,
      record: { recordId, staticVerification: "passed" },
    });
    const replay = await client.callTool({
      name: "apply_save_restore",
      arguments: { restorePlanId },
    });
    expect(replay.structuredContent).toMatchObject({
      ok: true,
      idempotentReplay: true,
      record: { recordId },
    });

    const inspectedInput = await client.callTool({
      name: "inspect_save_input",
      arguments: { inputPath: path.dirname(manualInput) },
    });
    const inspection = (inspectedInput.structuredContent as {
      inspection: {
        inspectionId: string;
        payloadCandidates: Array<{ payloadSelectionId: string }>;
      };
    }).inspection;
    const normalized = await client.callTool({
      name: "normalize_save_package",
      arguments: {
        inspectionId: inspection.inspectionId,
        payloadSelectionId: inspection.payloadCandidates[0]!.payloadSelectionId,
      },
    });
    const packageId = (normalized.structuredContent as {
      package: { packageId: string };
    }).package.packageId;
    const assessed = await client.callTool({
      name: "assess_save_package_compatibility",
      arguments: { packageId, saveContextId: context.saveContextId },
    });
    const assessmentId = (assessed.structuredContent as {
      assessment: { assessmentId: string; state: string };
    }).assessment.assessmentId;
    expect(assessed.structuredContent).toMatchObject({
      assessment: { state: "compatible_direct" },
    });
    const replacementPlan = await client.callTool({
      name: "plan_save_replacement",
      arguments: { assessmentId, strategy: "direct_replace" },
    });
    expect(replacementPlan.structuredContent).toMatchObject({
      review: {
        classification: "auto_safe",
        nextAction: "apply_now",
        requestScope: { mode: "auto_safe", action: "replace" },
      },
    });
    const replacementPlanId = (replacementPlan.structuredContent as {
      plan: { replacementPlanId: string };
    }).plan.replacementPlanId;
    const replacement = await client.callTool({
      name: "apply_save_replacement",
      arguments: { replacementPlanId },
    });
    const replacementRecordId = (replacement.structuredContent as {
      record: { recordId: string };
    }).record.recordId;
    expect(await readFile(path.join(saveRoot, "ER0000.sl2"), "utf8"))
      .toBe("mcp-old-primary");
    const runtime = await client.callTool({
      name: "record_save_runtime_verification",
      arguments: {
        operationRecordId: replacementRecordId,
        outcome: "passed",
        notes: "MCP fixture runtime observation",
      },
    });
    expect(runtime.structuredContent).toMatchObject({
      ok: true,
      verification: { operationRecordId: replacementRecordId, outcome: "passed" },
    });
  });
});
