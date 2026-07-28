export type VersionConstraintStatus =
  | "not_requested"
  | "satisfied"
  | "not_satisfied"
  | "unknown";

export interface VersionConstraintEvaluation {
  requested: string | null;
  installedVersion: string | null;
  normalizedInstalledVersion: string | null;
  normalizedRequiredVersion: string | null;
  operator: ">=" | ">" | "<=" | "<" | "=" | null;
  status: VersionConstraintStatus;
  reason: string;
}

interface ParsedVersion {
  normalized: string;
  segments: number[];
}

function parseNumericVersion(value: string): ParsedVersion | null {
  const match = /^[vV]?(\d+(?:\.\d+){0,7})$/.exec(value.trim());
  if (!match?.[1]) return null;
  const segments = match[1].split(".").map((segment) => Number(segment));
  if (segments.some((segment) => !Number.isSafeInteger(segment))) return null;
  while (segments.length > 1 && segments.at(-1) === 0) segments.pop();
  return { normalized: segments.join("."), segments };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  const length = Math.max(left.segments.length, right.segments.length);
  for (let index = 0; index < length; index += 1) {
    const leftSegment = left.segments[index] ?? 0;
    const rightSegment = right.segments[index] ?? 0;
    if (leftSegment < rightSegment) return -1;
    if (leftSegment > rightSegment) return 1;
  }
  return 0;
}

function parseConstraint(
  value: string,
): { operator: ">=" | ">" | "<=" | "<" | "="; version: ParsedVersion } | null {
  const trimmed = value.trim();
  const plusMatch = /^([vV]?\d+(?:\.\d+){0,7})\+$/.exec(trimmed);
  if (plusMatch?.[1]) {
    const version = parseNumericVersion(plusMatch[1]);
    return version === null ? null : { operator: ">=", version };
  }
  const operatorMatch = /^(>=|>|<=|<|==|=)\s*([vV]?\d+(?:\.\d+){0,7})$/.exec(
    trimmed,
  );
  if (!operatorMatch?.[1] || !operatorMatch[2]) return null;
  const version = parseNumericVersion(operatorMatch[2]);
  if (version === null) return null;
  return {
    operator: (operatorMatch[1] === "==" ? "=" : operatorMatch[1]) as
      | ">="
      | ">"
      | "<="
      | "<"
      | "=",
    version,
  };
}

export function evaluateVersionConstraint(
  installedVersion: string | null,
  requested: string | null,
): VersionConstraintEvaluation {
  if (requested === null) {
    const installed =
      installedVersion === null ? null : parseNumericVersion(installedVersion);
    return {
      requested: null,
      installedVersion,
      normalizedInstalledVersion: installed?.normalized ?? null,
      normalizedRequiredVersion: null,
      operator: null,
      status: "not_requested",
      reason: "No version constraint was requested.",
    };
  }
  const constraint = parseConstraint(requested);
  if (constraint === null) {
    return {
      requested,
      installedVersion,
      normalizedInstalledVersion:
        installedVersion === null
          ? null
          : parseNumericVersion(installedVersion)?.normalized ?? null,
      normalizedRequiredVersion: null,
      operator: null,
      status: "unknown",
      reason:
        "The requirement is not one of the supported explicit numeric constraint forms.",
    };
  }
  if (installedVersion === null) {
    return {
      requested,
      installedVersion: null,
      normalizedInstalledVersion: null,
      normalizedRequiredVersion: constraint.version.normalized,
      operator: constraint.operator,
      status: "unknown",
      reason: "The local installation version is unknown.",
    };
  }
  const installed = parseNumericVersion(installedVersion);
  if (installed === null) {
    return {
      requested,
      installedVersion,
      normalizedInstalledVersion: null,
      normalizedRequiredVersion: constraint.version.normalized,
      operator: constraint.operator,
      status: "unknown",
      reason: "The local installation version is not a plain numeric version.",
    };
  }
  const comparison = compareVersions(installed, constraint.version);
  const satisfied =
    constraint.operator === ">="
      ? comparison >= 0
      : constraint.operator === ">"
        ? comparison > 0
        : constraint.operator === "<="
          ? comparison <= 0
          : constraint.operator === "<"
            ? comparison < 0
            : comparison === 0;
  return {
    requested,
    installedVersion,
    normalizedInstalledVersion: installed.normalized,
    normalizedRequiredVersion: constraint.version.normalized,
    operator: constraint.operator,
    status: satisfied ? "satisfied" : "not_satisfied",
    reason: satisfied
      ? "The installed numeric version satisfies the requested constraint."
      : "The installed numeric version does not satisfy the requested constraint.",
  };
}
