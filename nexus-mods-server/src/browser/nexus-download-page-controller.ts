import path from "node:path";
import type { Download, Locator, Page, Response } from "playwright";
import { NexusError } from "../errors.js";
import type { BrowserConfig } from "./browser-config.js";
import { classifyNexusPage, type NexusPageClassification } from "./page-classifier.js";
import {
  fileContainerSelectors,
  fileReferenceSelector,
  manualDownloadAction,
  REQUIREMENTS_CONTAINER_SELECTORS,
  requirementsContinueAction,
  resumableDownloadAction,
  slowDownloadAction,
  standardDownloadAction,
  type NexusLocatorScope
} from "./nexus-selectors.js";

export type BrowserDownloadState =
  | "prepared"
  | "checking_login"
  | "login_required"
  | "waiting_for_user"
  | "navigating"
  | "locating_file"
  | "handling_requirements"
  | "waiting_download_option"
  | "waiting_slow_download"
  | "downloading"
  | "verifying"
  | "completed"
  | "user_interaction_required"
  | "failed"
  | "canceled";

export interface BrowserPageDownloadInput {
  domainName: string;
  modId: number;
  fileId: number;
  fileName: string;
  saveAsPath: string;
}

export interface BrowserPageDownloadResult {
  state: "verifying";
  suggestedFilename: string;
  savedPath: string;
  sourcePage: string;
}

export type BrowserDownloadStateListener = (state: BrowserDownloadState) => void;

export interface BrowserPageDownloadController {
  readonly state: BrowserDownloadState;
  run(input: BrowserPageDownloadInput): Promise<BrowserPageDownloadResult>;
  cancel(): Promise<void>;
}

function isPlaywrightTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildNexusFileUrl(input: {
  domainName: string;
  modId: number;
  fileId: number;
}): string {
  const domainName = input.domainName.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(domainName)) {
    throw new NexusError("INVALID_INPUT", "The Nexus game domain is invalid.");
  }
  if (!Number.isSafeInteger(input.modId) || input.modId <= 0) {
    throw new NexusError("INVALID_INPUT", "The Nexus modId must be a positive integer.");
  }
  if (!Number.isSafeInteger(input.fileId) || input.fileId <= 0) {
    throw new NexusError("INVALID_INPUT", "The Nexus fileId must be a positive integer.");
  }
  const url = new URL(`https://www.nexusmods.com/${domainName}/mods/${input.modId}`);
  url.searchParams.set("tab", "files");
  url.searchParams.set("file_id", String(input.fileId));
  return url.href;
}

export class NexusDownloadPageController implements BrowserPageDownloadController {
  readonly #page: Page;
  readonly #config: BrowserConfig;
  readonly #onState: BrowserDownloadStateListener | undefined;
  #state: BrowserDownloadState = "prepared";
  #running = false;
  #abortController: AbortController | undefined;
  #activeDownload: Download | undefined;
  #observedDownload: Download | undefined;
  #downloadPromise: Promise<Download> | undefined;
  #downloadListener: ((download: Download) => void) | undefined;

  constructor(page: Page, config: BrowserConfig, onState?: BrowserDownloadStateListener) {
    this.#page = page;
    this.#config = config;
    this.#onState = onState;
  }

  get state(): BrowserDownloadState {
    return this.#state;
  }

