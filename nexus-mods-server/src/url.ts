import { NexusError } from "./errors.js";

const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface GameRef {
  domainName: string;
  canonicalUrl: string;
}

export interface ModRef extends GameRef {
  modId: number;
  canonicalUrl: string;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

export function normalizeDomainName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!DOMAIN_PATTERN.test(normalized)) {
    throw new NexusError("INVALID_INPUT", `Invalid Nexus game domain: ${value}`);
  }
  return normalized;
}

function assertNexusHost(url: URL): void {
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (hostname !== "www.nexusmods.com" && hostname !== "nexusmods.com")) {
    throw new NexusError("INVALID_INPUT", "Expected an HTTPS URL on nexusmods.com.");
  }
}

export function parseGameRef(input: string): GameRef {
  const url = parseUrl(input.trim());
  let domainName: string;
  if (url) {
    assertNexusHost(url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 2 || segments[0]?.toLowerCase() !== "games") {
      throw new NexusError(
        "INVALID_INPUT",
        "Expected a canonical Nexus game URL shaped like https://www.nexusmods.com/games/<slug>."
      );
    }
    domainName = normalizeDomainName(segments[1] ?? "");
  } else {
    domainName = normalizeDomainName(input);
  }
  return {
    domainName,
    canonicalUrl: `https://www.nexusmods.com/games/${domainName}`
  };
}

export function parseModRef(input: string): ModRef {
  const url = parseUrl(input.trim());
  if (!url) {
    throw new NexusError("INVALID_INPUT", "Expected a canonical Nexus Mod URL.");
  }
  assertNexusHost(url);
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 3 || segments[1]?.toLowerCase() !== "mods") {
    throw new NexusError(
      "INVALID_INPUT",
      "Expected a Nexus Mod URL shaped like https://www.nexusmods.com/<game>/mods/<modId>."
    );
  }
  const domainName = normalizeDomainName(segments[0] ?? "");
  const modIdText = segments[2] ?? "";
  if (!/^\d+$/.test(modIdText)) {
    throw new NexusError("INVALID_INPUT", "Nexus modId must be a positive integer.");
  }
  const modId = Number(modIdText);
  if (!Number.isSafeInteger(modId) || modId <= 0) {
    throw new NexusError("INVALID_INPUT", "Nexus modId must be a positive safe integer.");
  }
  return {
    domainName,
    modId,
    canonicalUrl: `https://www.nexusmods.com/${domainName}/mods/${modId}`
  };
}

export function buildModUrl(domainName: string, modId: number): string {
  return `https://www.nexusmods.com/${normalizeDomainName(domainName)}/mods/${modId}`;
}
