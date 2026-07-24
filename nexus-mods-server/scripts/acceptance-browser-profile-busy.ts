import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserManager } from "../src/browser/browser-manager.js";
import { asNexusError } from "../src/errors.js";

const scriptPath = fileURLToPath(import.meta.url);
const projectDirectory = path.resolve(path.dirname(scriptPath), "..");
const isProbe = process.argv.includes("--probe");

async function runProbe(): Promise<void> {
  const browser = new BrowserManager();
  try {
    await browser.getPage();
    throw new Error("A second process unexpectedly opened the dedicated Nexus Chromium Profile.");
  } catch (error) {
    const nexusError = asNexusError(error);
    if (nexusError.code !== "BROWSER_PROFILE_BUSY") throw error;
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        case: "PC-6",
        observed: "BROWSER_PROFILE_BUSY"
      })}\n`
    );
  } finally {
    await browser.close();
  }
}

async function runParent(): Promise<void> {
  const browser = new BrowserManager();
  try {
    await browser.getPage();
    const child = spawn(process.execPath, ["--import", "tsx", scriptPath, "--probe"], {
      cwd: projectDirectory,
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
      ),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    const output = Buffer.concat(stdout).toString("utf8").trim();
    const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
    if (exitCode !== 0 || !output.includes("BROWSER_PROFILE_BUSY")) {
      throw new Error(
        `Profile-busy probe failed with exit ${String(exitCode)}: ${errorOutput || output || "no output"}`
      );
    }
    process.stdout.write(`${output}\n`);
  } finally {
    await browser.close();
  }
}

(isProbe ? runProbe() : runParent()).catch((error: unknown) => {
  const nexusError = asNexusError(error);
  console.error(`${nexusError.code}: ${nexusError.message}`);
  process.exitCode = 1;
});
