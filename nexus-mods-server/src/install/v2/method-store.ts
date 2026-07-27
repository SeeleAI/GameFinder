import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../content-hash.js";
import {
  INSTALL_CONTRACT_V2_VERSION,
  installationMethodSchema,
  methodOutcomeSchema,
  methodStateSchema,
  verifyInstallationMethodHash,
  verifyMethodOutcomeHash,
} from "./contracts.js";
import type {
  InstallationMethod,
  MethodOutcome,
  MethodState,
} from "./contracts.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STATE_DIRECTORY: Readonly<Record<MethodState, string>> = {
  draft: "drafts",
  session_approved: "session-approved",
  local_verified: "local-verified",
  promoted: "promoted",
  quarantined: "quarantined",
  deprecated: "deprecated",
};

const ALLOWED_TRANSITIONS: Readonly<
  Record<MethodState, ReadonlySet<MethodState>>
> = {
  draft: new Set(["session_approved", "quarantined", "deprecated"]),
  session_approved: new Set(["local_verified", "quarantined", "deprecated"]),
  local_verified: new Set(["promoted", "quarantined", "deprecated"]),
  promoted: new Set(["quarantined", "deprecated"]),
  quarantined: new Set(["deprecated"]),
  deprecated: new Set(),
};

const methodIndexEntrySchema = z.object({
  methodId: z.string().uuid(),
  currentRevision: z.number().int().positive(),
  state: methodStateSchema,
  methodHash: z.string().regex(/^[a-f0-9]{64}$/),
  origin: z.enum(["agent_learned", "built_in", "imported"]),
  operatingSystems: z.array(z.enum(["win32", "linux", "darwin"])).max(3),
  gameIds: z.array(z.string().trim().min(1).max(200)).max(100),
  updatedAt: z.string().datetime(),
});

const methodIndexSchema = z.object({
  schemaVersion: z.literal(INSTALL_CONTRACT_V2_VERSION),
  updatedAt: z.string().datetime(),
  indexHash: z.string().regex(/^[a-f0-9]{64}$/),
  methods: z.array(methodIndexEntrySchema),
});

type MethodIndex = z.infer<typeof methodIndexSchema>;
type MethodIndexEntry = z.infer<typeof methodIndexEntrySchema>;

export interface MethodStoreListFilter {
  state?: MethodState;
  origin?: InstallationMethod["provenance"]["origin"];
  operatingSystem?: InstallationMethod["scope"]["operatingSystems"][number];
  gameId?: string;
}

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      `${label} must be a UUID.`,
    );
  }
}

function indexHash(index: Omit<MethodIndex, "indexHash">): string {
  return sha256CanonicalJson(index);
}

function verifyIndexHash(index: MethodIndex): boolean {
  const { indexHash: storedHash, ...payload } = index;
  return indexHash(payload) === storedHash;
}

function entryFor(method: InstallationMethod): MethodIndexEntry {
  const gameIds = method.scope.gameSelectors
    .filter(
      (signal) =>
        signal.kind === "game_identity" &&
        signal.expected !== null &&
        signal.operator === "equals",
    )
    .map((signal) => signal.expected as string)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((left, right) => left.localeCompare(right));

  return methodIndexEntrySchema.parse({
    methodId: method.methodId,
    currentRevision: method.revision,
    state: method.state,
    methodHash: method.methodHash,
    origin: method.provenance.origin,
    operatingSystems: [...method.scope.operatingSystems].sort(),
    gameIds,
    updatedAt: method.updatedAt,
  });
}

async function ensureRealDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new NexusError(
      "PROTECTED_PATH",
      "Method Store paths must be real directories.",
      { details: { directory } },
    );
  }
}

async function publishImmutable(
  filePath: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await link(temporaryPath, filePath);
  } catch (error) {
    throw new NexusError(
      "INSTALL_CONTRACT_INVALID",
      "An immutable Method Store object already exists.",
      { cause: error, details: { filePath } },
    );
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export function canTransitionMethod(
  from: MethodState,
  to: MethodState,
): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}

