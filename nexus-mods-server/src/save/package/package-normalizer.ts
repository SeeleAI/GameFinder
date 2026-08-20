import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { constants } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Entry, ZipFile } from "yauzl";
import yauzl from "yauzl";

import { NexusError } from "../../errors.js";
import { BackupStore } from "../../install/storage/backup-store.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import { inspectDirectoryTree } from "../../install/core/tree-state.js";
import { sha256File } from "../../install/file-hash.js";
import type { StandardSavePackage } from "../contracts.js";
import { standardSavePackageSchema } from "../contracts.js";
import { ensureRealStoreDirectory } from "../storage/json-store.js";
import type { GameSaveRecipeRegistryV2 } from "../recipes/recipe-registry.js";
import type { StandardSavePackageV2 } from "../v2/contracts.js";
import { computeStandardSavePackageV2Hash, standardSavePackageV2Schema } from "../v2/contracts.js";
import type { RarCapability } from "./input-inspector.js";
import { SaveInputInspector } from "./input-inspector.js";
import {
  StandardSavePackageStore,
  standardPackageIdentityHash,
} from "./standard-save-package-store.js";
import { StandardSavePackageV2Store } from "./standard-save-package-v2-store.js";

export interface SavePackageNormalizerOptions {
  managerRoot: string;
  inspector: SaveInputInspector;
  recipes?: GameSaveRecipeRegistryV2;
}

export interface SavePackageProvenance {
  kind: "nexus" | "speedrun";
  pageUrl: string;
  downloadReceiptId: string;
  originalInputSha256: string;
  claims: StandardSavePackage["claims"];
}

async function extractZipSelected(input: {
  archivePath: string;
  selected: ReadonlyMap<string, string>;
  targetRoot: string;
}): Promise<void> {
  let zipFile: ZipFile;
  try {
    zipFile = await yauzl.openPromise(input.archivePath, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: false,
    });
  } catch (error) {
    throw new NexusError("SAVE_ARCHIVE_UNSAFE", "ZIP could not be reopened for normalization.", {
      cause: error,
    });
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let extracted = 0;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (zipFile.isOpen) zipFile.close();
      reject(error);
    };
    zipFile.on("error", fail);
    zipFile.on("entry", (entry: Entry) => {
      const normalized = entry.fileName.replaceAll("\\", "/").replace(/\/$/, "");
      const targetRelative = input.selected.get(normalized.toLowerCase());
      if (!targetRelative) {
        zipFile.readEntry();
        return;
      }
      void (async () => {
        const target = path.join(input.targetRoot, ...targetRelative.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        const source = await zipFile.openReadStreamPromise(entry);
        await pipeline(source, createWriteStream(target, { flags: "wx" }));
        extracted += 1;
        zipFile.readEntry();
      })().catch(fail);
    });
    zipFile.on("end", () => {
      if (settled) return;
      settled = true;
      if (extracted !== input.selected.size) {
        reject(new NexusError("SAVE_ARCHIVE_UNSAFE", "ZIP selected payload extraction was incomplete."));
      } else {
        resolve();
      }
    });
    zipFile.readEntry();
  });
}

export class SavePackageNormalizer {
  readonly #inspector: SaveInputInspector;
  readonly #packages: StandardSavePackageStore;
  readonly #packagesV2: StandardSavePackageV2Store;
  readonly #recipes: GameSaveRecipeRegistryV2 | undefined;
  readonly #objects: BackupStore;
  readonly #stagingRoot: string;

  private constructor(input: {
    inspector: SaveInputInspector;
    packages: StandardSavePackageStore;
    packagesV2: StandardSavePackageV2Store;
    objects: BackupStore;
    stagingRoot: string;
    recipes?: GameSaveRecipeRegistryV2;
  }) {
    this.#inspector = input.inspector;
    this.#packages = input.packages;
    this.#packagesV2 = input.packagesV2;
    this.#recipes = input.recipes;
    this.#objects = input.objects;
    this.#stagingRoot = input.stagingRoot;
  }

  static async create(options: SavePackageNormalizerOptions): Promise<SavePackageNormalizer> {
    const [packages, packagesV2, objects, stagingRoot] = await Promise.all([
      StandardSavePackageStore.create(options.managerRoot),
      StandardSavePackageV2Store.create(options.managerRoot),
      BackupStore.create(path.join(options.managerRoot, "save-manager")),
      ensureRealStoreDirectory(options.managerRoot, "normalization-staging"),
    ]);
    return new SavePackageNormalizer({
      inspector: options.inspector,
      packages,
      packagesV2,
      objects,
      stagingRoot,
      ...(options.recipes === undefined ? {} : { recipes: options.recipes }),
    });
  }

