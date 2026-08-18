import path from "node:path";

import { NexusError } from "../../errors.js";
import {
  type GameInstallContext,
  type SaveContext,
  gameInstallContextSchema,
  hashWithoutField,
  saveContextSchema,
} from "../contracts.js";
import {
  assertUuid,
  ensureRealStoreDirectory,
  publishJsonExclusive,
  readStoredJson,
} from "./json-store.js";

export class SaveContextStore {
  readonly #installRoot: string;
  readonly #saveRoot: string;

  private constructor(installRoot: string, saveRoot: string) {
    this.#installRoot = installRoot;
    this.#saveRoot = saveRoot;
  }

  static async create(managerRoot: string): Promise<SaveContextStore> {
    const [installRoot, saveRoot] = await Promise.all([
      ensureRealStoreDirectory(managerRoot, "install-contexts"),
      ensureRealStoreDirectory(managerRoot, "save-contexts"),
    ]);
    return new SaveContextStore(installRoot, saveRoot);
  }

  async saveInstallContext(
    context: GameInstallContext,
  ): Promise<Readonly<GameInstallContext>> {
    const parsed = gameInstallContextSchema.parse(context);
    this.#verifyInstallHash(parsed);
    await publishJsonExclusive(
      path.join(this.#installRoot, `${parsed.installContextId}.json`),
      parsed,
    );
    return Object.freeze(parsed);
  }

  async getInstallContext(
    installContextId: string,
  ): Promise<Readonly<GameInstallContext>> {
    assertUuid(installContextId, "installContextId");
    const parsed = await readStoredJson(
      path.join(this.#installRoot, `${installContextId}.json`),
      gameInstallContextSchema,
      "Game Install Context was not found.",
    );
    if (parsed.installContextId !== installContextId) {
      throw new NexusError(
        "SAVE_CONTEXT_STALE",
        "Game Install Context identity does not match its storage key.",
        { details: { installContextId } },
      );
    }
    this.#verifyInstallHash(parsed);
    return Object.freeze(parsed);
  }

  async saveSaveContext(
    context: SaveContext,
  ): Promise<Readonly<SaveContext>> {
    const parsed = saveContextSchema.parse(context);
    this.#verifySaveHash(parsed);
    await publishJsonExclusive(
      path.join(this.#saveRoot, `${parsed.saveContextId}.json`),
      parsed,
    );
    return Object.freeze(parsed);
  }

  async getSaveContext(
    saveContextId: string,
  ): Promise<Readonly<SaveContext>> {
    assertUuid(saveContextId, "saveContextId");
    const parsed = await readStoredJson(
      path.join(this.#saveRoot, `${saveContextId}.json`),
      saveContextSchema,
      "Save Context was not found.",
    );
    if (parsed.saveContextId !== saveContextId) {
      throw new NexusError(
        "SAVE_CONTEXT_STALE",
        "Save Context identity does not match its storage key.",
        { details: { saveContextId } },
      );
    }
    this.#verifySaveHash(parsed);
    return Object.freeze(parsed);
  }

  #verifyInstallHash(context: GameInstallContext): void {
    const actualHash = hashWithoutField(context, "contextHash");
    if (actualHash !== context.contextHash) {
      throw new NexusError(
        "SAVE_CONTEXT_STALE",
        "Game Install Context hash verification failed.",
        {
          details: {
            installContextId: context.installContextId,
            expectedHash: context.contextHash,
            actualHash,
          },
        },
      );
    }
  }

  #verifySaveHash(context: SaveContext): void {
    const actualHash = hashWithoutField(context, "contextHash");
    if (actualHash !== context.contextHash) {
      throw new NexusError(
        "SAVE_CONTEXT_STALE",
        "Save Context hash verification failed.",
        {
          details: {
            saveContextId: context.saveContextId,
            expectedHash: context.contextHash,
            actualHash,
          },
        },
      );
    }
  }
}
