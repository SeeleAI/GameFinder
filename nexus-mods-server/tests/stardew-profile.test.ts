import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  probeStardewValleyInstance,
  STARDEW_VALLEY_PROFILE,
} from "../src/install/index.js";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "stardew-profile-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Stardew Valley game profile", () => {
  it("declares only the Mods root writable and keeps Content protected", () => {
    expect(STARDEW_VALLEY_PROFILE.nexusDomainName).toBe("stardewvalley");
    expect(STARDEW_VALLEY_PROFILE.discovery.steamAppIds).toContain(413150);
    expect(STARDEW_VALLEY_PROFILE.filesystem.writableRoots).toEqual(["Mods"]);
    expect(STARDEW_VALLEY_PROFILE.filesystem.protectedRoots).toContain("Content");
  });

  it("probes an explicitly supplied root and reports missing SMAPI", async () => {
    const gameRoot = await makeTemporaryDirectory();
    await writeFile(path.join(gameRoot, "Stardew Valley.exe"), "");
    await mkdir(path.join(gameRoot, "Content"));

    const first = await probeStardewValleyInstance({
      gameRoot,
      platform: "steam",
      platformAppId: "413150",
    });
    const second = await probeStardewValleyInstance({
      gameRoot,
      platform: "steam",
      platformAppId: "413150",
    });

    expect(first.instanceId).toBe(second.instanceId);
    expect(first.detectedLoaders).toContainEqual(
      expect.objectContaining({
        loaderId: "smapi",
        state: "not-detected",
      }),
    );
  });

  it("detects SMAPI without installing or launching it", async () => {
    const gameRoot = await makeTemporaryDirectory();
    await writeFile(path.join(gameRoot, "Stardew Valley.exe"), "");
    await writeFile(path.join(gameRoot, "StardewModdingAPI.exe"), "");
    await mkdir(path.join(gameRoot, "Content"));
    await mkdir(path.join(gameRoot, "Mods"));

    const instance = await probeStardewValleyInstance({ gameRoot });

    expect(instance.detectedLoaders).toContainEqual(
      expect.objectContaining({
        loaderId: "smapi",
        state: "detected",
        absolutePath: path.join(gameRoot, "StardewModdingAPI.exe"),
        modRoots: [path.join(gameRoot, "Mods")],
      }),
    );
  });

  it("rejects a directory that lacks the game anchors", async () => {
    const gameRoot = await makeTemporaryDirectory();

    await expect(
      probeStardewValleyInstance({ gameRoot }),
    ).rejects.toMatchObject({
      code: "GAME_INSTANCE_NOT_FOUND",
    });
  });
});
