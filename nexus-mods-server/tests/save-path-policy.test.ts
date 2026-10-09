import { describe, expect, it } from "vitest";
import { normalizeSaveRelativePath } from "../src/save/path-policy.js";
describe("portable save file names", () => {
  it.each(["../escape", "a/../b", "C:/save", "a:stream", "NUL", "slot./file", "a/CON.txt", "a/\u202efile", "a//b", "./slot"])("rejects unsafe path %s", (name) => {
    expect(() => normalizeSaveRelativePath(name, "win32")).toThrow();
  });
  it("normalizes a nested Windows relative path", () => {
    expect(normalizeSaveRelativePath("player\\slot.sav", "win32")).toBe("player/slot.sav");
  });
});