  async normalize(input: {
    inspectionId: string;
    payloadSelectionId: string;
    provenance?: SavePackageProvenance;
  }): Promise<Readonly<StandardSavePackage>> {
    const inspection = await this.#inspector.get(input.inspectionId);
    const candidate = inspection.payloadCandidates.find(
      (value) => value.payloadSelectionId === input.payloadSelectionId,
    );
    if (!candidate) {
      throw new NexusError(
        "SAVE_PACKAGE_INVALID",
        "payloadSelectionId is not part of the frozen Save Input Inspection.",
      );
    }
    await this.#verifyOriginalInput(inspection.input);
    if (
      input.provenance &&
      input.provenance.originalInputSha256 !== inspection.input.sha256
    ) {
      throw new NexusError(
        "SAVE_SOURCE_UNAVAILABLE",
        "Verified download provenance does not match the inspected save input.",
      );
    }
    const stagingRoot = path.join(this.#stagingRoot, randomUUID());
    const extractedRoot = path.join(stagingRoot, "extracted");
    const payloadRoot = path.join(stagingRoot, "payload");
    await Promise.all([
      mkdir(extractedRoot, { recursive: true }),
      mkdir(payloadRoot, { recursive: true }),
    ]);
    try {
      if (inspection.input.kind === "rar") {
        const capability = this.#requireMatchingRarCapability(inspection.archive?.extractor);
        await capability.runner.run(capability.executablePath, [
          "x", "-p-", "-o-", "-cfg-", "-c-", "-@-", "-ai", "-inul",
          inspection.input.absolutePath,
          `${extractedRoot}${path.sep}`,
        ]);
        await this.#verifyExtractedArchive(inspection, extractedRoot);
      } else if (inspection.input.kind === "7z") {
        const capability = this.#requireMatchingSevenZipCapability(inspection.archive?.extractor);
        if (capability.kind !== "bsdtar") {
          throw new NexusError("SAVE_INPUT_UNSUPPORTED", "7z normalization requires bsdtar.");
        }
        await capability.runner.run(capability.executablePath, [
          "-xf", inspection.input.absolutePath,
          "-C", extractedRoot,
          "--no-same-owner",
          "--no-same-permissions",
        ]);
        await this.#verifyExtractedArchive(inspection, extractedRoot);
      } else if (inspection.input.kind === "zip") {
        const selected = new Map(
          candidate.files.map((file) => [file.sourcePath.toLowerCase(), file.sourcePath]),
        );
        await extractZipSelected({
          archivePath: inspection.input.absolutePath,
          selected,
          targetRoot: extractedRoot,
        });
      }

      const payloadFiles: StandardSavePackage["payload"]["files"] = [];
      for (const selected of candidate.files) {
        const source =
          inspection.input.kind === "directory"
            ? path.join(inspection.input.absolutePath, ...selected.sourcePath.split("/"))
            : inspection.input.kind === "file"
              ? inspection.input.absolutePath
              : path.join(extractedRoot, ...selected.sourcePath.split("/"));
        const target = path.join(payloadRoot, ...selected.relativePath.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(source, target, constants.COPYFILE_EXCL);
        const treeFile = (await inspectDirectoryTree(payloadRoot)).files.find(
          (file) => file.relativePath === selected.relativePath,
        );
        if (!treeFile || treeFile.bytes !== selected.bytes) {
          throw new NexusError("SAVE_PACKAGE_INVALID", "Selected payload changed during normalization.");
        }
        const object = await this.#objects.backupFile(target);
        payloadFiles.push({
          relativePath: selected.relativePath,
          objectId: object.backupId,
          bytes: treeFile.bytes,
          sha256: treeFile.sha256,
        });
      }
      payloadFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
      const payloadTreeHash = sha256CanonicalJson(
        payloadFiles.map(({ relativePath, bytes, sha256 }) => ({ relativePath, bytes, sha256 })),
      );
      if (candidate.recipe && candidate.layoutFamily) {
        const recipe = this.#recipes?.findById(candidate.recipe.recipeId);
        if (!recipe || recipe.recipeHash !== candidate.recipe.recipeHash) {
          throw new NexusError("SAVE_RECIPE_NOT_FOUND", "The payload candidate Recipe is unavailable or changed.");
        }
        const v2Files = candidate.files.map((selected) => {
          const payload = payloadFiles.find((file) => file.relativePath === selected.relativePath);
          if (!payload) throw new NexusError("SAVE_PACKAGE_INVALID", "Normalized payload mapping is incomplete.");
          return {
            sourcePath: selected.sourcePath,
            relativePath: selected.relativePath,
            objectId: payload.objectId,
            bytes: payload.bytes,
            sha256: payload.sha256,
            slot: selected.slot ?? null,
          };
        });
        const packageId = `savepkg-${sha256CanonicalJson({
          recipe: candidate.recipe,
          unitId: candidate.unitId,
          files: v2Files.map(({ sourcePath, relativePath, bytes, sha256, slot }) => ({ sourcePath, relativePath, bytes, sha256, slot })),
          provenance: input.provenance ?? {
            kind: "manual",
            originalInputPath: inspection.input.absolutePath,
            originalInputSha256: inspection.input.sha256,
          },
        })}`;
        const bindingKind: StandardSavePackageV2["binding"]["kind"] =
          candidate.binding.kind === "account_bound_unknown" ? "unknown" : candidate.binding.kind;
        const withoutHash: Omit<StandardSavePackageV2, "manifestHash"> = {
          schemaVersion: 2,
          packageId,
          recipe: candidate.recipe,
          game: {
            canonicalId: recipe.game.canonicalId,
            displayName: recipe.game.displayName,
            platformAppId: recipe.game.platformAppIds.steam ?? null,
          },
          unitId: candidate.unitId,
          layoutFamily: candidate.layoutFamily,
          source: {
            kind: input.provenance?.kind ?? "manual",
            inspectionId: inspection.inspectionId,
            pageUrl: input.provenance?.pageUrl ?? null,
            downloadReceiptId: input.provenance?.downloadReceiptId ?? null,
            originalInputPath: input.provenance ? null : inspection.input.absolutePath,
            originalInputSha256: inspection.input.sha256,
          },
          claims: input.provenance?.claims ?? {
            progress: null,
            gameVersion: null,
            dlc: [],
            onlineSafety: "unknown",
          },
          payload: { files: v2Files, treeHash: payloadTreeHash },
          binding: {
            kind: bindingKind,
            value: candidate.binding.value,
            confidence: candidate.binding.kind === "steam_id64"
              ? "probable"
              : candidate.binding.kind === "none" ? "confirmed" : "unknown",
            evidence: candidate.binding.evidence ?? "No package account-binding evidence was established.",
          },
          format: {
            kind: recipe.format.kind,
            adapterHint: recipe.format.adapterId,
            evidence: [`Matched Recipe ${recipe.recipeId} unit ${candidate.unitId} without modifying payload bytes.`],
          },
          safety: {
            archiveInspection: inspection.archive ? "passed" : "not-applicable",
            containsExecutable: false,
            warnings: inspection.warnings,
          },
          createdAt: new Date().toISOString(),
        };
        const manifest = standardSavePackageV2Schema.parse({
          ...withoutHash,
          manifestHash: computeStandardSavePackageV2Hash(withoutHash),
        });
        await this.#verifyOriginalInput(inspection.input);
        return await this.#packagesV2.save(manifest) as unknown as Readonly<StandardSavePackage>;
      }
      const identity = {
        game: candidate.game,
        payload: { root: "payload", files: payloadFiles, treeHash: payloadTreeHash },
        binding: candidate.binding,
        format: candidate.format,
      };
      const packageId = `savepkg-${standardPackageIdentityHash(identity)}`;
      const withoutHash = {
        schemaVersion: 1 as const,
        packageId,
        game: candidate.game,
        source: {
          kind: input.provenance?.kind ?? "manual" as const,
          inspectionId: inspection.inspectionId,
          pageUrl: input.provenance?.pageUrl ?? null,
          downloadReceiptId: input.provenance?.downloadReceiptId ?? null,
          originalInputPath: input.provenance ? null : inspection.input.absolutePath,
          originalInputSha256: inspection.input.sha256,
        },
        claims: input.provenance?.claims ?? {
          progress: null,
          gameVersion: null,
          dlc: [],
          onlineSafety: "unknown" as const,
        },
        payload: identity.payload,
        binding: candidate.binding,
        format: candidate.format,
        safety: {
          archiveInspection: inspection.archive ? "passed" as const : "not-applicable" as const,
          containsExecutable: false,
          warnings: inspection.warnings,
        },
        createdAt: new Date().toISOString(),
      };
      const manifest = standardSavePackageSchema.parse({
        ...withoutHash,
        manifestHash: sha256CanonicalJson(withoutHash),
      });
      const published = await this.#packages.publish(manifest, payloadRoot);
      await this.#verifyOriginalInput(inspection.input);
      return await this.#packages.verify(published.packageId);
    } finally {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async get(packageId: string): Promise<Readonly<StandardSavePackage>> {
    try {
      return await this.#packagesV2.get(packageId) as unknown as Readonly<StandardSavePackage>;
    } catch (error) {
      if (!(error instanceof NexusError) || error.code !== "NOT_FOUND") throw error;
      return await this.#packages.get(packageId);
    }
  }

  async verify(packageId: string): Promise<Readonly<StandardSavePackage>> {
    try {
      return await this.#packagesV2.get(packageId) as unknown as Readonly<StandardSavePackage>;
    } catch (error) {
      if (!(error instanceof NexusError) || error.code !== "NOT_FOUND") throw error;
      return await this.#packages.verify(packageId);
    }
  }

  async getV2(packageId: string): Promise<Readonly<StandardSavePackageV2>> {
    return await this.#packagesV2.get(packageId);
  }

  get packageStore(): StandardSavePackageStore {
    return this.#packages;
  }

  get objectStore(): BackupStore {
    return this.#objects;
  }

  async #verifyOriginalInput(input: {
    kind: "file" | "directory" | "zip" | "rar" | "7z";
    absolutePath: string;
    bytes: number;
    sha256: string;
  }): Promise<void> {
    if (input.kind === "directory") {
      const tree = await inspectDirectoryTree(input.absolutePath).catch((error: unknown) => {
        throw new NexusError("SAVE_PACKAGE_INVALID", "Original input directory is unavailable.", { cause: error });
      });
      if (tree.treeHash !== input.sha256 || tree.totalBytes !== input.bytes) {
        throw new NexusError("SAVE_PACKAGE_INVALID", "Original input directory changed after inspection.");
      }
      return;
    }
    const actual = await sha256File(input.absolutePath).catch((error: unknown) => {
      throw new NexusError("SAVE_PACKAGE_INVALID", "Original input file is unavailable.", { cause: error });
    });
    if (actual !== input.sha256) {
      throw new NexusError("SAVE_PACKAGE_INVALID", "Original input file changed after inspection.");
    }
  }

  #requireMatchingRarCapability(
    extractor: { kind: string; executablePath: string | null; version: string } | null | undefined,
  ): RarCapability {
    const capability = this.#inspector.rarCapability;
    if (
      !capability ||
      extractor?.kind !== "unrar" ||
      extractor.executablePath === null ||
      path.resolve(extractor.executablePath) !== path.resolve(capability.executablePath) ||
      extractor.version !== capability.version
    ) {
      throw new NexusError("SAVE_INPUT_UNSUPPORTED", "The inspected RAR extractor capability changed.");
    }
    return capability;
  }

  #requireMatchingSevenZipCapability(
    extractor: { kind: string; executablePath: string | null; version: string } | null | undefined,
  ) {
    const capability = this.#inspector.sevenZipCapability;
    if (
      !capability ||
      extractor?.kind !== capability.kind ||
      extractor.executablePath === null ||
      path.resolve(extractor.executablePath) !== path.resolve(capability.executablePath) ||
      extractor.version !== capability.version
    ) {
      throw new NexusError("SAVE_INPUT_UNSUPPORTED", "The inspected 7z extractor capability changed.");
    }
    return capability;
  }

  async #verifyExtractedArchive(
    inspection: { entries: ReadonlyArray<{ normalizedPath: string; kind: string; bytes: number }> },
    extractedRoot: string,
  ): Promise<void> {
    const tree = await inspectDirectoryTree(extractedRoot).catch((error: unknown) => {
      throw new NexusError("SAVE_ARCHIVE_UNSAFE", "Extracted RAR tree is unsafe.", { cause: error });
    });
    const expected = inspection.entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => ({ relativePath: entry.normalizedPath, bytes: entry.bytes }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const actual = tree.files
      .map((file) => ({ relativePath: file.relativePath, bytes: file.bytes }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    if (sha256CanonicalJson(actual) !== sha256CanonicalJson(expected)) {
      throw new NexusError(
        "SAVE_ARCHIVE_UNSAFE",
        "Extracted RAR file set or sizes differ from the inspected inventory.",
      );
    }
  }
}
