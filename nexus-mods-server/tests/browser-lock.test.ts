import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserProfileLock } from "../src/browser/browser-lock.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("BrowserProfileLock", () => {
  it("prevents a second owner and releases cleanly", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nexus-browser-lock-"));
    temporaryDirectories.push(directory);
    const profileDir = path.join(directory, "profile");
    const first = new BrowserProfileLock(profileDir);
    const second = new BrowserProfileLock(profileDir);

    await first.acquire();
    expect(first.owned).toBe(true);
    expect(await second.isBusy()).toBe(true);
    await expect(second.acquire()).rejects.toMatchObject({ code: "BROWSER_PROFILE_BUSY" });

    await first.release();
    expect(first.owned).toBe(false);
    await second.acquire();
    expect(second.owned).toBe(true);
    await second.release();
  });
});