  async run(input: BrowserPageDownloadInput): Promise<BrowserPageDownloadResult> {
    if (this.#running) {
      throw new NexusError("DOWNLOAD_BUSY", "This browser page already has an active download workflow.", {
        retryable: true
      });
    }
    if (!path.isAbsolute(input.saveAsPath)) {
      throw new NexusError("OUTPUT_PATH_INVALID", "The browser staging path must be absolute.");
    }

    const targetUrl = buildNexusFileUrl(input);
    this.#running = true;
    this.#abortController = new AbortController();
    this.#activeDownload = undefined;
    this.#observedDownload = undefined;

    try {
      this.#transition("checking_login");
      this.#transition("navigating");
      const response = await this.#navigate(targetUrl);
      await this.#assertPageCanContinue(await classifyNexusPage(this.#page, response));

      this.#transition("locating_file");
      await this.#waitForFileSignal(input);
      await this.#assertPageCanContinue(await classifyNexusPage(this.#page));
      const fileScope = await this.#locateFileScope(input);
      const manual = await this.#requireUniqueAction(
        manualDownloadAction(fileScope),
        "FILE_ROW_AMBIGUOUS",
        "The target file does not have one unique Manual Download action."
      );

      this.#startDownloadObserver();
      this.#transition("waiting_download_option");
      await this.#clickAction(manual, "The target Manual Download action could not be used.");

      for (let step = 0; step < 8; step += 1) {
        const observedDownload = await this.#waitForDecision();
        if (observedDownload) return await this.#saveCapturedDownload(observedDownload, input.saveAsPath);
        const classification = await classifyNexusPage(this.#page);
        await this.#assertPageCanContinue(classification);

        const standard = standardDownloadAction(this.#page);
        const standardCount = await standard.count();
        if (standardCount > 1) {
          throw new NexusError("DOWNLOAD_BUTTON_NOT_FOUND", "Multiple Standard Download actions are visible.");
        }
        if (standardCount === 1) {
          this.#transition("waiting_download_option");
          await this.#clickAction(standard, "The Standard Download action could not be used.");
          continue;
        }

        const slow = slowDownloadAction(this.#page);
        const slowCount = await slow.count();
        if (slowCount > 1) {
          throw new NexusError("DOWNLOAD_BUTTON_NOT_FOUND", "Multiple Slow Download actions are visible.");
        }
        if (slowCount === 1) {
          this.#transition("waiting_slow_download");
          return await this.#captureDownload(slow, input.saveAsPath);
        }

        const requirements = await this.#findRequirementsAction();
        if (requirements) {
          this.#transition("handling_requirements");
          await this.#clickAction(requirements, "The Requirements confirmation action could not be used.");
          this.#transition("waiting_download_option");
          continue;
        }

        const resumableCount = await resumableDownloadAction(this.#page).count();
        if (resumableCount > 0) {
          throw new NexusError(
            "RESUMABLE_DOWNLOAD_NOT_SUPPORTED",
            "Only Resumable Download is available; the persistent Chromium MVP supports Standard Download only.",
            { details: { requiresUserInteraction: true } }
          );
        }

        throw new NexusError(
          "DOWNLOAD_BUTTON_NOT_FOUND",
          "No supported Requirements, Standard Download, or Slow Download action is visible.",
          { retryable: true }
        );
      }

      throw new NexusError("DOWNLOAD_BUTTON_NOT_FOUND", "The Nexus download page did not reach a stable download action.", {
        retryable: true
      });
    } catch (error) {
      if (this.#abortController.signal.aborted || (error instanceof NexusError && error.code === "DOWNLOAD_CANCELED")) {
        this.#transition("canceled");
        if (error instanceof NexusError && error.code === "DOWNLOAD_CANCELED") throw error;
        throw new NexusError("DOWNLOAD_CANCELED", "The browser download workflow was canceled.");
      }
      if (error instanceof NexusError) {
        if (error.code === "LOGIN_REQUIRED") {
          this.#transition("login_required");
        } else if (
          [
            "CAPTCHA_REQUIRED",
            "ADULT_CONTENT_CONFIRMATION_REQUIRED",
            "USER_INTERACTION_REQUIRED",
            "RESUMABLE_DOWNLOAD_NOT_SUPPORTED"
          ].includes(error.code)
        ) {
          this.#transition("user_interaction_required");
        } else {
          this.#transition("failed");
        }
        throw error;
      }
      this.#transition("failed");
      throw new NexusError("DOWNLOAD_FAILED", "The Nexus browser download workflow failed.", {
        retryable: true,
        cause: error
      });
    } finally {
      this.#stopDownloadObserver();
      this.#running = false;
      this.#activeDownload = undefined;
      this.#observedDownload = undefined;
      this.#downloadPromise = undefined;
      this.#abortController = undefined;
    }
  }

  async cancel(): Promise<void> {
    if (!this.#running || !this.#abortController) return;
    this.#abortController.abort();
    if (this.#activeDownload) await this.#activeDownload.cancel();
  }

  async #navigate(url: string): Promise<Response | null> {
    try {
      return await this.#withCancellation(
        this.#page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: this.#config.navigationTimeoutMs
        })
      );
    } catch (error) {
      if (error instanceof NexusError) throw error;
      throw new NexusError("BROWSER_PAGE_UNRESPONSIVE", "The exact Nexus file page could not be loaded.", {
        retryable: true,
        cause: error
      });
    }
  }

  async #waitForFileSignal(input: BrowserPageDownloadInput): Promise<void> {
    try {
      await this.#withCancellation(
        this.#page.waitForFunction(
          ({ fileId, fileName }) => {
            const id = String(fileId);
            if (
              document.querySelector(
                `[data-fileid="${CSS.escape(id)}"], [data-file-id="${CSS.escape(id)}"], [data-id="${CSS.escape(id)}"]`
              )
            ) {
              return true;
            }
            const links = Array.from(document.querySelectorAll("a[href]"));
            if (
              links.some((link) => {
                const href = link.getAttribute("href") ?? "";
                return href.includes(`file_id=${id}`) || href.includes(`/files/${id}`);
              })
            ) {
              return true;
            }
            if (fileName && (document.body?.innerText ?? "").includes(fileName)) return true;
            const current = new URL(location.href);
            const preciseFile = current.searchParams.get("file_id") === id;
            const manual = Array.from(document.querySelectorAll("button, a, [role='button']")).some((element) =>
              /\bmanual\s+download\b/i.test(element.textContent ?? "")
            );
            return preciseFile && manual;
          },
          { fileId: input.fileId, fileName: input.fileName },
          { timeout: this.#config.navigationTimeoutMs }
        )
      );
    } catch (error) {
      if (error instanceof NexusError) throw error;
      if (isPlaywrightTimeout(error)) {
        const classification = await classifyNexusPage(this.#page);
        await this.#assertPageCanContinue(classification);
        throw new NexusError("FILE_ROW_NOT_FOUND", `Nexus fileId ${input.fileId} was not found on the files page.`, {
          retryable: true
        });
      }
      throw error;
    }
  }

