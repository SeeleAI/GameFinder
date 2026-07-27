import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod/v4";

import { NexusError } from "../errors.js";
import type { ArchiveInventory } from "./archive-inspector.js";
import { readZipTextEntry } from "./archive-inspector.js";
import { sha256CanonicalJson } from "./content-hash.js";
import type {
  PackageAmbiguity,
  PackageAnalysis,
  PackageDependency,
  PackageUnit,
} from "./contracts.js";
import { packageAnalysisSchema } from "./contracts.js";

export const PACKAGE_ANALYZER_VERSION = "package-analyzer@2";

const smapiDependencySchema = z.object({
  UniqueID: z.string().trim().min(1),
  IsRequired: z.boolean().optional().default(true),
  MinimumVersion: z.string().trim().min(1).optional(),
});

const smapiManifestSchema = z
  .object({
    Name: z.string().trim().min(1),
    Author: z.string().trim().min(1).optional(),
    Version: z.union([
      z.string().trim().min(1),
      z.number().transform((value) => String(value)),
    ]),
    UniqueID: z.string().trim().min(1),
    EntryDll: z.string().trim().min(1).optional(),
    MinimumApiVersion: z.string().trim().min(1).optional(),
    Dependencies: z.array(smapiDependencySchema).optional().default([]),
    ContentPackFor: z
      .object({
        UniqueID: z.string().trim().min(1),
        MinimumVersion: z.string().trim().min(1).optional(),
      })
      .optional(),
  })
  .passthrough();

function parentArchivePath(entryPath: string): string {
  const directory = path.posix.dirname(entryPath);
  return directory === "." ? "." : directory;
}

function joinArchivePath(root: string, child: string): string {
  const normalizedChild = child.replaceAll("\\", "/");
  return root === "."
    ? path.posix.normalize(normalizedChild)
    : path.posix.normalize(`${root}/${normalizedChild}`);
}

function packageUnitId(uniqueId: string, packageRoot: string): string {
  return `package-${sha256CanonicalJson({ uniqueId, packageRoot }).slice(0, 24)}`;
}

function executableInstallerCandidates(
  inventory: ArchiveInventory,
): ReadonlyArray<ArchiveInventory["entries"][number]> {
  return inventory.entries.filter((entry) => {
    if (entry.kind !== "file") return false;
    const basename = path.posix.basename(entry.normalizedPath).toLowerCase();
    if (!/\.(?:exe|js)$/i.test(basename)) return false;
    return /(?:^|[-_. ])(?:install(?:er)?|setup)(?:[-_. ]|$)/i.test(basename);
  });
}

function installerPackageRoot(
  inventory: ArchiveInventory,
  entryPath: string,
): string {
  if (
    inventory.commonTopLevelDirectory &&
    (entryPath === inventory.commonTopLevelDirectory ||
      entryPath.startsWith(`${inventory.commonTopLevelDirectory}/`))
  ) {
    return inventory.commonTopLevelDirectory;
  }
  return parentArchivePath(entryPath);
}

function manifestDependencies(
  manifest: z.infer<typeof smapiManifestSchema>,
): PackageDependency[] {
  const dependencies: PackageDependency[] = manifest.Dependencies.map(
    (dependency) => ({
      dependencyId: dependency.UniqueID,
      kind: dependency.IsRequired ? "required" : "optional",
      versionConstraint: dependency.MinimumVersion ?? null,
      evidence: ["SMAPI manifest Dependencies entry."],
    }),
  );
  if (manifest.ContentPackFor) {
    dependencies.push({
      dependencyId: manifest.ContentPackFor.UniqueID,
      kind: "required",
      versionConstraint: manifest.ContentPackFor.MinimumVersion ?? null,
      evidence: ["SMAPI manifest ContentPackFor entry."],
    });
  }
  if (manifest.EntryDll) {
    dependencies.push({
      dependencyId: "Pathoschild.SMAPI",
      kind: "external",
      versionConstraint: manifest.MinimumApiVersion ?? null,
      evidence: ["SMAPI manifest declares EntryDll."],
    });
  }
  return dependencies;
}

