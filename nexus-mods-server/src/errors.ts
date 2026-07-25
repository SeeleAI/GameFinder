export type NexusErrorCode =
  | "AUTH_MISSING"
  | "AUTH_INVALID"
  | "BROWSER_CLOSED"
  | "BROWSER_LAUNCH_FAILED"
  | "BROWSER_NOT_INSTALLED"
  | "BROWSER_PAGE_UNRESPONSIVE"
  | "BROWSER_PROFILE_BUSY"
  | "LOGIN_REQUIRED"
  | "LOGIN_TIMEOUT"
  | "USER_INTERACTION_REQUIRED"
  | "CAPTCHA_REQUIRED"
  | "TWO_FACTOR_REQUIRED"
  | "COOKIE_CONSENT_REQUIRED"
  | "ADULT_CONTENT_CONFIRMATION_REQUIRED"
  | "NEXUS_RATE_LIMITED"
  | "NEXUS_MAINTENANCE"
  | "MOD_PAGE_NOT_FOUND"
  | "FILE_ROW_NOT_FOUND"
  | "FILE_ROW_AMBIGUOUS"
  | "DOWNLOAD_BUTTON_NOT_FOUND"
  | "DOWNLOAD_START_TIMEOUT"
  | "RESUMABLE_DOWNLOAD_NOT_SUPPORTED"
  | "DOWNLOAD_CANCELED"
  | "DOWNLOAD_SIZE_MISMATCH"
  | "ARCHIVE_INVALID"
  | "DOWNLOAD_BUSY"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "UPSTREAM_SCHEMA_CHANGED"
  | "INVALID_INPUT"
  | "DOWNLOAD_AUTH_REQUIRED"
  | "DOWNLOAD_AUTH_EXPIRED"
  | "DOWNLOAD_FAILED"
  | "OUTPUT_EXISTS"
  | "OUTPUT_FILE_EXISTS"
  | "OUTPUT_PATH_INVALID";

export class NexusError extends Error {
  readonly code: NexusErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: NexusErrorCode,
    message: string,
    options: {
      status?: number;
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "NexusError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.status !== undefined) this.status = options.status;
    if (options.details !== undefined) this.details = options.details;
  }
}

export function asNexusError(error: unknown): NexusError {
  if (error instanceof NexusError) return error;
  return new NexusError("UPSTREAM_ERROR", "Unexpected Nexus Mods server error.", {
    retryable: false,
    cause: error
  });
}
