import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import type {
  NexusBrowserAutomation
} from "./browser/browser-service.js";
import type {
  BrowserDownloadState,
  BrowserPageDownloadController
} from "./browser/nexus-download-page-controller.js";
import type {
  BrowserInteractionReason,
  NexusAuthState
} from "./browser/nexus-login-controller.js";
import {
  createStagingPath,
  finalizeDownloadedFile,
  removeConfirmedInvalidStaging,
  type DownloadReceipt
} from "./download-verifier.js";
import { NexusError, type NexusErrorCode } from "./errors.js";
import type { NexusModFile } from "./types.js";

interface PublicDownloadError {
  code: NexusErrorCode;
  message: string;
  retryable: boolean;
}

interface BrowserDownloadSession {
  id: string;
  backend: "persistent_chromium";
  domainName: string;
  modId: number;
  canonicalUrl: string;
  file: NexusModFile;
  state: BrowserDownloadState;
  authState: NexusAuthState;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  expiresAt: number;
  requiresUserInteraction: boolean;
  interactionReason?: BrowserInteractionReason;
  outputDirectory?: string;
  stagingPath?: string;
  finalPath?: string;
  receipt?: DownloadReceipt;
  error?: PublicDownloadError;
  controller?: BrowserPageDownloadController;
  task?: Promise<void>;
  cancelRequested: boolean;
}

export interface PreparedBrowserDownload {
  sessionId: string;
  backend: "persistent_chromium";
  state: "prepared";
  mod: {
    domainName: string;
    modId: number;
    canonicalUrl: string;
  };
  file: NexusModFile;
  capability: {
    interactiveNxmAuthorizationRequired: false;
    persistentBrowserLoginRequired: true;
  };
  nexusFilesUrl: string;
  authorizationPageUrl: null;
  expiresAt: string;
}

export interface BrowserDownloadStatus {
  sessionId: string;
  backend: "persistent_chromium";
  state: BrowserDownloadState;
  authState: NexusAuthState;
  requiresUserInteraction: boolean;
  interactionReason: BrowserInteractionReason | null;
  mod: {
    domainName: string;
    modId: number;
    canonicalUrl: string;
  };
  file: NexusModFile;
  outputDirectory: string | null;
  stagingPath: string | null;
  finalPath: string | null;
  receipt: DownloadReceipt | null;
  error: PublicDownloadError | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
}

const ACTIVE_STATES = new Set<BrowserDownloadState>([
  "checking_login",
  "navigating",
  "locating_file",
  "handling_requirements",
  "waiting_download_option",
  "waiting_slow_download",
  "downloading",
  "verifying"
]);

function publicError(error: NexusError): PublicDownloadError {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable
  };
}

function interactionForError(error: NexusError): BrowserInteractionReason | undefined {
  if (error.code === "LOGIN_REQUIRED") return "login";
  if (error.code === "CAPTCHA_REQUIRED") return "captcha";
  if (
    error.code === "ADULT_CONTENT_CONFIRMATION_REQUIRED" ||
    error.code === "USER_INTERACTION_REQUIRED" ||
    error.code === "RESUMABLE_DOWNLOAD_NOT_SUPPORTED"
  ) {
    return "unknown";
  }
  return undefined;
}

export class BrowserDownloadManager {
  readonly #browser: NexusBrowserAutomation;
  readonly #sessions = new Map<string, BrowserDownloadSession>();
  #activeSessionId: string | undefined;
  #closed = false;

  constructor(browser: NexusBrowserAutomation) {
    this.#browser = browser;
  }

