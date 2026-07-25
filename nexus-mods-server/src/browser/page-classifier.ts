import type { Page, Response } from "playwright";

export type NexusPageKind =
  | "login"
  | "mod_files"
  | "requirements"
  | "download_options"
  | "captcha"
  | "two_factor"
  | "adult_content"
  | "cookie_consent"
  | "rate_limited"
  | "maintenance"
  | "not_found"
  | "access_denied"
  | "unknown";

export interface NexusPageSignals {
  status: number | null;
  loginUrl: boolean;
  modFilesUrl: boolean;
  requirementsUrl: boolean;
  loginRequired: boolean;
  manualDownload: boolean;
  requirementsPrompt: boolean;
  downloadOption: boolean;
  captcha: boolean;
  twoFactor: boolean;
  adultContent: boolean;
  cookieConsent: boolean;
  rateLimited: boolean;
  maintenance: boolean;
  notFound: boolean;
  accessDenied: boolean;
}

export interface NexusPageClassification {
  kind: NexusPageKind;
  status: number | null;
  path: string | null;
}

export function classifyPageSignals(signals: NexusPageSignals): NexusPageKind {
  if (signals.captcha) return "captcha";
  if (signals.twoFactor) return "two_factor";
  if (signals.rateLimited || signals.status === 429) return "rate_limited";
  if (signals.maintenance || (signals.status !== null && signals.status >= 500)) return "maintenance";
  if (signals.notFound || signals.status === 404) return "not_found";
  if (signals.accessDenied || signals.status === 401 || signals.status === 403) return "access_denied";
  if (signals.cookieConsent) return "cookie_consent";
  if (signals.adultContent) return "adult_content";
  if (signals.loginUrl || signals.loginRequired) return "login";
  if (signals.requirementsUrl || signals.requirementsPrompt) return "requirements";
  if (signals.downloadOption) return "download_options";
  if (signals.modFilesUrl || signals.manualDownload) return "mod_files";
  return "unknown";
}

export async function classifyNexusPage(
  page: Page,
  response?: Response | null
): Promise<NexusPageClassification> {
  const status = response?.status() ?? null;
  let url: URL | undefined;
  try {
    url = new URL(page.url());
  } catch {
    url = undefined;
  }

  const dom = await page.evaluate(() => {
    const bodyText = (document.body?.innerText ?? "").slice(0, 12_000).toLowerCase();
    const titleText = document.title.toLowerCase();
    const visible = (element: Element): boolean => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const actionTexts = Array.from(document.querySelectorAll("button, a, [role='button']"))
      .filter(visible)
      .map((element) =>
        ((element as HTMLElement).innerText ?? element.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase()
      );
    const requirementContainers = Array.from(
      document.querySelectorAll(
        '[role="dialog"][aria-modal="true"], [data-testid*="requirement" i], [data-test*="requirement" i], [class*="requirement" i]'
      )
    ).filter(visible);
    const visibleLoginAction = Array.from(document.querySelectorAll("a[href], button"))
      .filter(visible)
      .some((element) => {
        const text = ((element as HTMLElement).innerText ?? element.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        const href = element instanceof HTMLAnchorElement ? element.href.toLowerCase() : "";
        return /^(?:log in|login|sign in)$/.test(text) && href.includes("users.nexusmods.com/auth/sign_in");
      });

    return {
      loginRequired:
        visibleLoginAction ||
        bodyText.includes("you have to be logged in") ||
        bodyText.includes("you need to log in") ||
        bodyText.includes("please log in again") ||
        bodyText.includes("sign in to continue"),
      manualDownload: actionTexts.some((text) => /\bmanual\s+download\b/i.test(text)),
      requirementsPrompt: requirementContainers.some((element) =>
        /\brequirements?\b/i.test((element as HTMLElement).innerText ?? element.textContent ?? "")
      ),
      downloadOption: actionTexts.some((text) =>
        /\b(?:standard|slow|resumable)\s+download\b/i.test(text)
      ),
      captcha:
        titleText.includes("just a moment") ||
        titleText.includes("请稍候") ||
        bodyText.includes("captcha") ||
        bodyText.includes("verify you are human") ||
        bodyText.includes("checking your browser") ||
        bodyText.includes("cloudflare ray id") ||
        (bodyText.includes("cloudflare") &&
          (bodyText.includes("security verification") || bodyText.length < 1_000)) ||
        document.querySelector('iframe[src*="captcha" i], iframe[src*="challenge" i]') !== null,
      twoFactor:
        bodyText.includes("two-factor") ||
        bodyText.includes("two factor") ||
        bodyText.includes("authentication code") ||
        bodyText.includes("verification code"),
      adultContent:
        bodyText.includes("adult content") &&
        (bodyText.includes("confirm") || bodyText.includes("preferences") || bodyText.includes("settings")),
      cookieConsent:
        (bodyText.includes("cookie") || bodyText.includes("privacy choices")) &&
        actionTexts.some((text) =>
          /^(?:accept(?: all)? cookies?|allow(?: all)? cookies?|agree|continue|manage cookies?|cookie settings)$/.test(
            text
          )
        ),
      rateLimited:
        bodyText.includes("too many requests") ||
        bodyText.includes("rate limit") ||
        bodyText.includes("temporarily blocked"),
      maintenance:
        bodyText.includes("maintenance") ||
        bodyText.includes("temporarily unavailable") ||
        bodyText.includes("service unavailable"),
      notFound: bodyText.includes("page not found") || bodyText.includes("mod not found"),
      accessDenied: bodyText.includes("access denied") || bodyText.includes("permission denied")
    };
  });

  const pathname = url?.pathname.toLowerCase() ?? "";
  const signals: NexusPageSignals = {
    status,
    loginUrl: url?.hostname === "users.nexusmods.com" && /^\/auth\/sign_in\/?$/.test(pathname),
    modFilesUrl:
      url?.hostname === "www.nexusmods.com" &&
      /^\/[^/]+\/mods\/\d+\/?$/.test(pathname) &&
      (url.searchParams.get("tab") === "files" || url.searchParams.has("file_id")),
    requirementsUrl: pathname.includes("requirement"),
    ...dom,
    twoFactor:
      dom.twoFactor ||
      (url?.hostname === "users.nexusmods.com" &&
        /(?:two[_-]?factor|verification|authenticate|otp)/.test(pathname))
  };

  return {
    kind: classifyPageSignals(signals),
    status,
    path: url && url.hostname.endsWith("nexusmods.com") ? url.pathname : null
  };
}