export class MethodStore {
  readonly #root: string;
  readonly #outcomesRoot: string;
  readonly #indexRoot: string;
  readonly #indexPath: string;

  private constructor(root: string) {
    this.#root = root;
    this.#outcomesRoot = path.join(root, "outcomes");
    this.#indexRoot = path.join(root, "index");
    this.#indexPath = path.join(this.#indexRoot, "current.json");
  }

  static async create(managerRoot: string): Promise<MethodStore> {
    if (!path.isAbsolute(managerRoot)) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Method Store managerRoot must be absolute.",
      );
    }
    const resolvedManagerRoot = path.resolve(managerRoot);
    if (resolvedManagerRoot === path.parse(resolvedManagerRoot).root) {
      throw new NexusError(
        "PROTECTED_PATH",
        "A filesystem root cannot be used as the Method Store managerRoot.",
      );
    }
    const root = path.join(resolvedManagerRoot, "methods");
    await ensureRealDirectory(root);
    for (const directory of Object.values(STATE_DIRECTORY)) {
      await ensureRealDirectory(path.join(root, directory));
    }
    await ensureRealDirectory(path.join(root, "outcomes"));
    await ensureRealDirectory(path.join(root, "index"));

    const store = new MethodStore(root);
    await store.rebuildIndex();
    return store;
  }

  async saveDraft(method: InstallationMethod): Promise<InstallationMethod> {
    const parsed = installationMethodSchema.parse(method);
    if (parsed.state !== "draft" || parsed.revision !== 1) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "A new learned Installation Method must begin as draft revision 1.",
      );
    }
    if (!verifyInstallationMethodHash(parsed)) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Installation Method hash does not match its content.",
      );
    }
    const existing = (await this.#readIndex()).methods.find(
      (entry) => entry.methodId === parsed.methodId,
    );
    if (existing) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Installation Method already exists.",
        { details: { methodId: parsed.methodId } },
      );
    }
    await this.#publishMethod(parsed);
    await this.#upsertIndex(entryFor(parsed));
    return parsed;
  }

  async transition(
    methodId: string,
    targetState: MethodState,
    options: {
      updatedAt?: string;
    } = {},
  ): Promise<InstallationMethod> {
    const current = await this.get(methodId);
    if (!canTransitionMethod(current.state, targetState)) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        `Installation Method cannot transition from ${current.state} to ${targetState}.`,
        {
          details: {
            methodId,
            currentState: current.state,
            targetState,
          },
        },
      );
    }
    const { methodHash: _methodHash, ...currentPayload } = current;
    const nextWithoutHash: Omit<InstallationMethod, "methodHash"> = {
      ...currentPayload,
      revision: current.revision + 1,
      state: targetState,
      updatedAt: options.updatedAt ?? new Date().toISOString(),
    };
    const next = installationMethodSchema.parse({
      ...nextWithoutHash,
      methodHash: sha256CanonicalJson(nextWithoutHash),
    });
    await this.#publishMethod(next);
    await this.#upsertIndex(entryFor(next));
    return next;
  }

  async get(
    methodId: string,
    revision?: number,
  ): Promise<InstallationMethod> {
    assertUuid(methodId, "methodId");
    if (revision !== undefined) {
      if (!Number.isSafeInteger(revision) || revision <= 0) {
        throw new NexusError(
          "INSTALL_CONTRACT_INVALID",
          "Method revision must be a positive integer.",
        );
      }
      const history = await this.history(methodId);
      const selected = history.find((method) => method.revision === revision);
      if (selected) return selected;
      throw new NexusError("NOT_FOUND", "Installation Method revision was not found.", {
        details: { methodId, revision },
      });
    }

    const index = await this.#readIndex();
    const entry = index.methods.find((item) => item.methodId === methodId);
    if (!entry) {
      throw new NexusError("NOT_FOUND", "Installation Method was not found.", {
        details: { methodId },
      });
    }
    return this.#readMethod(
      this.#revisionPath(entry.state, entry.methodId, entry.currentRevision),
    );
  }

  async history(methodId: string): Promise<ReadonlyArray<InstallationMethod>> {
    assertUuid(methodId, "methodId");
    const revisions = new Map<number, InstallationMethod>();
    for (const state of methodStateSchema.options) {
      const methodRoot = path.join(
        this.#root,
        STATE_DIRECTORY[state],
        methodId,
      );
      const files = await readdir(methodRoot).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const file of files) {
        if (!/^\d{8}\.json$/.test(file)) continue;
        const method = await this.#readMethod(path.join(methodRoot, file));
        if (revisions.has(method.revision)) {
          throw new NexusError(
            "RECOVERY_REQUIRED",
            "Method Store contains duplicate revision numbers.",
            { details: { methodId, revision: method.revision } },
          );
        }
        revisions.set(method.revision, method);
      }
    }
    return [...revisions.values()].sort(
      (left, right) => left.revision - right.revision,
    );
  }

  async list(
    filter: MethodStoreListFilter = {},
  ): Promise<ReadonlyArray<InstallationMethod>> {
    const index = await this.#readIndex();
    const selected = index.methods.filter(
      (entry) =>
        (filter.state === undefined || entry.state === filter.state) &&
        (filter.origin === undefined || entry.origin === filter.origin) &&
        (filter.operatingSystem === undefined ||
          entry.operatingSystems.includes(filter.operatingSystem)) &&
        (filter.gameId === undefined || entry.gameIds.includes(filter.gameId)),
    );
    return Promise.all(
      selected.map((entry) =>
        this.#readMethod(
          this.#revisionPath(
            entry.state,
            entry.methodId,
            entry.currentRevision,
          ),
        ),
      ),
    );
  }

  async appendOutcome(outcome: MethodOutcome): Promise<MethodOutcome> {
    const parsed = methodOutcomeSchema.parse(outcome);
    if (!verifyMethodOutcomeHash(parsed)) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Method Outcome hash does not match its content.",
      );
    }
    const method = await this.get(parsed.methodId, parsed.methodRevision);
    if (method.methodHash !== parsed.methodHash) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "Method Outcome does not match the referenced Method revision.",
      );
    }
    await publishImmutable(
      path.join(this.#outcomesRoot, `${parsed.outcomeId}.json`),
      parsed,
    );
    return parsed;
  }

  async listOutcomes(
    methodId?: string,
  ): Promise<ReadonlyArray<MethodOutcome>> {
    if (methodId !== undefined) assertUuid(methodId, "methodId");
    const files = await readdir(this.#outcomesRoot);
    const outcomes: MethodOutcome[] = [];
    for (const file of files.sort()) {
      if (!UUID_PATTERN.test(file.replace(/\.json$/, "")) || !file.endsWith(".json")) {
        continue;
      }
      const outcome = methodOutcomeSchema.parse(
        JSON.parse(
          await readFile(path.join(this.#outcomesRoot, file), "utf8"),
        ) as unknown,
      );
      if (!verifyMethodOutcomeHash(outcome)) {
        throw new NexusError(
          "RECOVERY_REQUIRED",
          "Method Store contains a corrupt Method Outcome.",
          { details: { outcomeId: outcome.outcomeId } },
        );
      }
      if (methodId === undefined || outcome.methodId === methodId) {
        outcomes.push(outcome);
      }
    }
    return outcomes.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  async rebuildIndex(): Promise<void> {
    const methods = new Map<string, InstallationMethod[]>();
    for (const state of methodStateSchema.options) {
      const stateRoot = path.join(this.#root, STATE_DIRECTORY[state]);
      const entries = await readdir(stateRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
        const history = methods.get(entry.name) ?? [];
        const files = await readdir(path.join(stateRoot, entry.name));
        for (const file of files) {
          if (!/^\d{8}\.json$/.test(file)) continue;
          history.push(
            await this.#readMethod(path.join(stateRoot, entry.name, file)),
          );
        }
        methods.set(entry.name, history);
      }
    }

    const currentEntries: MethodIndexEntry[] = [];
    for (const [methodId, history] of methods) {
      history.sort((left, right) => left.revision - right.revision);
      this.#validateHistory(methodId, history);
      const current = history.at(-1);
      if (current) currentEntries.push(entryFor(current));
    }
    await this.#writeIndex(currentEntries);
  }

  #validateHistory(
    methodId: string,
    history: ReadonlyArray<InstallationMethod>,
  ): void {
    if (history.length === 0) return;
    for (let index = 0; index < history.length; index += 1) {
      const method = history[index];
      if (!method) continue;
      if (method.methodId !== methodId || method.revision !== index + 1) {
        throw new NexusError(
          "RECOVERY_REQUIRED",
          "Method Store revision history is not contiguous.",
          {
            details: {
              methodId,
              expectedRevision: index + 1,
              actualRevision: method.revision,
            },
          },
        );
      }
      const previous = history[index - 1];
      if (previous && !canTransitionMethod(previous.state, method.state)) {
        throw new NexusError(
          "RECOVERY_REQUIRED",
          "Method Store contains an invalid state transition.",
          {
            details: {
              methodId,
              from: previous.state,
              to: method.state,
            },
          },
        );
      }
    }
  }

  async #publishMethod(method: InstallationMethod): Promise<void> {
    const methodRoot = path.dirname(
      this.#revisionPath(method.state, method.methodId, method.revision),
    );
    await ensureRealDirectory(methodRoot);
    await publishImmutable(
      this.#revisionPath(method.state, method.methodId, method.revision),
      method,
    );
  }

  async #readMethod(filePath: string): Promise<InstallationMethod> {
    try {
      const method = installationMethodSchema.parse(
        JSON.parse(await readFile(filePath, "utf8")) as unknown,
      );
      if (!verifyInstallationMethodHash(method)) {
        throw new Error("Installation Method hash mismatch.");
      }
      return method;
    } catch (error) {
      throw new NexusError(
        "RECOVERY_REQUIRED",
        "Installation Method revision is missing or corrupt.",
        { cause: error, details: { filePath } },
      );
    }
  }

  async #readIndex(): Promise<MethodIndex> {
    try {
      const index = methodIndexSchema.parse(
        JSON.parse(await readFile(this.#indexPath, "utf8")) as unknown,
      );
      if (!verifyIndexHash(index)) {
        throw new Error("Method index hash mismatch.");
      }
      return index;
    } catch (error) {
      throw new NexusError(
        "RECOVERY_REQUIRED",
        "Method Store index is missing or corrupt.",
        { cause: error, details: { indexPath: this.#indexPath } },
      );
    }
  }

  async #upsertIndex(entry: MethodIndexEntry): Promise<void> {
    const index = await this.#readIndex();
    const methods = index.methods.filter(
      (candidate) => candidate.methodId !== entry.methodId,
    );
    methods.push(entry);
    await this.#writeIndex(methods);
  }

  async #writeIndex(entries: ReadonlyArray<MethodIndexEntry>): Promise<void> {
    const payload = {
      schemaVersion: INSTALL_CONTRACT_V2_VERSION,
      updatedAt: new Date().toISOString(),
      methods: [...entries].sort((left, right) =>
        left.methodId.localeCompare(right.methodId),
      ),
    } as const;
    const index = methodIndexSchema.parse({
      ...payload,
      indexHash: indexHash(payload),
    });
    const temporaryPath = `${this.#indexPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(index, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, this.#indexPath);
  }

  #revisionPath(
    state: MethodState,
    methodId: string,
    revision: number,
  ): string {
    assertUuid(methodId, "methodId");
    return path.join(
      this.#root,
      STATE_DIRECTORY[state],
      methodId,
      `${String(revision).padStart(8, "0")}.json`,
    );
  }
}
