import path from "node:path";
import { describe, expect, it } from "vitest";
import { NexusError } from "../src/errors.js";
import { buildNexusFileUrl } from "../src/browser/nexus-download-page-controller.js";

describe("Nexus file-page URL construction", () => {
  it("builds the exact canonical file URL", () => {
    expect(buildNexusFileUrl({ domainName: "EldenRing", modId: 9531, fileId: 47215 })).toBe(
      "https://www.nexusmods.com/eldenring/mods/9531?tab=files&file_id=47215"
    );
  });

  it("rejects an arbitrary host, path-shaped domain, or invalid id", () => {
    expect(() =>
      buildNexusFileUrl({ domainName: "example.com/eldenring", modId: 9531, fileId: 47215 })
    ).toThrowError(NexusError);
    expect(() => buildNexusFileUrl({ domainName: "eldenring", modId: 0, fileId: 47215 })).toThrowError(
      NexusError
    );
  });

  it("keeps an internal staging filename absolute before a browser save", () => {
    expect(path.isAbsolute("C:\\downloads\\.nexus-download-staging\\session-file.part")).toBe(
      process.platform === "win32"
    );
  });
});
