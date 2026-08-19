import type { Page } from "playwright";
import { NexusError } from "../errors.js";
import type { BrowserConfig } from "./browser-config.js";

const AUTH_CHECK_URL = "https://www.nexusmods.com/settings/preferences";
const LOGIN_URL = "https://users.nexusmods.com/auth/sign_in";

export type NexusAuthState =
  | "unknown"
  | "checking"
  | "login_required"
  | "waiting_for_user"
  | "authenticated"
  | "authentication_failed";

export type BrowserInteractionReason =
  | "login"
  | "captcha"
  | "two_factor"
  | "adult_content"
  | "cookie_consent"
  | "unknown";

export interface NexusLoginStatus {
  state: NexusAuthState;
  checkedAt: string | null;
  expiresAt: string | null;
  requiresUserInteraction: boolean;
  interactionReason: BrowserInteractionReason | null;
}

export interface LoginBrowser {
  readonly config: BrowserConfig;
  readonly running: boolean;
  getPage(): Promise<Page>;
}

interface PageSignals {
  hasPasswordField: boolean;
  hasLoginForm: boolean;
  loginRequiredText: boolean;
  captchaText: boolean;
  twoFactorText: boolean;
  maintenanceText: boolean;
}

function isNexusHost(hostname: string): boolean {
  return hostname === "nexusmods.com" || hostname.endsWith(".nexusmods.com");
}

function isLoginUrl(url: URL): boolean {
  return url.hostname === "users.nexusmods.com" && /\/auth\/sign_in\/?$/.test(url.pathname);
}

function isProtectedPreferencesUrl(url: URL): boolean {
  return url.hostname === "www.nexusmods.com" && url.pathname.startsWith("/settings/preferences");
}

function isProtectedAccountSecurityUrl(url: URL): boolean {
  return url.hostname === "users.nexusmods.com" && url.pathname.startsWith("/account/security");
}

function currentUrlIsLogin(page: Page): boolean {
  try {
    return isLoginUrl(new URL(page.url()));
  } catch {
    return false;
  }
}

async function readSignals(page: Page): Promise<PageSignals> {
  return page.evaluate(() => {
    const bodyText = (document.body?.innerText ?? "").slice(0, 8_000).toLowerCase();
    const loginForms = Array.from(document.querySelectorAll("form")).filter((form) => {
      const action = (form.getAttribute("action") ?? "").toLowerCase();
      return action.includes("sign_in") || action.includes("login");
    });
    const visibleLoginAction = Array.from(document.querySelectorAll("a[href], button")).some((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) {
        return false;
      }
      const text = ((element as HTMLElement).innerText ?? element.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      const href = element instanceof HTMLAnchorElement ? element.href.toLowerCase() : "";
      return /^(?:log in|login|sign in)$/.test(text) && href.includes("users.nexusmods.com/auth/sign_in");
    });
    return {
      hasPasswordField: document.querySelector('input[type="password"]') !== null,
      hasLoginForm: loginForms.length > 0,
      loginRequiredText:
        visibleLoginAction ||
        bodyText.includes("your session has expired") ||
        bodyText.includes("you have to be logged in") ||
        bodyText.includes("you need to log in") ||
        bodyText.includes("please log in again") ||
        bodyText.includes("please login to continue") ||
        bodyText.includes("sign in to continue"),
      captchaText:
        bodyText.includes("captcha") ||
        bodyText.includes("verify you are human") ||
        bodyText.includes("checking your browser"),
      twoFactorText:
        bodyText.includes("two-factor") ||
        bodyText.includes("two factor") ||
        bodyText.includes("authentication code"),
      maintenanceText: bodyText.includes("maintenance") || bodyText.includes("temporarily unavailable")
    };
  });
}