  async #locateFileScope(input: BrowserPageDownloadInput): Promise<NexusLocatorScope> {
    for (const selector of fileContainerSelectors(input.fileId)) {
      const containers = this.#page.locator(selector);
      const count = await containers.count();
      if (count > 1) {
        throw new NexusError("FILE_ROW_AMBIGUOUS", `Multiple containers claim Nexus fileId ${input.fileId}.`);
      }
      if (count === 1) return containers;
    }

    const references = this.#page.locator(fileReferenceSelector(input.fileId));
    const referenceCount = await references.count();
    if (referenceCount > 1) {
      throw new NexusError("FILE_ROW_AMBIGUOUS", `Multiple page references claim Nexus fileId ${input.fileId}.`);
    }
    if (referenceCount === 1) {
      const ancestor = references.locator(
        "xpath=ancestor::*[self::article or self::li or @data-fileid or @data-file-id or contains(@class, 'file')][1]"
      );
      const ancestorCount = await ancestor.count();
      if (ancestorCount === 1) return ancestor;
    }

    if (input.fileName.trim() !== "") {
      const name = new RegExp(escapeRegExp(input.fileName.trim()), "i");
      for (const selector of [
        "[data-file-name]",
        "article",
        "li",
        '[class*="file-row" i]',
        '[class*="file-expander" i]'
      ]) {
        const containers = this.#page.locator(selector).filter({ hasText: name });
        const withManual = containers.filter({ has: manualDownloadAction(this.#page) });
        const count = await withManual.count();
        if (count > 1) {
          throw new NexusError("FILE_ROW_AMBIGUOUS", "The API filename matches multiple downloadable file containers.");
        }
        if (count === 1) return withManual;
      }
    }

    const current = new URL(this.#page.url());
    const manual = manualDownloadAction(this.#page);
    const manualCount = await manual.count();
    if (current.searchParams.get("file_id") === String(input.fileId) && manualCount === 1) return this.#page;
    if (manualCount > 1) {
      throw new NexusError(
        "FILE_ROW_AMBIGUOUS",
        "The precise file page contains multiple Manual Download actions without a unique file container."
      );
    }
    throw new NexusError("FILE_ROW_NOT_FOUND", `Nexus fileId ${input.fileId} could not be uniquely located.`);
  }

  async #findRequirementsAction(): Promise<Locator | null> {
    for (const selector of REQUIREMENTS_CONTAINER_SELECTORS) {
      const containers = this.#page.locator(selector);
      const actions = requirementsContinueAction(containers);
      const count = await actions.count();
      if (count > 1) {
        throw new NexusError("DOWNLOAD_BUTTON_NOT_FOUND", "Multiple Requirements confirmation actions are visible.");
      }
      if (count === 1) return actions;
    }

    let requirementsUrl = false;
    try {
      requirementsUrl = new URL(this.#page.url()).pathname.toLowerCase().includes("requirement");
    } catch {
      requirementsUrl = false;
    }
    if (requirementsUrl) {
      const action = requirementsContinueAction(this.#page);
      const count = await action.count();
      if (count > 1) {
        throw new NexusError("DOWNLOAD_BUTTON_NOT_FOUND", "The Requirements page has multiple continue actions.");
      }
      if (count === 1) return action;
    }
    return null;
  }

  async #waitForDecision(): Promise<Download | null> {
    try {
      const decision = this.#page
        .waitForFunction(
          () => {
            const visible = (element: Element): boolean => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
            };
            const body = (document.body?.innerText ?? "").slice(0, 12_000).toLowerCase();
            if (
              body.includes("checking your browser") ||
              body.includes("cloudflare ray id") ||
              (body.includes("cloudflare") && body.length < 1_000) ||
              body.includes("verify you are human") ||
              body.includes("captcha") ||
              body.includes("adult content") ||
              body.includes("too many requests") ||
              body.includes("maintenance")
            ) {
              return true;
            }
            const actions = Array.from(document.querySelectorAll("button, a, [role='button']"))
              .filter(visible)
              .map((element) =>
                ((element as HTMLElement).innerText ?? element.textContent ?? "").replace(/\s+/g, " ").trim()
              );
            if (
              actions.some((text) =>
                /\b(?:standard|slow|resumable)\s+download\b/i.test(text)
              )
            ) {
              return true;
            }
            return Array.from(
              document.querySelectorAll(
                '[role="dialog"][aria-modal="true"], [data-testid*="requirement" i], [data-test*="requirement" i], [class*="requirement" i]'
              )
            ).some(
              (element) =>
                visible(element) &&
                /\brequirements?\b/i.test((element as HTMLElement).innerText ?? element.textContent ?? "")
            );
          },
          undefined,
          { timeout: this.#config.downloadStartTimeoutMs }
        )
        .then(() => ({ kind: "decision" as const }));
      const download = this.#requireDownloadPromise().then((value) => ({
        kind: "download" as const,
        download: value
      }));
      const outcome = await this.#withCancellation(
        Promise.race([
          download,
          decision
        ])
      );
      return outcome.kind === "download" ? outcome.download : null;
    } catch (error) {
      if (error instanceof NexusError) throw error;
      if (isPlaywrightTimeout(error)) {
        throw new NexusError(
          "DOWNLOAD_BUTTON_NOT_FOUND",
          "Nexus did not present a supported download decision in time.",
          { retryable: true }
        );
      }
      throw error;
    }
  }

