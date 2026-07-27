import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NexusError } from "../src/errors.js";
import {
  assertNoReparsePointTraversal,
  normalizeManagedRelativePath,
  resolveManagedTarget,
} from "../src/install/path-policy.js";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "nexus-install-policy-"));
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

describe("normalizeManagedRelativePath", () => {
  it("normalizes separators without changing the managed path", () => {
    expect(
      normalizeManagedRelativePath(
        "Mods\\SkipFishingMinigameDotnet5\\manifest.json",
        "win32",
      ),
    ).toBe("Mods/SkipFishingMinigameDotnet5/manifest.json");
  });

  it.each([
    "../outside.txt",
    "Mods/../../outside.txt",
    "/absolute/path",
    "\\\\server\\share\\mod.dll",
    "C:\\Games\\Stardew Valley\\Mods\\mod.dll",
    "Mods/file.dll:stream",
    "Mods/CON/readme.txt",
    "Mods/trailing-dot./file.txt",
    "Mods/trailing-space /file.txt",
  ])("rejects unsafe path %s", (unsafePath) => {
    expect(() => normalizeManagedRelativePath(unsafePath, "win32")).toThrow(
      NexusError,
    );
  });
});

describe("resolveManagedTarget", () => {
  it("allows a target under a declared writable root", () => {
    const gameRoot = path.win32.resolve("C:/Games/Stardew Valley");
    const resolved = resolveManagedTarget({
      gameRoot,
      targetRelativePath: "Mods/SkipFishingMinigameDotnet5/manifest.json",
      writableRoots: ["Mods"],
      protectedRoots: ["Content"],
      platform: "win32",
    });

    expect(resolved.targetRelativePath).toBe(
      "Mods/SkipFishingMinigameDotnet5/manifest.json",
    );
    expect(resolved.targetAbsolutePath).toBe(
      path.win32.join(
        gameRoot,
        "Mods",
        "SkipFishingMinigameDotnet5",
        "manifest.json",
      ),
    );
  });

  it("rejects protected and undeclared target roots", () => {
    const gameRoot = path.win32.resolve("C:/Games/Stardew Valley");

    expect(() =>
      resolveManagedTarget({
        gameRoot,
        targetRelativePath: "Content/Data/Objects.xnb",
        writableRoots: ["Mods"],
        protectedRoots: ["Content"],
        platform: "win32",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "PROTECTED_PATH",
      }),
    );

    expect(() =>
      resolveManagedTarget({
        gameRoot,
        targetRelativePath: "Saves/Farmer/save.xml",
        writableRoots: ["Mods"],
        protectedRoots: ["Content"],
        platform: "win32",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "PROTECTED_PATH",
      }),
    );
  });
});

describe("assertNoReparsePointTraversal", () => {
  it("allows ordinary directories inside the game root", async () => {
    const gameRoot = await makeTemporaryDirectory();
    await mkdir(path.join(gameRoot, "Mods", "Example"), { recursive: true });

    await expect(
      assertNoReparsePointTraversal(
        gameRoot,
        path.join(gameRoot, "Mods", "Example", "manifest.json"),
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a junction or symlink in the target path", async () => {
    const gameRoot = await makeTemporaryDirectory();
    const externalRoot = await makeTemporaryDirectory();
    const modsDirectory = path.join(gameRoot, "Mods");
    const linkedDirectory = path.join(modsDirectory, "LinkedMod");
    await mkdir(modsDirectory, { recursive: true });

    try {
      await symlink(
        externalRoot,
        linkedDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EACCES")
      ) {
        return;
      }
      throw error;
    }

    await expect(
      assertNoReparsePointTraversal(
        gameRoot,
        path.join(linkedDirectory, "payload.dll"),
      ),
    ).rejects.toMatchObject({
      code: "PROTECTED_PATH",
    });
  });
});
