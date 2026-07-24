import os from "node:os";
import path from "node:path";
import { NexusError } from "../errors.js";

export interface BrowserConfig {
  profileDir: string;
  launchTimeoutMs: number;
  navigationTimeoutMs: number;
  downloadStartTimeoutMs: number;
  downloadTimeoutMs: number;
  loginWaitMs: number;
  keepOpen: boolean;
}

const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 45_000;
const DEFAULT_DOWNLOAD_START_TIMEOUT_MS = 120_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 0;
const DEFAULT_LOGIN_WAIT_MS = 15 * 60_000;

function parseInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const value = env[name];
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value)) {
    throw new NexusError("INVALID_INPUT", `${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new NexusError("INVALID_INPUT", `${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new NexusError("INVALID_INPUT", `${name} must be true, false, 1, or 0.`);
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function defaultLocalAppData(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (env.LOCALAPPDATA && path.isAbsolute(env.LOCALAPPDATA)) return env.LOCALAPPDATA;
  if (platform === "win32") return path.join(os.homedir(), "AppData", "Local");
  return path.join(os.homedir(), ".local", "share");
}

export function loadBrowserConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { cwd?: string; platform?: NodeJS.Platform } = {}
): BrowserConfig {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const platform = options.platform ?? process.platform;
  const configuredProfile = env.NEXUS_BROWSER_PROFILE_DIR?.trim();
  if (configuredProfile && !path.isAbsolute(configuredProfile)) {
    throw new NexusError(
      "OUTPUT_PATH_INVALID",
      "NEXUS_BROWSER_PROFILE_DIR must be an absolute path to a dedicated directory."
    );
  }
  const profileDir = path.resolve(
    configuredProfile && configuredProfile !== ""
      ? configuredProfile
      : path.join(defaultLocalAppData(env, platform), "GameFinder", "nexus-browser-profile")
  );
  const homeDir = path.resolve(os.homedir());
  const root = path.parse(profileDir).root;

  if (profileDir === root || profileDir === homeDir) {
    throw new NexusError(
      "OUTPUT_PATH_INVALID",
      "NEXUS_BROWSER_PROFILE_DIR must be a dedicated absolute directory, not a drive or home-directory root."
    );
  }
  if (configuredProfile && isInside(cwd, profileDir)) {
    throw new NexusError(
      "OUTPUT_PATH_INVALID",
      "NEXUS_BROWSER_PROFILE_DIR must be outside the repository and current working directory."
    );
  }

  return {
    profileDir,
    launchTimeoutMs: parseInteger(
      env,
      "NEXUS_BROWSER_LAUNCH_TIMEOUT_MS",
      DEFAULT_LAUNCH_TIMEOUT_MS,
      1_000,
      300_000
    ),
    navigationTimeoutMs: parseInteger(
      env,
      "NEXUS_BROWSER_NAVIGATION_TIMEOUT_MS",
      DEFAULT_NAVIGATION_TIMEOUT_MS,
      1_000,
      300_000
    ),
    downloadStartTimeoutMs: parseInteger(
      env,
      "NEXUS_BROWSER_DOWNLOAD_START_TIMEOUT_MS",
      DEFAULT_DOWNLOAD_START_TIMEOUT_MS,
      1_000,
      600_000
    ),
    downloadTimeoutMs: parseInteger(
      env,
      "NEXUS_BROWSER_DOWNLOAD_TIMEOUT_MS",
      DEFAULT_DOWNLOAD_TIMEOUT_MS,
      0,
      86_400_000
    ),
    loginWaitMs: parseInteger(env, "NEXUS_BROWSER_LOGIN_WAIT_MS", DEFAULT_LOGIN_WAIT_MS, 60_000, 3_600_000),
    keepOpen: parseBoolean(env, "NEXUS_BROWSER_KEEP_OPEN", true)
  };
}