export class NexusLoginController {
  readonly #browser: LoginBrowser;
  #status: NexusLoginStatus = {
    state: "unknown",
    checkedAt: null,
    expiresAt: null,
    requiresUserInteraction: false,
    interactionReason: null
  };
  #pendingReturnUrl: string | undefined;
  #pendingUntil = 0;

  constructor(browser: LoginBrowser) {
    this.#browser = browser;
  }

  cachedStatus(): NexusLoginStatus {
    return { ...this.#status };
  }

  async inspectRunningBrowser(): Promise<NexusLoginStatus> {
    if (!this.#browser.running) {
      return {
        ...this.#status,
        state: "unknown",
        requiresUserInteraction: false,
        interactionReason: null,
        expiresAt: null
      };
    }

    const page = await this.#browser.getPage();
    let inspected = await this.#inspectPage(page);
    if (
      inspected.state === "unknown" &&
      this.#pendingUntil > Date.now() &&
      this.#isCurrentNexusPageOutsideLogin(page)
    ) {
      await this.#navigate(page, AUTH_CHECK_URL);
      inspected = await this.#inspectPage(page);
    }
    if (inspected.state === "authenticated" && this.#pendingReturnUrl) {
      const returnUrl = this.#pendingReturnUrl;
      this.#pendingReturnUrl = undefined;
      await this.#navigate(page, returnUrl);
    }
    this.#status = inspected;
    return { ...this.#status };
  }

  #isCurrentNexusPageOutsideLogin(page: Page): boolean {
    try {
      const url = new URL(page.url());
      return isNexusHost(url.hostname) && !isLoginUrl(url);
    } catch {
      return false;
    }
  }

  async openLogin(returnToModUrl?: string): Promise<NexusLoginStatus> {
    const page = await this.#browser.getPage();
    this.#status = {
      state: "checking",
      checkedAt: new Date().toISOString(),
      expiresAt: null,
      requiresUserInteraction: false,
      interactionReason: null
    };

    await this.#navigate(page, AUTH_CHECK_URL);
    const authCheck = await this.#inspectPage(page);
    if (authCheck.state === "authenticated") {
      if (returnToModUrl) await this.#navigate(page, returnToModUrl);
      this.#status = authCheck;
      return { ...this.#status };
    }

    this.#pendingReturnUrl = returnToModUrl;
    this.#pendingUntil = Date.now() + this.#browser.config.loginWaitMs;
    const loginUrl = new URL(LOGIN_URL);
    loginUrl.searchParams.set("redirect_url", AUTH_CHECK_URL);
    if (!currentUrlIsLogin(page)) await this.#navigate(page, loginUrl.href);

    const current = await this.#inspectPage(page);
    const interactionReason =
      current.interactionReason === "captcha" || current.interactionReason === "two_factor"
        ? current.interactionReason
        : "login";
    this.#status = {
      state: "waiting_for_user",
      checkedAt: new Date().toISOString(),
      expiresAt: new Date(this.#pendingUntil).toISOString(),
      requiresUserInteraction: true,
      interactionReason
    };
    return { ...this.#status };
  }

  async #navigate(page: Page, url: string): Promise<void> {
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.#browser.config.navigationTimeoutMs
      });
    } catch (error) {
      throw new NexusError("BROWSER_PAGE_UNRESPONSIVE", "The dedicated Chromium could not load the Nexus page.", {
        retryable: true,
        cause: error
      });
    }
  }

  async #inspectPage(page: Page): Promise<NexusLoginStatus> {
    const checkedAt = new Date().toISOString();
    let currentUrl: URL;
    try {
      currentUrl = new URL(page.url());
    } catch {
      return {
        state: "unknown",
        checkedAt,
        expiresAt: null,
        requiresUserInteraction: false,
        interactionReason: null
      };
    }

    if (!isNexusHost(currentUrl.hostname)) {
      return {
        state: "unknown",
        checkedAt,
        expiresAt: null,
        requiresUserInteraction: false,
        interactionReason: null
      };
    }

    let signals: PageSignals;
    try {
      signals = await readSignals(page);
    } catch (error) {
      throw new NexusError("BROWSER_PAGE_UNRESPONSIVE", "The Nexus login page could not be inspected.", {
        retryable: true,
        cause: error
      });
    }

    if (signals.captchaText) {
      return {
        state: "waiting_for_user",
        checkedAt,
        expiresAt: this.#pendingUntil > Date.now() ? new Date(this.#pendingUntil).toISOString() : null,
        requiresUserInteraction: true,
        interactionReason: "captcha"
      };
    }
    if (signals.maintenanceText) {
      return {
        state: "authentication_failed",
        checkedAt,
        expiresAt: null,
        requiresUserInteraction: false,
        interactionReason: null
      };
    }
    if (isProtectedPreferencesUrl(currentUrl)) {
      if (signals.hasPasswordField || signals.hasLoginForm || signals.loginRequiredText) {
        const waiting = this.#pendingUntil > Date.now();
        return {
          state: waiting ? "waiting_for_user" : "login_required",
          checkedAt,
          expiresAt: waiting ? new Date(this.#pendingUntil).toISOString() : null,
          requiresUserInteraction: waiting,
          interactionReason: waiting ? "login" : null
        };
      }
      return {
        state: "authenticated",
        checkedAt,
        expiresAt: null,
        requiresUserInteraction: false,
        interactionReason: null
      };
    }
    if (signals.twoFactorText) {
      return {
        state: "waiting_for_user",
        checkedAt,
        expiresAt: this.#pendingUntil > Date.now() ? new Date(this.#pendingUntil).toISOString() : null,
        requiresUserInteraction: true,
        interactionReason: "two_factor"
      };
    }
    if (isLoginUrl(currentUrl) || signals.hasPasswordField || signals.hasLoginForm || signals.loginRequiredText) {
      const waiting = this.#pendingUntil > Date.now();
      return {
        state: waiting ? "waiting_for_user" : "login_required",
        checkedAt,
        expiresAt: waiting ? new Date(this.#pendingUntil).toISOString() : null,
        requiresUserInteraction: waiting,
        interactionReason: waiting ? "login" : null
      };
    }
    if (isProtectedAccountSecurityUrl(currentUrl)) {
      return {
        state: "authenticated",
        checkedAt,
        expiresAt: null,
        requiresUserInteraction: false,
        interactionReason: null
      };
    }
    if (this.#status.state === "authenticated") {
      return {
        state: "authenticated",
        checkedAt,
        expiresAt: null,
        requiresUserInteraction: false,
        interactionReason: null
      };
    }

    return {
      state: "unknown",
      checkedAt,
      expiresAt: null,
      requiresUserInteraction: false,
      interactionReason: null
    };
  }
}
