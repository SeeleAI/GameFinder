import { describe, expect, it } from "vitest";
import {
  classifyPageSignals,
  type NexusPageKind,
  type NexusPageSignals
} from "../src/browser/page-classifier.js";

function signals(overrides: Partial<NexusPageSignals> = {}): NexusPageSignals {
  return {
    status: 200,
    loginUrl: false,
    modFilesUrl: false,
    requirementsUrl: false,
    loginRequired: false,
    manualDownload: false,
    requirementsPrompt: false,
    downloadOption: false,
    captcha: false,
    twoFactor: false,
    adultContent: false,
    cookieConsent: false,
    rateLimited: false,
    maintenance: false,
    notFound: false,
    accessDenied: false,
    ...overrides
  };
}

describe("Nexus page classification", () => {
  it.each([
    ["captcha", { captcha: true, modFilesUrl: true }],
    ["two_factor", { twoFactor: true }],
    ["rate_limited", { status: 429 }],
    ["maintenance", { status: 503 }],
    ["not_found", { status: 404 }],
    ["access_denied", { status: 403 }],
    ["login", { loginRequired: true }],
    ["adult_content", { adultContent: true }],
    ["cookie_consent", { cookieConsent: true }],
    ["requirements", { requirementsPrompt: true }],
    ["download_options", { downloadOption: true }],
    ["mod_files", { modFilesUrl: true }],
    ["unknown", {}]
  ] satisfies Array<[NexusPageKind, Partial<NexusPageSignals>]>)("classifies %s", (expected, override) => {
    expect(classifyPageSignals(signals(override))).toBe(expected);
  });

  it("treats a Cloudflare challenge as CAPTCHA before a nominal Mod files URL", () => {
    expect(classifyPageSignals(signals({ captcha: true, modFilesUrl: true, status: 403 }))).toBe("captcha");
  });

  it("treats blocking cookie consent as interaction before a logged-out navigation action", () => {
    expect(classifyPageSignals(signals({ cookieConsent: true, loginRequired: true }))).toBe("cookie_consent");
  });
});
