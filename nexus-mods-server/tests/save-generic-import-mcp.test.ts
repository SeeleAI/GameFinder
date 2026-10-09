import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZipFile } from "yazl";
import { NexusClient } from "../src/nexus-client.js";
import { SaveService } from "../src/save/save-service.js";
import { createNexusMcpServer, type NexusMcpService } from "../src/server.js";

let client: Client | undefined;
let service: NexusMcpService | undefined;
const directories: string[] = [];
const opaqueSave = Buffer.from([0xff, 0x00, 0x89, 0x41, 0xde, 0xad, 0xbe, 0xef]);
const originalSave = Buffer.from([0x01, 0x02, 0x03, 0x04]);

async function fixture(targetIsInstallationRoot = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "generic-save-mcp-"));
  directories.push(root);
  const installationRoot = path.join(root, "unknown-game");
  const targetRoot = targetIsInstallationRoot ? installationRoot : path.join(root, "player", "saves");
  await mkdir(installationRoot, { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  await writeFile(path.join(installationRoot, "unknown-game.exe"), "fixture executable identity");
  await writeFile(path.join(targetRoot, "slot01.sav"), originalSave);
  await writeFile(path.join(targetRoot, "untouched.sav"), "unrelated original slot");
  const archivePath = path.join(root, "complete-save.zip");
  const zip = new ZipFile();
  zip.addBuffer(opaqueSave, "author-download/profile-foreign/donor.sav");
  zip.addBuffer(Buffer.from("related slot metadata"), "author-download/profile-foreign/donor.meta");
  zip.addBuffer(Buffer.from("Author: import the pair as whole files."), "readme.txt");
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(archivePath));
  const processGuard = vi.fn(async (_names: ReadonlyArray<string>) => undefined);
  service = createNexusMcpServer(new NexusClient("fixture-key"), undefined, {
    managerRoot: path.join(root, "manager"), saveProcessGuard: processGuard
  });
  client = new Client({ name: "generic-save-import-mcp", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await Promise.all([service.server.connect(remote), client.connect(local)]);
  return { client, root, installationRoot, targetRoot, archivePath, processGuard };
}

function evidence(installationRoot: string, knownConversionRequired = false) {
  return {
    gameName: "Unregistered Save Fixture Game",
    installationRoot,
    source: "https://www.nexusmods.com/unregistered-save-fixture/mods/123; author claims completed main story.",
    target: "Local player save directory was checked against game configuration and existing slot files.",
    compatibility: "Fixture source and installation match Windows version 1; game load remains unverified.",
    method: "Author documents importing both complete files without changing internal bytes or account identity.",
    knownConversionRequired
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

describe("generic save import MCP workflow", () => {
  it.each([false, true])("imports an unknown binary game with wrappers and renaming (installation target: %s)", async (targetIsInstallationRoot) => {
    const legacyService = vi.spyOn(SaveService, "create");
    const f = await fixture(targetIsInstallationRoot);
    const staged = await f.client.callTool({ name: "inspect_save_input", arguments: { inputPath: f.archivePath, stage: true } });
    expect(staged.isError).not.toBe(true);
    const input = staged.structuredContent as {
      inspection: { inspectionId: string };
      stagedInput: { root: string; files: Array<{ relativePath: string; sha256: string; bytes: number }> }
    };
    expect(input.inspection.inspectionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(input.stagedInput.files.map((file) => file.relativePath)).toEqual(expect.arrayContaining([
      "author-download/profile-foreign/donor.sav", "author-download/profile-foreign/donor.meta", "readme.txt"
    ]));
    expect(await readFile(path.join(input.stagedInput.root, "author-download", "profile-foreign", "donor.sav"))).toEqual(opaqueSave);
    const planned = await f.client.callTool({ name: "plan_save_import", arguments: {
      inputPath: input.stagedInput.root, targetRoot: f.targetRoot,
      mappings: [
        { sourcePath: "author-download/profile-foreign/donor.sav", targetPath: "slot01.sav" },
        { sourcePath: "author-download/profile-foreign/donor.meta", targetPath: "metadata/slot01.meta" }
      ],
      processNames: ["unknown-game.exe"], evidence: evidence(f.installationRoot)
    } });
    expect(planned.isError).not.toBe(true);
    const plan = (planned.structuredContent as { plan: { planId: string; changes: Array<{ targetPath: string }> } }).plan;
    expect(plan.planId).toMatch(/^[0-9a-f-]{36}$/);
    expect(plan.changes.map((change) => change.targetPath)).toEqual(["slot01.sav", "metadata/slot01.meta"]);
    expect(await readFile(path.join(f.targetRoot, "slot01.sav"))).toEqual(originalSave);

    const applied = await f.client.callTool({ name: "apply_save_import", arguments: { planId: plan.planId } });
    expect(applied.isError).not.toBe(true);
    expect(applied.structuredContent).toMatchObject({
      plan: { planId: plan.planId }, operation: { state: "applied", backups: { "slot01.sav": expect.any(String), "metadata/slot01.meta": null } },
      runtimeVerification: "not_performed"
    });
    expect(f.processGuard).toHaveBeenCalledWith(["unknown-game.exe"]);
    expect(await readFile(path.join(f.targetRoot, "slot01.sav"))).toEqual(opaqueSave);
    expect(await readFile(path.join(f.targetRoot, "metadata", "slot01.meta"), "utf8")).toBe("related slot metadata");
    expect(await readFile(path.join(f.targetRoot, "untouched.sav"), "utf8")).toBe("unrelated original slot");
    await expect(stat(path.join(f.targetRoot, "readme.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(f.installationRoot, "unknown-game.exe"), "utf8")).toBe("fixture executable identity");

    const queried = await f.client.callTool({ name: "get_save_import", arguments: { planId: plan.planId } });
    expect(queried.structuredContent).toMatchObject({ operation: { state: "applied" }, runtimeVerification: "not_performed" });
    // Preserve later gameplay changes as a rescue backup, and leave an unrelated new slot alone.
    await writeFile(path.join(f.targetRoot, "slot01.sav"), "new play after import");
    await writeFile(path.join(f.targetRoot, "later-slot.sav"), "unrelated later slot");
    const restored = await f.client.callTool({ name: "restore_save_import", arguments: { planId: plan.planId } });
    expect(restored.isError).not.toBe(true);
    expect(restored.structuredContent).toMatchObject({ operation: { state: "restored", rescue: { "slot01.sav": expect.any(String) } } });
    expect(await readFile(path.join(f.targetRoot, "slot01.sav"))).toEqual(originalSave);
    await expect(stat(path.join(f.targetRoot, "metadata", "slot01.meta"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(f.targetRoot, "untouched.sav"), "utf8")).toBe("unrelated original slot");
    expect(await readFile(path.join(f.targetRoot, "later-slot.sav"), "utf8")).toBe("unrelated later slot");
    expect(legacyService).not.toHaveBeenCalled();
  });

  it("rejects known internal conversion before creating a plan or mutating target files", async () => {
    const f = await fixture();
    const rejected = await f.client.callTool({ name: "plan_save_import", arguments: {
      inputPath: f.archivePath, targetRoot: f.targetRoot,
      mappings: [{ sourcePath: "author-download/profile-foreign/donor.sav", targetPath: "slot01.sav" }],
      processNames: ["unknown-game.exe"], evidence: evidence(f.installationRoot, true)
    } });
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent).toMatchObject({ ok: false, error: { code: "SAVE_ADAPTER_UNSUPPORTED" } });
    expect(rejected.structuredContent).not.toHaveProperty("plan");
    expect(await readFile(path.join(f.targetRoot, "slot01.sav"))).toEqual(originalSave);
    expect(f.processGuard).not.toHaveBeenCalled();
  });
});
