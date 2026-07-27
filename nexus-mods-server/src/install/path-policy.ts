import { lstat } from "node:fs/promises";
import path from "node:path";
import { NexusError } from "../errors.js";

const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const CONTROL_OR_BIDI =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

export interface ResolveManagedTargetInput {
  gameRoot: string;
  targetRelativePath: string;
  writableRoots: ReadonlyArray<string>;
  protectedRoots?: ReadonlyArray<string>;
  platform?: NodeJS.Platform;
}

export interface ResolvedManagedTarget {
  gameRoot: string;
  targetRelativePath: string;
  targetAbsolutePath: string;
  writableRootRelativePath: string;
  writableRootAbsolutePath: string;
}

function invalidPath(message: string, details: Record<string, unknown>): never {
  throw new NexusError("INSTALL_CONTRACT_INVALID", message, { details });
}

function protectedPath(message: string, details: Record<string, unknown>): never {
  throw new NexusError("PROTECTED_PATH", message, { details });
}

function pathApi(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function isWithin(
  api: typeof path.win32 | typeof path.posix,
  basePath: string,
  targetPath: string,
  platform: NodeJS.Platform
): boolean {
  const relative = api.relative(basePath, targetPath);
  if (relative === "") return true;
  if (relative === ".." || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) {
    return false;
  }
  if (platform !== "win32") return true;
  const normalizedBase = api.resolve(basePath).toLowerCase();
  const normalizedTarget = api.resolve(targetPath).toLowerCase();
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}${api.sep}`);
}

export function normalizeManagedRelativePath(
  value: string,
  platform: NodeJS.Platform = process.platform
): string {
  const trimmed = value.trim();
  if (!trimmed) invalidPath("Managed paths must not be empty.", { value });
  if (CONTROL_OR_BIDI.test(trimmed)) {
    invalidPath("Managed paths must not contain controls or bidirectional formatting characters.", {
      value
    });
  }

  const api = pathApi(platform);
  const separators = platform === "win32" ? /[\\/]+/ : /\/+/;
  const platformValue = platform === "win32" ? trimmed.replaceAll("/", "\\") : trimmed;
  if (
    api.isAbsolute(platformValue) ||
    platformValue.startsWith("\\\\") ||
    /^[a-zA-Z]:/.test(platformValue)
  ) {
    invalidPath("Managed paths must be relative to the game root.", { value });
  }

  const segments = platformValue.split(separators);
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      invalidPath("Managed paths must not contain empty, dot, or parent segments.", { value, segment });
    }
    if (platform === "win32") {
      if (segment.includes(":")) {
        invalidPath("Managed Windows paths must not contain alternate data stream separators.", {
          value,
          segment
        });
      }
      if (/[. ]$/.test(segment)) {
        invalidPath("Managed Windows path segments must not end with a dot or space.", {
          value,
          segment
        });
      }
      if (WINDOWS_RESERVED_NAME.test(segment)) {
        invalidPath("Managed Windows paths must not contain reserved device names.", {
          value,
          segment
        });
      }
    }
  }

  return segments.join("/");
}

export function resolveManagedTarget(input: ResolveManagedTargetInput): ResolvedManagedTarget {
  const platform = input.platform ?? process.platform;
  const api = pathApi(platform);
  if (!api.isAbsolute(input.gameRoot)) {
    invalidPath("gameRoot must be an absolute path.", { gameRoot: input.gameRoot });
  }
  const gameRoot = api.resolve(input.gameRoot);
  if (gameRoot === api.parse(gameRoot).root) {
    invalidPath("A filesystem root cannot be used as a game root.", { gameRoot });
  }

  const targetRelativePath = normalizeManagedRelativePath(input.targetRelativePath, platform);
  const targetAbsolutePath = api.resolve(gameRoot, ...targetRelativePath.split("/"));
  if (!isWithin(api, gameRoot, targetAbsolutePath, platform)) {
    invalidPath("The managed target escapes the game root.", {
      gameRoot,
      targetRelativePath,
      targetAbsolutePath
    });
  }

  for (const protectedRoot of input.protectedRoots ?? []) {
    const normalizedProtectedRoot = normalizeManagedRelativePath(protectedRoot, platform);
    const protectedAbsolutePath = api.resolve(gameRoot, ...normalizedProtectedRoot.split("/"));
    if (isWithin(api, protectedAbsolutePath, targetAbsolutePath, platform)) {
      protectedPath("The managed target is inside a protected game path.", {
        targetRelativePath,
        protectedRoot: normalizedProtectedRoot
      });
    }
  }

  for (const writableRoot of input.writableRoots) {
    const normalizedWritableRoot = normalizeManagedRelativePath(writableRoot, platform);
    const writableRootAbsolutePath = api.resolve(gameRoot, ...normalizedWritableRoot.split("/"));
    if (isWithin(api, writableRootAbsolutePath, targetAbsolutePath, platform)) {
      return {
        gameRoot,
        targetRelativePath,
        targetAbsolutePath,
        writableRootRelativePath: normalizedWritableRoot,
        writableRootAbsolutePath
      };
    }
  }

  protectedPath("The managed target is outside every writable root declared by the game profile.", {
    targetRelativePath,
    writableRoots: input.writableRoots
  });
}

export async function assertNoReparsePointTraversal(
  gameRoot: string,
  targetAbsolutePath: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const api = pathApi(platform);
  const resolvedGameRoot = api.resolve(gameRoot);
  const resolvedTarget = api.resolve(targetAbsolutePath);
  if (!isWithin(api, resolvedGameRoot, resolvedTarget, platform)) {
    invalidPath("The reparse-point check target escapes the game root.", {
      gameRoot: resolvedGameRoot,
      targetAbsolutePath: resolvedTarget
    });
  }

  const relative = api.relative(resolvedGameRoot, resolvedTarget);
  const segments = relative ? relative.split(api.sep) : [];
  let current = resolvedGameRoot;
  for (const segment of ["", ...segments]) {
    if (segment) current = api.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new NexusError(
          "PROTECTED_PATH",
          "Managed paths must not traverse symbolic links or directory junctions.",
          { details: { path: current } }
        );
      }
    } catch (error) {
      if (
        error instanceof NexusError ||
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      break;
    }
  }
}
