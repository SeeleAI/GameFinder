import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import type { BrowserConfig } from "../src/browser/browser-config.js";
import type { LoginBrowser } from "../src/browser/nexus-login-controller.js";
import { NexusLoginController } from "../src/browser/nexus-login-controller.js";

interface MutablePageState {
  url: string;
  signals: {
    hasPasswordField: boolean;
    hasLoginForm: boolean;
    loginRequiredText: boolean;
    captchaText: boolean;
    twoFactorText: boolean;
    maintenanceText: boolean;
  };
  navigations: string[];
}

const config: BrowserConfig = {
  profileDir: "C:\\dedicated-profile",
  launchTimeoutMs: 30_000,
  navigationTimeoutMs: 45_000,
  downloadStartTimeoutMs: 120_000,
  downloadTimeoutMs: 0,
  loginWaitMs: 900_000,
  keepOpen: true
};

function createPage(state: MutablePageState): Page {
  return {
    url: () => state.url,
    goto: async (url: string) => {
      state.url = url;
      state.navigations.push(url);
      if (url === "https://www.nexusmods.com/settings/preferences" && state.signals.hasPasswordField) {
        state.url = "https://users.nexusmods.com/auth/sign_in";
      }
      return null;
    },
    evaluate: async () => state.signals
  } as unknown as Page;
}

function createBrowser(page: Page): LoginBrowser {
  return {
    config,
    running: true,
    getPage: async () => page
  };
}

describe("NexusLoginController", () => {
  it("opens the visible sign-in flow when the protected page requires login", async () => {
    const state: MutablePageState = {
      url: "about:blank",
      signals: {
        hasPasswordField: true,
        hasLoginForm: true,
        loginRequiredText: false,
        captchaText: false,
        twoFactorText: false,
        maintenanceText: false
      },
      navigations: []
    };
    const controller = new NexusLoginController(createBrowser(createPage(state)));
    const result = await controller.openLogin("https://www.nexusmods.com/eldenring/mods/9531");

    expect(result).toMatchObject({
      state: "waiting_for_user",
      requiresUserInteraction: true,
      interactionReason: "login"
    });
    expect(result.expiresAt).not.toBeNull();
    expect(state.navigations[0]).toBe("https://www.nexusmods.com/settings/preferences");
  });

  it("detects a completed login and opens the pending canonical mod page", async () => {
    const state: MutablePageState = {
      url: "https://users.nexusmods.com/auth/sign_in",
      signals: {
        hasPasswordField: true,
        hasLoginForm: true,
        loginRequiredText: false,
        captchaText: false,
        twoFactorText: false,
        maintenanceText: false
      },
      navigations: []
    };
    const page = createPage(state);
    const controller = new NexusLoginController(createBrowser(page));
    await controller.openLogin("https://www.nexusmods.com/eldenring/mods/9531");

    state.url = "https://www.nexusmods.com/settings/preferences";
    state.signals = {
      hasPasswordField: false,
      hasLoginForm: false,
      loginRequiredText: false,
      captchaText: false,
      twoFactorText: false,
      maintenanceText: false
    };
    const result = await controller.inspectRunningBrowser();

    expect(result).toMatchObject({ state: "authenticated", requiresUserInteraction: false });
    expect(state.navigations.at(-1)).toBe("https://www.nexusmods.com/eldenring/mods/9531");
  });

  it("accepts the protected account-security redirect as an authenticated session", async () => {
    const state: MutablePageState = {
      url: "https://users.nexusmods.com/account/security",
      signals: {
        hasPasswordField: false,
        hasLoginForm: false,
        loginRequiredText: false,
        captchaText: false,
        twoFactorText: false,
        maintenanceText: false
      },
      navigations: []
    };
    const controller = new NexusLoginController(createBrowser(createPage(state)));
    const result = await controller.inspectRunningBrowser();

    expect(result).toMatchObject({
      state: "authenticated",
      requiresUserInteraction: false,
      interactionReason: null
    });
  });

  it("does not trust the account-security URL when the page contains a login form", async () => {
    const state: MutablePageState = {
      url: "https://users.nexusmods.com/account/security",
      signals: {
        hasPasswordField: true,
        hasLoginForm: true,
        loginRequiredText: true,
        captchaText: false,
        twoFactorText: false,
        maintenanceText: false
      },
      navigations: []
    };
    const controller = new NexusLoginController(createBrowser(createPage(state)));
    const result = await controller.inspectRunningBrowser();

    expect(result).toMatchObject({
      state: "login_required",
      requiresUserInteraction: false,
      interactionReason: null
    });
  });

  it("verifies the protected page when login completes on another Nexus page", async () => {
    const state: MutablePageState = {
      url: "https://users.nexusmods.com/auth/sign_in",
      signals: {
        hasPasswordField: true,
        hasLoginForm: true,
        loginRequiredText: false,
        captchaText: false,
        twoFactorText: false,
        maintenanceText: false
      },
      navigations: []
    };
    const page = createPage(state);
    const controller = new NexusLoginController(createBrowser(page));
    await controller.openLogin();

    state.url = "https://www.nexusmods.com/";
    state.signals = {
      hasPasswordField: false,
      hasLoginForm: false,
      loginRequiredText: false,
      captchaText: false,
      twoFactorText: false,
      maintenanceText: false
    };
    const result = await controller.inspectRunningBrowser();

    expect(result.state).toBe("authenticated");
    expect(state.navigations.at(-1)).toBe("https://www.nexusmods.com/settings/preferences");
  });

  it("does not mistake the unauthenticated protected page for a valid login", async () => {
    const state: MutablePageState = {
      url: "https://www.nexusmods.com/settings/preferences",
      signals: {
        hasPasswordField: false,
        hasLoginForm: false,
        loginRequiredText: true,
        captchaText: false,
        twoFactorText: false,
        maintenanceText: false
      },
      navigations: []
    };
    const controller = new NexusLoginController(createBrowser(createPage(state)));
    const result = await controller.inspectRunningBrowser();
    expect(result).toMatchObject({
      state: "login_required",
      requiresUserInteraction: false,
      interactionReason: null
    });
  });

  it("classifies CAPTCHA as an explicit user interaction", async () => {
    const state: MutablePageState = {
      url: "https://users.nexusmods.com/auth/sign_in",
      signals: {
        hasPasswordField: false,
        hasLoginForm: false,
        loginRequiredText: false,
        captchaText: true,
        twoFactorText: false,
        maintenanceText: false
      },
      navigations: []
    };
    const controller = new NexusLoginController(createBrowser(createPage(state)));
    const result = await controller.inspectRunningBrowser();
    expect(result).toMatchObject({
      state: "waiting_for_user",
      requiresUserInteraction: true,
      interactionReason: "captcha"
    });
  });
});