export async function analyzePackageInventory(
  inventory: ArchiveInventory,
): Promise<PackageAnalysis> {
  const filePaths = new Set(
    inventory.entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => entry.normalizedPath.toLowerCase()),
  );
  const manifestEntries = inventory.entries.filter(
    (entry) =>
      entry.kind === "file" &&
      path.posix.basename(entry.normalizedPath).toLowerCase() ===
        "manifest.json",
  );
  const packages: PackageUnit[] = [];
  const ambiguities: PackageAmbiguity[] = [];

  for (const entry of manifestEntries) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(
        await readZipTextEntry({
          archive: inventory.archive,
          entry,
          maxBytes: 1024 * 1024,
        }),
      ) as unknown;
    } catch (error) {
      ambiguities.push({
        code: "other",
        message: `Could not parse ${entry.normalizedPath} as a bounded JSON manifest: ${
          error instanceof Error ? error.message : String(error)
        }`,
        packageUnitIds: [],
      });
      continue;
    }

    const manifestResult = smapiManifestSchema.safeParse(parsedJson);
    if (!manifestResult.success) continue;
    const manifest = manifestResult.data;
    const packageRoot = parentArchivePath(entry.normalizedPath);
    const packageId = packageUnitId(manifest.UniqueID, packageRoot);
    const entryFiles = [entry.normalizedPath];
    const positiveSignals = [
      `Valid SMAPI manifest at ${entry.normalizedPath}.`,
      `Manifest UniqueID is ${manifest.UniqueID}.`,
    ];
    const negativeSignals: string[] = [];
    let packageType: PackageUnit["packageType"] = "unknown";

    if (manifest.EntryDll) {
      const dllPath = joinArchivePath(packageRoot, manifest.EntryDll);
      entryFiles.push(dllPath);
      packageType = "loader-plugin";
      positiveSignals.push(`Manifest declares EntryDll ${manifest.EntryDll}.`);
      if (!filePaths.has(dllPath.toLowerCase())) {
        negativeSignals.push(
          `Declared EntryDll is missing from the archive: ${dllPath}.`,
        );
        ambiguities.push({
          code: "missing-entry-file",
          message: `SMAPI package ${manifest.UniqueID} declares a missing EntryDll.`,
          packageUnitIds: [packageId],
        });
      }
    } else if (manifest.ContentPackFor) {
      packageType = "content-pack";
      positiveSignals.push(
        `Manifest declares ContentPackFor ${manifest.ContentPackFor.UniqueID}.`,
      );
    } else {
      negativeSignals.push(
        "The SMAPI-shaped manifest declares neither EntryDll nor ContentPackFor.",
      );
      ambiguities.push({
        code: "unknown-package-type",
        message: `Manifest ${entry.normalizedPath} has a SMAPI identity but no supported package mechanism.`,
        packageUnitIds: [packageId],
      });
    }

    packages.push({
      packageUnitId: packageId,
      packageType,
      packageRoot,
      identity: {
        uniqueId: manifest.UniqueID,
        name: manifest.Name,
        version: manifest.Version,
      },
      entryFiles,
      dependencies: manifestDependencies(manifest),
      positiveSignals,
      negativeSignals,
    });
  }

  if (packages.length === 0) {
    const installerEntries = executableInstallerCandidates(inventory);
    for (const entry of installerEntries) {
      const packageRoot = installerPackageRoot(
        inventory,
        entry.normalizedPath,
      );
      const name = path.posix.basename(packageRoot === "." ? entry.normalizedPath : packageRoot);
      const uniqueId = `bundled-installer:${entry.normalizedPath.toLowerCase()}`;
      packages.push({
        packageUnitId: packageUnitId(uniqueId, packageRoot),
        packageType: "executable-installer",
        packageRoot,
        identity: {
          uniqueId,
          name,
          version: null,
        },
        entryFiles: [entry.normalizedPath],
        dependencies: [],
        positiveSignals: [
          `Bundled installer candidate ${entry.normalizedPath}.`,
          "Candidate filename contains a setup/installer signal and uses a supported controlled runtime extension.",
        ],
        negativeSignals: [],
      });
    }
    if (installerEntries.length > 1) {
      ambiguities.push({
        code: "multiple-package-roots",
        message:
          "Multiple bundled installer candidates were found; an exact package unit must be selected.",
        packageUnitIds: packages.map((unit) => unit.packageUnitId),
      });
    }
  }

  if (manifestEntries.length === 0 && packages.length === 0) {
    ambiguities.push({
      code: "unknown-package-type",
      message: "No supported machine-readable package manifest was found.",
      packageUnitIds: [],
    });
  } else if (packages.length === 0) {
    ambiguities.push({
      code: "unknown-package-type",
      message:
        "Manifest files were present, but none matched the supported SMAPI schema.",
      packageUnitIds: [],
    });
  }

  const analyzedAt = new Date().toISOString();
  const hashPayload = {
    schemaVersion: 1,
    analyzerVersion: PACKAGE_ANALYZER_VERSION,
    archive: inventory.archive,
    packages,
    ambiguities,
  };
  const result = packageAnalysisSchema.parse({
    ...hashPayload,
    analysisId: randomUUID(),
    analysisHash: sha256CanonicalJson(hashPayload),
    analyzedAt,
  });
  if (result.archive.sha256 !== inventory.archive.sha256) {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      "Package Analysis was not bound to its archive inventory.",
    );
  }
  return result;
}
