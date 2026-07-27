import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { NexusError } from "../../errors.js";

const execFileAsync = promisify(execFile);

function parseWindowsTaskNames(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => /^"([^"]+)"/.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
}

export async function assertSensitiveProcessesStopped(
  processNames: ReadonlyArray<string>,
): Promise<void> {
  if (processNames.length === 0) return;
  let runningNames: string[];
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("tasklist.exe", [
        "/FO",
        "CSV",
        "/NH",
      ]);
      runningNames = parseWindowsTaskNames(stdout);
    } else {
      const { stdout } = await execFileAsync("ps", ["-A", "-o", "comm="]);
      runningNames = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    }
  } catch (error) {
    throw new NexusError(
      "GAME_PROCESS_RUNNING",
      "The transaction engine could not verify that game processes are stopped.",
      { cause: error, retryable: true },
    );
  }
  const requested = new Map(
    processNames.map((name) => [name.toLowerCase(), name]),
  );
  const matches = runningNames.filter((name) =>
    requested.has(name.toLowerCase()),
  );
  if (matches.length > 0) {
    throw new NexusError(
      "GAME_PROCESS_RUNNING",
      "The game or Mod loader is running; stop it before changing managed files.",
      { retryable: true, details: { runningProcesses: matches } },
    );
  }
}