  async #captureDownload(action: Locator, saveAsPath: string): Promise<BrowserPageDownloadResult> {
    await this.#clickAction(action, "The Slow Download action did not become available.");

    let download: Download;
    try {
      download = await this.#awaitObservedDownload();
    } catch (error) {
      if (error instanceof NexusError) throw error;
      if (isPlaywrightTimeout(error)) {
        throw new NexusError("DOWNLOAD_START_TIMEOUT", "Nexus did not start a browser download in time.", {
          retryable: true
        });
      }
      throw new NexusError("DOWNLOAD_FAILED", "The browser download event failed.", {
        retryable: true,
        cause: error
      });
    }

    return this.#saveCapturedDownload(download, saveAsPath);
  }

  async #awaitObservedDownload(): Promise<Download> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await this.#withCancellation(
        Promise.race([
          this.#requireDownloadPromise(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(
                new NexusError("DOWNLOAD_START_TIMEOUT", "Nexus did not start a browser download in time.", {
                  retryable: true
                })
              );
            }, this.#config.downloadStartTimeoutMs);
          })
        ])
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #startDownloadObserver(): void {
    if (this.#downloadPromise) return;
    let resolveDownload: ((download: Download) => void) | undefined;
    this.#downloadPromise = new Promise<Download>((resolve) => {
      resolveDownload = resolve;
    });
    this.#downloadListener = (download: Download): void => {
      if (this.#observedDownload) return;
      this.#observedDownload = download;
      resolveDownload?.(download);
    };
    this.#page.on("download", this.#downloadListener);
  }

  #stopDownloadObserver(): void {
    if (this.#downloadListener) this.#page.off("download", this.#downloadListener);
    this.#downloadListener = undefined;
  }

  #requireDownloadPromise(): Promise<Download> {
    if (!this.#downloadPromise) {
      throw new NexusError("DOWNLOAD_FAILED", "The browser download observer was not initialized.");
    }
    return this.#downloadPromise;
  }

  async #saveCapturedDownload(download: Download, saveAsPath: string): Promise<BrowserPageDownloadResult> {
    this.#activeDownload = download;
    this.#throwIfCanceled();
    this.#transition("downloading");
    try {
      await this.#saveDownload(download, saveAsPath);
      const failure = await download.failure();
      if (failure) {
        throw new NexusError("DOWNLOAD_FAILED", "Chromium reported that the Nexus download failed.", {
          retryable: true
        });
      }
    } catch (error) {
      if (error instanceof NexusError) throw error;
      throw new NexusError("DOWNLOAD_FAILED", "Chromium could not save the Nexus download to staging.", {
        retryable: true,
        cause: error
      });
    }

    this.#transition("verifying");
    return {
      state: "verifying",
      suggestedFilename: download.suggestedFilename(),
      savedPath: saveAsPath,
      sourcePage: new URL(this.#page.url()).pathname
    };
  }

  async #saveDownload(download: Download, saveAsPath: string): Promise<void> {
    const operation = this.#withCancellation(download.saveAs(saveAsPath));
    if (this.#config.downloadTimeoutMs === 0) {
      await operation;
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new NexusError("DOWNLOAD_FAILED", "The browser download exceeded the configured transfer timeout.", {
                retryable: true
              })
            );
          }, this.#config.downloadTimeoutMs);
        })
      ]);
    } catch (error) {
      await download.cancel();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #clickAction(action: Locator, message: string): Promise<void> {
    this.#throwIfCanceled();
    try {
      await this.#waitForActionReady(action, message);
      await this.#withCancellation(action.click({ timeout: this.#config.downloadStartTimeoutMs }));
    } catch (error) {
      if (error instanceof NexusError) throw error;
      throw new NexusError("DOWNLOAD_BUTTON_NOT_FOUND", message, {
        retryable: true,
        cause: error
      });
    }
  }

  async #waitForActionReady(action: Locator, message: string): Promise<void> {
    const deadline = Date.now() + this.#config.downloadStartTimeoutMs;
    while (Date.now() < deadline) {
      this.#throwIfCanceled();
      if ((await action.isVisible()) && (await action.isEnabled())) return;
      await this.#withCancellation(
        new Promise<void>((resolve) => {
          setTimeout(resolve, 100);
        })
      );
    }
    throw new NexusError("DOWNLOAD_BUTTON_NOT_FOUND", message, { retryable: true });
  }

  async #requireUniqueAction(
    action: Locator,
    duplicateCode: "FILE_ROW_AMBIGUOUS" | "DOWNLOAD_BUTTON_NOT_FOUND",
    message: string
  ): Promise<Locator> {
    const count = await action.count();
    if (count === 0) {
      throw new NexusError("DOWNLOAD_BUTTON_NOT_FOUND", message, { retryable: true });
    }
    if (count > 1) throw new NexusError(duplicateCode, message);
    return action;
  }

  async #assertPageCanContinue(classification: NexusPageClassification): Promise<void> {
    const details = {
      pageKind: classification.kind,
      requiresUserInteraction: ["captcha", "adult_content", "access_denied"].includes(classification.kind)
    };
    switch (classification.kind) {
      case "captcha":
        throw new NexusError("CAPTCHA_REQUIRED", "Complete the browser verification in the visible Chromium window.", {
          retryable: true,
          details
        });
      case "adult_content":
        throw new NexusError(
          "ADULT_CONTENT_CONFIRMATION_REQUIRED",
          "Update the Nexus adult-content preference in the visible Chromium window.",
          { retryable: true, details }
        );
      case "rate_limited":
        throw new NexusError("NEXUS_RATE_LIMITED", "Nexus temporarily rate-limited the browser page.", {
          retryable: true,
          details
        });
      case "maintenance":
        throw new NexusError("NEXUS_MAINTENANCE", "Nexus is temporarily unavailable for maintenance.", {
          retryable: true,
          details
        });
      case "not_found":
        throw new NexusError("MOD_PAGE_NOT_FOUND", "The Nexus Mod or file page was not found.", { details });
      case "access_denied":
        throw new NexusError(
          "USER_INTERACTION_REQUIRED",
          "Nexus denied access to the file page; inspect the visible Chromium window.",
          { retryable: true, details }
        );
      case "login":
        this.#transition("login_required");
        throw new NexusError("LOGIN_REQUIRED", "The dedicated Nexus Chromium Profile must be logged in.", {
          retryable: true,
          details: { ...details, requiresUserInteraction: true }
        });
      case "mod_files":
      case "requirements":
      case "download_options":
      case "unknown":
        return;
    }
  }

  #transition(state: BrowserDownloadState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#onState?.(state);
  }

  #throwIfCanceled(): void {
    if (this.#abortController?.signal.aborted) {
      throw new NexusError("DOWNLOAD_CANCELED", "The browser download workflow was canceled.");
    }
  }

  async #withCancellation<T>(operation: Promise<T>): Promise<T> {
    const signal = this.#abortController?.signal;
    if (!signal) return operation;
    if (signal.aborted) throw new NexusError("DOWNLOAD_CANCELED", "The browser download workflow was canceled.");

    let rejectCancellation: ((error: NexusError) => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const onAbort = (): void => {
      rejectCancellation?.(new NexusError("DOWNLOAD_CANCELED", "The browser download workflow was canceled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([operation, cancellation]);
    } catch (error) {
      if (signal.aborted) void operation.catch(() => undefined);
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
