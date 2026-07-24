import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NexusError } from "../src/errors.js";
import { loadBrowserConfig } from "../src/browser/browser-config.js";

describe("browser configuration", () => {
  it("uses a dedicated local application data profile with safe defaults", () => {
    const config = loadBrowserConfig(
      { LOCALAPPDATA: path.join(os.tmpdir(), "local-app-data") },
      { cwd: path.join(os.tmpdir(), "workspace"), platform: "win32" }
    );
    expect(config.profileDir).toBe(path.join(os.tmpdir(), "local-app-data", "GameFinder", "nexus-browser-profile"));
    expect(config).toMatchObject({
      launchTimeoutMs: 30_000,
      navigationTimeoutMs: 45_000,
      downloadStartTimeoutMs: 120_000,
      downloadTimeoutMs: 0,
      loginWaitMs: 900_000,
      keepOpen: true
    });
  });

  it("parses supported overrides", () => {
    const profileDir = path.join(os.tmpdir(), "custom-nexus-profile");
    const config = loadBrowserConfig(
      {
        NEXUS_BROWSER_PROFILE_DIR: profileDir,
        NEXUS_BROWSER_LAUNCH_TIMEOUT_MS: "12000",
        NEXUS_BROWSER_NAVIGATION_TIMEOUT_MS: "34000",
        NEXUS_BROWSER_DOWNLOAD_START_TIMEOUT_MS: "56000",
        NEXUS_BROWSER_DOWNLOAD_TIMEOUT_MS: "78000",
        NEXUS_BROWSER_LOGIN_WAIT_MS: "120000",
        NEXUS_BROWSER_KEEP_OPEN: "false"
      },
      { cwd: path.join(os.tmpdir(), "workspace"), platform: "win32" }
    );
    expect(config).toEqual({
      profileDir,
      launchTimeoutMs: 12_000,
      navigationTimeoutMs: 34_000,
      downloadStartTimeoutMs: 56_000,
      downloadTimeoutMs: 78_000,
      loginWaitMs: 120_000,
      keepOpen: false
    });
  });

  it("rejects a profile inside the working tree", () => {
    const cwd = path.join(os.tmpdir(), "workspace");
    expect(() =>
      loadBrowserConfig({ NEXUS_BROWSER_PROFILE_DIR: path.join(cwd, ".profile") }, { cwd, platform: "win32" })
    ).toThrowError(NexusError);
  });

  it("rejects a relative profile override", () => {
    expect(() =>
      loadBrowserConfig(
        { NEXUS_BROWSER_PROFILE_DIR: "relative-profile" },
        { cwd: path.join(os.tmpdir(), "workspace"), platform: "win32" }
      )
    ).toThrow(/absolute path/);
  });

  it("allows the safe default when the process starts above LOCALAPPDATA", () => {
    const localAppData = path.join(os.tmpdir(), "user", "AppData", "Local");
    const config = loadBrowserConfig(
      { LOCALAPPDATA: localAppData },
      { cwd: path.join(os.tmpdir(), "user"), platform: "win32" }
    );
    expect(config.profileDir).toBe(path.join(localAppData, "GameFinder", "nexus-browser-profile"));
  });

  it("rejects malformed timeouts and booleans", () => {
    const cwd = path.join(os.tmpdir(), "workspace");
    const profileDir = path.join(os.tmpdir(), "profile");
    expect(() =>
      loadBrowserConfig(
        { NEXUS_BROWSER_PROFILE_DIR: profileDir, NEXUS_BROWSER_LOGIN_WAIT_MS: "-1" },
        { cwd, platform: "win32" }
      )
    ).toThrow(/NEXUS_BROWSER_LOGIN_WAIT_MS/);
    expect(() =>
      loadBrowserConfig(
        { NEXUS_BROWSER_PROFILE_DIR: profileDir, NEXUS_BROWSER_KEEP_OPEN: "sometimes" },
        { cwd, platform: "win32" }
      )
    ).toThrow(/NEXUS_BROWSER_KEEP_OPEN/);
    expect(() =>
      loadBrowserConfig(
        { NEXUS_BROWSER_PROFILE_DIR: profileDir, NEXUS_BROWSER_DOWNLOAD_START_TIMEOUT_MS: "0" },
        { cwd, platform: "win32" }
      )
    ).toThrow(/NEXUS_BROWSER_DOWNLOAD_START_TIMEOUT_MS/);
  });
});
