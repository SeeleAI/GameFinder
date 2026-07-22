import { describe, expect, it } from "vitest";
import { parseGameRef, parseModRef } from "../src/url.js";

describe("Nexus URL parsing", () => {
  it("normalizes a canonical game URL", () => {
    expect(parseGameRef("https://www.nexusmods.com/games/eldenring/?tab=mods#top")).toEqual({
      domainName: "eldenring",
      canonicalUrl: "https://www.nexusmods.com/games/eldenring"
    });
  });

  it("parses the acceptance mod URL", () => {
    expect(parseModRef("https://www.nexusmods.com/eldenring/mods/9531")).toEqual({
      domainName: "eldenring",
      modId: 9531,
      canonicalUrl: "https://www.nexusmods.com/eldenring/mods/9531"
    });
  });

  it.each([
    "http://www.nexusmods.com/games/eldenring",
    "https://example.com/games/eldenring",
    "https://www.nexusmods.com/eldenring/mods/9531"
  ])("rejects invalid game identity input: %s", (value) => {
    expect(() => parseGameRef(value)).toThrow();
  });
});
