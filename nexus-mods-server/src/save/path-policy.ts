import path from "node:path";
import { NexusError } from "../errors.js";

const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const CONTROL_OR_BIDI =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function pathApi(
  platform: NodeJS.Platform,
): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function invalid(message: string, details: Record<string, unknown>): never {
  throw new NexusError("SAVE_PATH_INVALID", message, { details });
}

export function normalizeSaveRelativePath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const trimmed = value.trim();
  if (!trimmed) invalid("Save paths must not be empty.", { value });
  if (CONTROL_OR_BIDI.test(trimmed)) {
    invalid(
      "Save paths must not contain control or bidirectional formatting characters.",
      { value },
    );
  }
  const api = pathApi(platform);
  const platformValue =
    platform === "win32" ? trimmed.replaceAll("/", "\\") : trimmed;
  if (
    api.isAbsolute(platformValue) ||
    platformValue.startsWith("\\\\") ||
    /^[a-zA-Z]:/.test(platformValue)
  ) {
    invalid("Save paths must be relative to a frozen save root.", { value });
  }
  const segments = platformValue.split(
    platform === "win32" ? /[\\/]/ : /\//,
  );
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      invalid("Save paths must not contain empty, dot, or parent segments.", {
        value,
        segment,
      });
    }
    if (platform === "win32") {
      if (segment.includes(":")) {
        invalid("Save paths must not contain alternate data stream syntax.", {
          value,
          segment,
        });
      }
      if (/[. ]$/.test(segment)) {
        invalid("Windows save path segments must not end in a dot or space.", {
          value,
          segment,
        });
      }
      if (WINDOWS_RESERVED_NAME.test(segment)) {
        invalid("Save paths must not contain Windows device names.", {
          value,
          segment,
        });
      }
    }
  }
  return segments.join("/");
}
