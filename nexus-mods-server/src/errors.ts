export type NexusErrorCode =
  | "AUTH_MISSING"
  | "AUTH_INVALID"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "UPSTREAM_SCHEMA_CHANGED"
  | "INVALID_INPUT"
  | "DOWNLOAD_AUTH_REQUIRED"
  | "DOWNLOAD_AUTH_EXPIRED"
  | "DOWNLOAD_FAILED"
  | "OUTPUT_EXISTS";

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
