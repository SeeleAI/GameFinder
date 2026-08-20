import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import type { PeMetadata, PeMetadataReader } from "./types.js";

const execFile = promisify(execFileCallback);

const VERSION_INFO_SCRIPT = [
  "$v=(Get-Item -LiteralPath $env:GAMEFINDER_PE_METADATA_PATH).VersionInfo",
  "$o=[ordered]@{productName=$v.ProductName;fileDescription=$v.FileDescription;fileVersion=$v.FileVersion;productVersion=$v.ProductVersion}",
  "[Console]::Out.Write(($o|ConvertTo-Json -Compress))",
].join(";");

export const readWindowsPeMetadata: PeMetadataReader = async (executablePath) => {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await execFile("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      VERSION_INFO_SCRIPT,
    ], {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
      env: {
        ...process.env,
        GAMEFINDER_PE_METADATA_PATH: executablePath,
      },
    });
    const parsed = JSON.parse(stdout) as Partial<Record<keyof PeMetadata, unknown>>;
    const text = (value: unknown): string | null => (
      typeof value === "string" && value.trim().length > 0 ? value.trim() : null
    );
    return {
      productName: text(parsed.productName),
      fileDescription: text(parsed.fileDescription),
      fileVersion: text(parsed.fileVersion),
      productVersion: text(parsed.productVersion),
    };
  } catch {
    return null;
  }
};
