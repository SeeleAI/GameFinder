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

export type InstallErrorCode =
  | "INPUT_RECEIPT_MISMATCH"
  | "ARCHIVE_UNSUPPORTED"
  | "ARCHIVE_UNSAFE"
  | "ARCHIVE_LIMIT_EXCEEDED"
  | "GAME_PROFILE_NOT_FOUND"
  | "GAME_INSTANCE_NOT_FOUND"
  | "GAME_INSTANCE_AMBIGUOUS"
  | "ADAPTER_NOT_FOUND"
  | "ADAPTER_AMBIGUOUS"
  | "DEPENDENCY_MISSING"
  | "INSTALL_CONFLICT"
  | "PROTECTED_PATH"
  | "GAME_PROCESS_RUNNING"
  | "PLAN_STALE"
  | "LOCK_BUSY"
  | "INSUFFICIENT_SPACE"
  | "APPLY_FAILED"
  | "VERIFY_FAILED"
  | "ROLLBACK_FAILED"
  | "RECOVERY_REQUIRED"
  | "INSTALLATION_DIRTY"
  | "DEPENDENTS_EXIST"
  | "OWNERSHIP_CONFLICT"
  | "BACKUP_MISSING"
  | "UNINSTALL_BLOCKED"
  | "INSTALL_CONTRACT_INVALID";

export type ServerErrorCode = NexusErrorCode | InstallErrorCode;

export class NexusError extends Error {
  readonly code: ServerErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ServerErrorCode,
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
