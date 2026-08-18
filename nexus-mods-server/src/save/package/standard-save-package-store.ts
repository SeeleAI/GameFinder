import { constants } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import { inspectDirectoryTree } from "../../install/core/tree-state.js";
import type { StandardSavePackage } from "../contracts.js";
import {
  hashWithoutField,
  standardSavePackageSchema,
} from "../contracts.js";
import { normalizeSaveRelativePath } from "../path-policy.js";
import {
  ensureRealStoreDirectory,
  publishJsonExclusive,
  readStoredJson,
} from "../storage/json-store.js";

export function standardPackageIdentityHash(
  value: Pick<StandardSavePackage, "game" | "payload" | "binding" | "format">,
): string {
  return sha256CanonicalJson({
    game: value.game,
    payload: {
      root: value.payload.root,
      files: value.payload.files.map(({ relativePath, bytes, sha256 }) => ({
        relativePath,
        bytes,
        sha256,
      })),
      treeHash: value.payload.treeHash,
    },
    binding: value.binding,
    format: value.format,
  });
}

export class StandardSavePackageStore {
  readonly #objectsRoot: string;
  readonly #manifestsRoot: string;

  private constructor(objectsRoot: string, manifestsRoot: string) {
    this.#objectsRoot = objectsRoot;
    this.#manifestsRoot = manifestsRoot;
  }

  static async create(managerRoot: string): Promise<StandardSavePackageStore> {
    const [objectsRoot, manifestsRoot] = await Promise.all([
      ensureRealStoreDirectory(managerRoot, "packages", "objects"),
      ensureRealStoreDirectory(managerRoot, "packages", "manifests"),
    ]);
    return new StandardSavePackageStore(objectsRoot, manifestsRoot);
  }

  async publish(
    value: StandardSavePackage,
    sourcePayloadRoot: string,
  ): Promise<Readonly<StandardSavePackage>> {
    const manifest = standardSavePackageSchema.parse(value);
    this.#verifyManifest(manifest);
    const existing = await this.get(manifest.packageId).catch((error: unknown) => {
      if (error instanceof NexusError && error.code === "NOT_FOUND") return null;
      throw error;
    });
    if (existing) return existing;

    const objectRoot = this.#objectRoot(manifest.packageId);
    const temporaryRoot = `${objectRoot}.${crypto.randomUUID()}.tmp`;
    const temporaryPayload = path.join(temporaryRoot, "payload");
    await mkdir(temporaryPayload, { recursive: true });
    try {
      for (const file of manifest.payload.files) {
        const relativePath = normalizeSaveRelativePath(file.relativePath);
        const source = path.resolve(sourcePayloadRoot, ...relativePath.split("/"));
        const target = path.resolve(temporaryPayload, ...relativePath.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(source, target, constants.COPYFILE_EXCL);
      }
      await this.#verifyPayload(manifest, temporaryPayload);
      await mkdir(path.dirname(objectRoot), { recursive: true });
      try {
        await rename(temporaryRoot, objectRoot);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          !["EEXIST", "ENOTEMPTY"].includes(String(error.code))
        ) {
          throw error;
        }
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    await this.#verifyPayload(manifest, this.payloadRoot(manifest.packageId));
    await publishJsonExclusive(this.#manifestPath(manifest.packageId), manifest);
    return Object.freeze(manifest);
  }

  async get(packageId: string): Promise<Readonly<StandardSavePackage>> {
    this.#assertPackageId(packageId);
    const manifest = await readStoredJson(
      this.#manifestPath(packageId),
      standardSavePackageSchema,
      "Standard Save Package was not found.",
    );
    if (manifest.packageId !== packageId) {
      throw new NexusError(
        "SAVE_PACKAGE_INVALID",
        "Standard Save Package identity does not match its storage key.",
      );
    }
    this.#verifyManifest(manifest);
    return Object.freeze(manifest);
  }

  async verify(packageId: string): Promise<Readonly<StandardSavePackage>> {
    const manifest = await this.get(packageId);
    await this.#verifyPayload(manifest, this.payloadRoot(packageId));
    return manifest;
  }

  payloadRoot(packageId: string): string {
    return path.join(this.#objectRoot(packageId), "payload");
  }

  #verifyManifest(manifest: StandardSavePackage): void {
    if (hashWithoutField(manifest, "manifestHash") !== manifest.manifestHash) {
      throw new NexusError("SAVE_PACKAGE_INVALID", "Standard Save Package manifest hash failed.");
    }
    const expectedId = `savepkg-${standardPackageIdentityHash(manifest)}`;
    if (manifest.packageId !== expectedId) {
      throw new NexusError(
        "SAVE_PACKAGE_INVALID",
        "Standard Save Package ID is not derived from its payload identity.",
        { details: { expectedId, packageId: manifest.packageId } },
      );
    }
  }

  async #verifyPayload(
    manifest: StandardSavePackage,
    payloadRoot: string,
  ): Promise<void> {
    const tree = await inspectDirectoryTree(payloadRoot).catch((error: unknown) => {
      throw new NexusError("SAVE_PACKAGE_INVALID", "Package payload is missing or unsafe.", {
        cause: error,
      });
    });
    const actualFiles = tree.files
      .map((file) => ({
        relativePath: file.relativePath,
        bytes: file.bytes,
        sha256: file.sha256,
      }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const expectedFiles = manifest.payload.files
      .map(({ relativePath, bytes, sha256 }) => ({ relativePath, bytes, sha256 }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    if (
      sha256CanonicalJson(actualFiles) !== sha256CanonicalJson(expectedFiles) ||
      sha256CanonicalJson(expectedFiles) !== manifest.payload.treeHash
    ) {
      throw new NexusError(
        "SAVE_PACKAGE_INVALID",
        "Standard Save Package payload verification failed.",
      );
    }
  }

  #objectRoot(packageId: string): string {
    this.#assertPackageId(packageId);
    const hash = packageId.slice("savepkg-".length);
    return path.join(this.#objectsRoot, hash.slice(0, 2), packageId);
  }

  #manifestPath(packageId: string): string {
    this.#assertPackageId(packageId);
    return path.join(this.#manifestsRoot, `${packageId}.json`);
  }

  #assertPackageId(packageId: string): void {
    if (!/^savepkg-[a-f0-9]{64}$/.test(packageId)) {
      throw new NexusError("SAVE_PACKAGE_INVALID", "packageId has an invalid format.");
    }
  }
}
