import { lstat } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../errors.js";

const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const CONTROL_OR_BIDI =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

export interface SaveRootPolicyInput {
  saveRoot: string;
  targetRelativePath: string;
  managedPaths: ReadonlyArray<string>;
  forbiddenRoots?: ReadonlyArray<string>;
  platform?: NodeJS.Platform;
}

export interface ResolvedSaveTarget {
  saveRoot: string;
  targetRelativePath: string;
  targetAbsolutePath: string;
  managedPath: string;
}

function pathApi(
  platform: NodeJS.Platform,
): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function invalid(message: string, details: Record<string, unknown>): never {
  throw new NexusError("SAVE_PATH_INVALID", message, { details });
}

function protectedPath(
  message: string,
  details: Record<string, unknown>,
): never {
  throw new NexusError("SAVE_PATH_PROTECTED", message, { details });
}

function samePath(
  api: typeof path.win32 | typeof path.posix,
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  const normalizedLeft = api.resolve(left);
  const normalizedRight = api.resolve(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isWithin(
  api: typeof path.win32 | typeof path.posix,
  root: string,
  target: string,
  platform: NodeJS.Platform,
): boolean {
  const relative = api.relative(root, target);
  if (relative === "") return true;
  if (
    relative === ".." ||
    relative.startsWith(`..${api.sep}`) ||
    api.isAbsolute(relative)
  ) {
    return false;
  }
  if (platform !== "win32") return true;
  const normalizedRoot = api.resolve(root).toLowerCase();
  const normalizedTarget = api.resolve(target).toLowerCase();
  return normalizedTarget.startsWith(`${normalizedRoot}${api.sep}`);
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
    platform === "win32" ? /[\\/]+/ : /\/+/,
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

export function resolveSaveTarget(
  input: SaveRootPolicyInput,
): ResolvedSaveTarget {
  const platform = input.platform ?? process.platform;
  const api = pathApi(platform);
  if (!api.isAbsolute(input.saveRoot)) {
    invalid("saveRoot must be absolute.", { saveRoot: input.saveRoot });
  }
  const saveRoot = api.resolve(input.saveRoot);
  if (samePath(api, saveRoot, api.parse(saveRoot).root, platform)) {
    protectedPath("A filesystem root cannot be a save root.", { saveRoot });
  }
  for (const forbiddenRoot of input.forbiddenRoots ?? []) {
    if (
      api.isAbsolute(forbiddenRoot) &&
      samePath(api, saveRoot, forbiddenRoot, platform)
    ) {
      protectedPath("A broad protected directory cannot be a save root.", {
        saveRoot,
        forbiddenRoot: api.resolve(forbiddenRoot),
      });
    }
  }

  const targetRelativePath = normalizeSaveRelativePath(
    input.targetRelativePath,
    platform,
  );
  const targetAbsolutePath = api.resolve(
    saveRoot,
    ...targetRelativePath.split("/"),
  );
  if (!isWithin(api, saveRoot, targetAbsolutePath, platform)) {
    invalid("The save target escapes its frozen save root.", {
      saveRoot,
      targetRelativePath,
    });
  }
  const managedPath = input.managedPaths
    .map((candidate) => normalizeSaveRelativePath(candidate, platform))
    .find((candidate) => {
      const managedAbsolutePath = api.resolve(
        saveRoot,
        ...candidate.split("/"),
      );
      return isWithin(
        api,
        managedAbsolutePath,
        targetAbsolutePath,
        platform,
      );
    });
  if (!managedPath) {
    protectedPath(
      "The save target is outside every managed path in the Save Context.",
      {
        saveRoot,
        targetRelativePath,
        managedPaths: input.managedPaths,
      },
    );
  }
  return {
    saveRoot,
    targetRelativePath,
    targetAbsolutePath,
    managedPath,
  };
}

export async function assertNoSaveReparsePointTraversal(
  saveRoot: string,
  targetAbsolutePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const api = pathApi(platform);
  const resolvedRoot = api.resolve(saveRoot);
  const resolvedTarget = api.resolve(targetAbsolutePath);
  if (!isWithin(api, resolvedRoot, resolvedTarget, platform)) {
    invalid("The reparse-point check target escapes the save root.", {
      saveRoot: resolvedRoot,
      targetAbsolutePath: resolvedTarget,
    });
  }
  const relative = api.relative(resolvedRoot, resolvedTarget);
  const segments = relative ? relative.split(api.sep) : [];
  let current = resolvedRoot;
  for (const segment of ["", ...segments]) {
    if (segment) current = api.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        protectedPath(
          "Managed save paths must not traverse symbolic links or junctions.",
          { path: current },
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
