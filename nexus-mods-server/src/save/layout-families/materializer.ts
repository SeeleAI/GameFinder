import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import type { GameSaveRecipe } from "../v2/contracts.js";

export interface MaterializedSaveUnitV2 {
  unitId: string;
  layoutFamily: GameSaveRecipe["saveUnits"][number]["layoutFamily"];
  files: Array<{
    relativePath: string;
    role: "essential" | "companion" | "auxiliary";
    slot: { kind: string; index: number | null } | null;
  }>;
  materializationHash: string;
}

function patternRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*");
  return new RegExp(`^${escaped}$`, "i");
}

async function boundedFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const queue: Array<{ absolutePath: string; relativePath: string; depth: number }> = [{ absolutePath: root, relativePath: "", depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > 8) throw new NexusError("SAVE_LAYOUT_NOT_RECOGNIZED", "Save layout exceeds the maximum directory depth.");
    const entries = await readdir(current.absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      if (result.length + queue.length >= 10_000) throw new NexusError("SAVE_LAYOUT_NOT_RECOGNIZED", "Save layout exceeds the maximum entry count.");
      const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name;
      const absolutePath = path.join(current.absolutePath, entry.name);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) throw new NexusError("SAVE_PATH_PROTECTED", "Save layout contains a reparse point.", { details: { absolutePath } });
      if (info.isDirectory()) queue.push({ absolutePath, relativePath, depth: current.depth + 1 });
      else if (info.isFile()) result.push(relativePath);
    }
  }
  const folded = new Set<string>();
  for (const file of result) {
    const key = file.toLocaleLowerCase("en-US");
    if (folded.has(key)) throw new NexusError("SAVE_LAYOUT_AMBIGUOUS", "Save layout contains case-colliding paths.");
    folded.add(key);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function slotFor(relativePath: string): { kind: string; index: number | null } | null {
  const match = /(?:^|[_-])(\d+)(?=\.[^.]+$)/.exec(path.posix.basename(relativePath));
  return match ? { kind: "filename-index", index: Number(match[1]) } : null;
}

export async function materializeSaveUnitsV2(
  root: string,
  recipe: Readonly<GameSaveRecipe>,
): Promise<MaterializedSaveUnitV2[]> {
  const available = await boundedFiles(root);
  const units: MaterializedSaveUnitV2[] = [];
  for (const unit of recipe.saveUnits) {
    const matches = (pattern: string): string[] => available.filter((file) => patternRegex(pattern).test(file));
    if (unit.requiredAll.some((pattern) => matches(pattern).length === 0)) continue;
    if (unit.requiredAnyOf.length > 0 && !unit.requiredAnyOf.some((pattern) => matches(pattern).length > 0)) continue;
    const roleByPath = new Map<string, "essential" | "companion" | "auxiliary">();
    const add = (patterns: ReadonlyArray<string>, role: "essential" | "companion" | "auxiliary") => {
      for (const pattern of patterns) for (const file of matches(pattern)) {
        const key = file.toLocaleLowerCase("en-US");
        if (!roleByPath.has(key)) roleByPath.set(key, role);
      }
    };
    add([...unit.requiredAll, ...unit.requiredAnyOf], "essential");
    add(unit.companions, "companion");
    add(unit.auxiliary, "auxiliary");
    for (const pattern of unit.managedPatterns) for (const file of matches(pattern)) {
      const key = file.toLocaleLowerCase("en-US");
      if (!roleByPath.has(key)) roleByPath.set(key, "auxiliary");
    }
    if (roleByPath.size === 0 || roleByPath.size > unit.maximumMatches) {
      if (roleByPath.size > unit.maximumMatches) throw new NexusError("SAVE_LAYOUT_AMBIGUOUS", "Save Unit exceeds its maximum match count.", { details: { unitId: unit.unitId, matches: roleByPath.size, maximumMatches: unit.maximumMatches } });
      continue;
    }
    const files = available.filter((file) => roleByPath.has(file.toLocaleLowerCase("en-US"))).map((relativePath) => ({
      relativePath,
      role: roleByPath.get(relativePath.toLocaleLowerCase("en-US"))!,
      slot: unit.layoutFamily === "slot-file-set" ? slotFor(relativePath) : null,
    }));
    units.push({
      unitId: unit.unitId,
      layoutFamily: unit.layoutFamily,
      files,
      materializationHash: sha256CanonicalJson(files),
    });
  }
  return units;
}