  prepare(input: {
    domainName: string;
    modId: number;
    canonicalUrl: string;
    file: NexusModFile;
  }): PreparedBrowserDownload {
    if (this.#closed) throw new NexusError("BROWSER_CLOSED", "The browser download manager is closed.");
    const id = randomUUID();
    const now = Date.now();
    const session: BrowserDownloadSession = {
      id,
      backend: "persistent_chromium",
      domainName: input.domainName,
      modId: input.modId,
      canonicalUrl: input.canonicalUrl,
      file: input.file,
      state: "prepared",
      authState: "unknown",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 15 * 60_000,
      requiresUserInteraction: false,
      cancelRequested: false
    };
    this.#sessions.set(id, session);
    return {
      sessionId: id,
      backend: "persistent_chromium",
      state: "prepared",
      mod: {
        domainName: input.domainName,
        modId: input.modId,
        canonicalUrl: input.canonicalUrl
      },
      file: input.file,
      capability: {
        interactiveNxmAuthorizationRequired: false,
        persistentBrowserLoginRequired: true
      },
      nexusFilesUrl: `https://www.nexusmods.com/${input.domainName}/mods/${input.modId}?tab=files&file_id=${input.file.fileId}`,
      authorizationPageUrl: null,
      expiresAt: new Date(session.expiresAt).toISOString()
    };
  }

  status(sessionId: string): BrowserDownloadStatus {
    const session = this.#getSession(sessionId);
    if (
      session.expiresAt <= Date.now() &&
      !ACTIVE_STATES.has(session.state) &&
      !["completed", "canceled"].includes(session.state)
    ) {
      throw new NexusError("DOWNLOAD_AUTH_EXPIRED", "Browser download session expired. Prepare it again.");
    }
    return this.#publicStatus(session);
  }

  async start(sessionId: string, outputDirectory: string): Promise<BrowserDownloadStatus> {
    const session = this.#getSession(sessionId);
    if (this.#closed) throw new NexusError("BROWSER_CLOSED", "The browser download manager is closed.");
    if (session.expiresAt <= Date.now()) {
      throw new NexusError("DOWNLOAD_AUTH_EXPIRED", "Browser download session expired. Prepare it again.");
    }
    if (this.#activeSessionId && this.#activeSessionId !== sessionId) {
      throw new NexusError("DOWNLOAD_BUSY", "Another persistent Chromium download is active.", {
        retryable: true
      });
    }
    if (session.task || ACTIVE_STATES.has(session.state)) {
      throw new NexusError("DOWNLOAD_BUSY", "This persistent Chromium download is already active.", {
        retryable: true
      });
    }
    if (!["prepared", "login_required", "waiting_for_user", "user_interaction_required"].includes(session.state)) {
      throw new NexusError("INVALID_INPUT", `Browser download session is ${session.state}, not startable.`);
    }

    const staging = await createStagingPath({
      outputDirectory,
      sessionId,
      preferredFileName: session.file.fileName
    });
    session.outputDirectory = staging.outputDirectory;
    session.stagingPath = staging.stagingPath;
    session.cancelRequested = false;
    delete session.error;
    session.requiresUserInteraction = false;
    delete session.interactionReason;
    session.startedAt ??= Date.now();
    this.#setState(session, "checking_login");
    this.#activeSessionId = sessionId;
    const task = this.#run(session);
    session.task = task;
    void task.finally(() => {
      delete session.task;
      delete session.controller;
      if (this.#activeSessionId === session.id) this.#activeSessionId = undefined;
    });
    return this.#publicStatus(session);
  }

  async cancel(sessionId: string): Promise<BrowserDownloadStatus> {
    const session = this.#getSession(sessionId);
    if (session.state === "completed" || session.state === "canceled") return this.#publicStatus(session);
    if (session.state === "verifying") {
      throw new NexusError("DOWNLOAD_BUSY", "Final verification has already started and cannot be canceled safely.", {
        retryable: true
      });
    }
    session.cancelRequested = true;
    if (session.controller) await session.controller.cancel();
    const activeTask = session.task;
    if (activeTask) {
      await activeTask;
    } else {
      await this.#cleanupStaging(session, true);
      this.#setState(session, "canceled");
      session.error = publicError(new NexusError("DOWNLOAD_CANCELED", "Browser download was canceled."));
    }
    return this.#publicStatus(session);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const active = [...this.#sessions.values()].filter((session) => session.task);
    await Promise.all(active.map(async (session) => {
      session.cancelRequested = true;
      await session.controller?.cancel().catch(() => undefined);
    }));
    await Promise.allSettled(active.map((session) => session.task as Promise<void>));
    this.#sessions.clear();
    this.#activeSessionId = undefined;
  }

  async #run(session: BrowserDownloadSession): Promise<void> {
    try {
      const controller = await this.#browser.createDownloadController(
        {
          domainName: session.domainName,
          modId: session.modId,
          fileId: session.file.fileId
        },
        (state) => {
          this.#applyControllerState(session, state);
        }
      );
      session.controller = controller;
      if (session.cancelRequested) {
        await controller.cancel();
        throw new NexusError("DOWNLOAD_CANCELED", "Browser download was canceled.");
      }
      const result = await controller.run({
        domainName: session.domainName,
        modId: session.modId,
        fileId: session.file.fileId,
        fileName: session.file.fileName,
        saveAsPath: session.stagingPath as string
      });
      if (session.cancelRequested) {
        await removeConfirmedInvalidStaging(session.stagingPath as string);
        throw new NexusError("DOWNLOAD_CANCELED", "Browser download was canceled.");
      }
      this.#setState(session, "verifying");
      const receipt = await finalizeDownloadedFile({
        backend: "persistent_chromium",
        canonicalModUrl: session.canonicalUrl,
        domainName: session.domainName,
        modId: session.modId,
        fileId: session.file.fileId,
        expectedSizeInBytes: session.file.sizeInBytes,
        outputDirectory: session.outputDirectory as string,
        stagingPath: session.stagingPath as string,
        suggestedFileName: result.suggestedFilename,
        apiFileName: session.file.fileName
      });
      session.receipt = receipt;
      session.finalPath = receipt.absolutePath;
      delete session.stagingPath;
      session.completedAt = Date.now();
      session.authState = "authenticated";
      session.requiresUserInteraction = false;
      delete session.interactionReason;
      delete session.error;
      this.#setState(session, "completed");
    } catch (unknownError) {
      const error =
        unknownError instanceof NexusError
          ? unknownError
          : new NexusError("DOWNLOAD_FAILED", "Browser download failed before completion.", {
              retryable: true,
              cause: unknownError
            });
      if (session.cancelRequested || error.code === "DOWNLOAD_CANCELED") {
        await this.#cleanupStaging(session, true);
        this.#setState(session, "canceled");
        session.error = publicError(new NexusError("DOWNLOAD_CANCELED", "Browser download was canceled."));
        return;
      }

      const interactionReason = interactionForError(error);
      if (interactionReason) {
        await this.#cleanupStaging(session, true);
        session.requiresUserInteraction = true;
        session.interactionReason = interactionReason;
        session.authState = error.code === "LOGIN_REQUIRED" ? "login_required" : session.authState;
        this.#setState(session, error.code === "LOGIN_REQUIRED" ? "login_required" : "user_interaction_required");
      } else {
        if (error.code === "DOWNLOAD_SIZE_MISMATCH" || error.code === "ARCHIVE_INVALID") {
          await this.#cleanupStaging(session, true);
        } else {
          await this.#cleanupStaging(session, false);
        }
        this.#setState(session, "failed");
      }
      session.error = publicError(error);
    }
  }

  #applyControllerState(session: BrowserDownloadSession, state: BrowserDownloadState): void {
    if (session.cancelRequested) return;
    if (state === "locating_file") session.authState = "authenticated";
    if (state === "login_required") {
      session.authState = "login_required";
      session.requiresUserInteraction = true;
      session.interactionReason = "login";
    }
    if (state === "user_interaction_required") session.requiresUserInteraction = true;
    this.#setState(session, state);
  }

