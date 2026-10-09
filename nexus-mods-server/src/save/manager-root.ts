import os from "node:os";
import path from "node:path";
export function resolveDefaultSaveManagerRoot(): string {
  if (process.platform === "win32" && process.env.LOCALAPPDATA?.trim()) return path.join(process.env.LOCALAPPDATA.trim(), "GameFinder");
  return path.join(os.homedir(), ".local", "share", "GameFinder");
}