  #setState(session: BrowserDownloadSession, state: BrowserDownloadState): void {
    session.state = state;
    session.updatedAt = Date.now();
  }

  async #cleanupStaging(session: BrowserDownloadSession, confirmedInvalid: boolean): Promise<void> {
    if (!session.stagingPath) return;
    if (confirmedInvalid) {
      await removeConfirmedInvalidStaging(session.stagingPath);
      delete session.stagingPath;
      return;
    }
    try {
      const info = await stat(session.stagingPath);
      if (info.size === 0) {
        await rm(session.stagingPath, { force: true });
        delete session.stagingPath;
      }
    } catch {
      delete session.stagingPath;
    }
  }

  #getSession(sessionId: string): BrowserDownloadSession {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new NexusError("NOT_FOUND", "Browser download session was not found.");
    return session;
  }

  #publicStatus(session: BrowserDownloadSession): BrowserDownloadStatus {
    return {
      sessionId: session.id,
      backend: "persistent_chromium",
      state: session.state,
      authState: session.authState,
      requiresUserInteraction: session.requiresUserInteraction,
      interactionReason: session.interactionReason ?? null,
      mod: {
        domainName: session.domainName,
        modId: session.modId,
        canonicalUrl: session.canonicalUrl
      },
      file: session.file,
      outputDirectory: session.outputDirectory ?? null,
      stagingPath: session.stagingPath ?? null,
      finalPath: session.finalPath ?? null,
      receipt: session.receipt ?? null,
      error: session.error ?? null,
      createdAt: new Date(session.createdAt).toISOString(),
      updatedAt: new Date(session.updatedAt).toISOString(),
      startedAt: session.startedAt === undefined ? null : new Date(session.startedAt).toISOString(),
      completedAt: session.completedAt === undefined ? null : new Date(session.completedAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString()
    };
  }
}
