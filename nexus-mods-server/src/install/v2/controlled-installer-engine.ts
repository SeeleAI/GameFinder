import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import path from "node:path";

import { NexusError } from "../../errors.js";
import { assertSensitiveProcessesStopped } from "../core/process-guard.js";
import {
  inspectDirectoryTree,
  inspectPathState,
} from "../core/tree-state.js";
import { sha256File } from "../file-hash.js";
import {
  assertNoReparsePointTraversal,
  normalizeManagedRelativePath,
  resolveManagedTarget,
} from "../path-policy.js";
import { BackupStore } from "../storage/backup-store.js";
import { InstanceLock } from "../core/instance-lock.js";
import type {
  BundledInstallerOperation,
  DynamicGameContext,
  InstallPlanV2,
  InstallerExecutionContext,
  InstallerInstallationRecord,
  MethodCheck,
  ScopedPath,
} from "./contracts.js";
import { installerInstallationRecordSchema } from "./contracts.js";
import {
  ControlledInstallerJournalStore,
  type ControlledInstallerJournal,
} from "./controlled-installer-journal-store.js";

interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

interface RootCapture {
  root: ScopedPath;
  absolutePath: string;
  preState: Awaited<ReturnType<typeof inspectPathState>>;
  backupId: string | null;
}

const OUTPUT_LIMIT = 64 * 1024;

function appendBounded(current: string, chunk: Buffer): string {
  if (current.length >= OUTPUT_LIMIT) return current;
  return `${current}${chunk.toString("utf8")}`.slice(0, OUTPUT_LIMIT);
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const names =
    process.platform === "win32"
      ? ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP"]
      : ["PATH", "HOME", "TMPDIR", "LANG"];
  return Object.fromEntries(
    names.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
  );
}

async function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}

async function runControlledProcess(input: {
  operation: BundledInstallerOperation;
  entryAbsolutePath: string;
  workingDirectoryAbsolutePath: string;
}): Promise<ProcessResult> {
  const command =
    input.operation.entry.runtime === "native"
      ? input.entryAbsolutePath
      : input.operation.entry.runtime === "dotnet"
        ? "dotnet"
        : process.execPath;
  const args =
    input.operation.entry.runtime === "native"
      ? input.operation.arguments
      : [input.entryAbsolutePath, ...input.operation.arguments];
  return await new Promise<ProcessResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, {
      cwd: input.workingDirectoryAbsolutePath,
      env: minimalEnvironment(),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child.pid ?? -1);
    }, input.operation.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(
        new NexusError(
          "APPLY_FAILED",
          "The controlled installer process could not be started.",
          { cause: error, details: { command, runtime: input.operation.entry.runtime } },
        ),
      );
    });
    child.once("exit", (exitCode, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

async function treeFingerprint(root: string): Promise<Map<string, string>> {
  const tree = await inspectDirectoryTree(root);
  return new Map([
    ...tree.directories.map(
      (directory) => [directory.relativePath, "directory"] as const,
    ),
    ...tree.files.map(
      (file) =>
        [file.relativePath, `file:${file.bytes}:${file.sha256}`] as const,
    ),
  ]);
}

function changedPaths(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys]
    .filter((key) => before.get(key) !== after.get(key))
    .sort((left, right) => left.localeCompare(right));
}

function withinDeclaredRoot(
  relativePath: string,
  roots: ReadonlyArray<RootCapture>,
): boolean {
  const folded = relativePath.toLowerCase();
  return roots.some((capture) => {
    const root = capture.root.path.toLowerCase();
    return folded === root || folded.startsWith(`${root}/`);
  });
}

async function restoreCaptures(
  captures: ReadonlyArray<RootCapture>,
  backups: BackupStore,
): Promise<void> {
  for (const capture of [...captures].reverse()) {
    await rm(capture.absolutePath, { recursive: true, force: true });
    if (capture.backupId === null) continue;
    if (capture.preState.kind === "file") {
      await backups.restoreFile(capture.backupId, capture.absolutePath);
    } else if (capture.preState.kind === "directory") {
      await backups.restoreTree(capture.backupId, capture.absolutePath);
    }
  }
}

async function filesystemCheck(
  check: MethodCheck,
  context: DynamicGameContext,
): Promise<boolean | null> {
  if (
    !["path_exists", "path_absent", "file_hash", "tree_hash"].includes(
      check.kind,
    )
  ) {
    return null;
  }
  const relative = normalizeManagedRelativePath(
    check.subject,
    context.instance.operatingSystem,
  );
  const absolute = path.resolve(
    context.instance.gameRoot,
    ...relative.split("/"),
  );
  await assertNoReparsePointTraversal(
    context.instance.gameRoot,
    absolute,
    context.instance.operatingSystem,
  );
  const state = await inspectPathState(absolute);
  if (check.kind === "path_exists") return state.kind !== "absent";
  if (check.kind === "path_absent") return state.kind === "absent";
  if (check.kind === "file_hash") {
    return state.kind === "file" && state.sha256 === check.expected;
  }
  return state.kind === "directory" && state.treeHash === check.expected;
}

export class ControlledInstallerEngine {
  readonly #managerRoot: string;
  readonly #backups: BackupStore;
  readonly #journals: ControlledInstallerJournalStore;

  private constructor(
    managerRoot: string,
    backups: BackupStore,
    journals: ControlledInstallerJournalStore,
  ) {
    this.#managerRoot = managerRoot;
    this.#backups = backups;
    this.#journals = journals;
  }

  static async create(managerRoot: string): Promise<ControlledInstallerEngine> {
    const [backups, journals] = await Promise.all([
      BackupStore.create(managerRoot),
      ControlledInstallerJournalStore.create(managerRoot),
    ]);
    return new ControlledInstallerEngine(
      path.resolve(managerRoot),
      backups,
      journals,
    );
  }

  async apply(input: {
    plan: InstallPlanV2;
    execution: InstallerExecutionContext;
    context: DynamicGameContext;
  }): Promise<InstallerInstallationRecord> {
    const operation = input.plan.operations[0];
    if (
      input.plan.operations.length !== 1 ||
      operation?.kind !== "run_bundled_installer"
    ) {
      throw new NexusError(
        "INSTALL_CONTRACT_INVALID",
        "The controlled installer engine requires exactly one installer operation.",
      );
    }
    if (
      input.execution.planId !== input.plan.planId ||
      input.execution.planHash !== input.plan.planHash
    ) {
      throw new NexusError(
        "PLAN_STALE",
        "Installer execution context does not match the frozen plan.",
      );
    }
    const existingJournal = await this.#journals.get(input.plan.planId);
    if (existingJournal !== null) {
      return await this.#recoverInterrupted({
        plan: input.plan,
        context: input.context,
        journal: existingJournal,
        operation,
      });
    }

    const transactionId = randomUUID();
    const installationId = randomUUID();
    const lock = new InstanceLock({
      locksRoot: path.join(this.#managerRoot, "locks"),
      instanceId: input.context.gameContextId,
      transactionId,
    });
    const captures: RootCapture[] = [];
    let processResult: ProcessResult = {
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    };
    let observedChanges: string[] = [];
    let unexpectedChanges: string[] = [];
    let recoveryAttempted = false;
    let recoveryCompleted = false;
    let recoveryMessage: string | null = null;
    let state: InstallerInstallationRecord["state"] = "failed_before_write";
    let staticVerification: InstallerInstallationRecord["verification"]["static"] =
      "not_run";

    await lock.acquire();
    try {
      let journal: ControlledInstallerJournal = {
        schemaVersion: 2,
        planId: input.plan.planId,
        planHash: input.plan.planHash,
        transactionId,
        phase: "preflight",
        captures: [],
        process: processResult,
        observedChanges: [],
        unexpectedChanges: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      journal = await this.#journals.save(journal, { create: true });
      await assertSensitiveProcessesStopped(
        input.context.processes.lockSensitiveProcessNames,
      );
      const before = await treeFingerprint(input.context.instance.gameRoot);
      for (const snapshot of operation.preStateSnapshots) {
        const resolved = resolveManagedTarget({
          gameRoot: input.context.instance.gameRoot,
          targetRelativePath: snapshot.root.path,
          writableRoots: input.context.pathPolicy.writableRoots.map(
            (root) => root.path,
          ).concat(snapshot.root.path),
          protectedRoots: input.context.pathPolicy.protectedRoots.map(
            (root) => root.path,
          ),
          platform: input.context.instance.operatingSystem,
        });
        await assertNoReparsePointTraversal(
          resolved.gameRoot,
          resolved.targetAbsolutePath,
          input.context.instance.operatingSystem,
        );
        const preState = await inspectPathState(resolved.targetAbsolutePath);
        if (JSON.stringify(preState) !== JSON.stringify(snapshot.expectedPreState)) {
          throw new NexusError(
            "PLAN_STALE",
            "A declared installer write root changed after plan freezing.",
            { details: { root: snapshot.root.path } },
          );
        }
        let backupId: string | null = null;
        if (preState.kind === "file") {
          backupId = (await this.#backups.backupFile(resolved.targetAbsolutePath)).backupId;
        } else if (preState.kind === "directory") {
          backupId = (await this.#backups.backupTree(resolved.targetAbsolutePath)).backupId;
        }
        captures.push({
          root: snapshot.root,
          absolutePath: resolved.targetAbsolutePath,
          preState,
          backupId,
        });
      }
      journal = await this.#journals.save({
        ...journal,
        phase: "backed_up",
        captures,
        updatedAt: new Date().toISOString(),
      });

      const entryAbsolutePath = path.resolve(
        input.execution.stagingRoot,
        ...operation.entry.relativePath.split("/"),
      );
      const workingDirectoryAbsolutePath = path.resolve(
        input.execution.stagingRoot,
        ...operation.workingDirectory.split("/"),
      );
      await assertNoReparsePointTraversal(
        input.execution.stagingRoot,
        entryAbsolutePath,
      );
      await assertNoReparsePointTraversal(
        input.execution.stagingRoot,
        workingDirectoryAbsolutePath,
      );
      if ((await sha256File(entryAbsolutePath)) !== operation.entry.sha256) {
        throw new NexusError(
          "EVIDENCE_CONFLICT",
          "The staged installer entry hash no longer matches the frozen plan.",
        );
      }
      journal = await this.#journals.save({
        ...journal,
        phase: "process_started",
        updatedAt: new Date().toISOString(),
      });
      processResult = await runControlledProcess({
        operation,
        entryAbsolutePath,
        workingDirectoryAbsolutePath,
      });
      const after = await treeFingerprint(input.context.instance.gameRoot);
      observedChanges = changedPaths(before, after);
      unexpectedChanges = observedChanges.filter(
        (changed) => !withinDeclaredRoot(changed, captures),
      );
      journal = await this.#journals.save({
        ...journal,
        phase: "process_finished",
        process: processResult,
        observedChanges,
        unexpectedChanges,
        updatedAt: new Date().toISOString(),
      });
      const exitAllowed =
        !processResult.timedOut &&
        processResult.exitCode !== null &&
        operation.allowedExitCodes.includes(processResult.exitCode);
      const checks = await Promise.all(
        operation.postConditions.map((check) => filesystemCheck(check, input.context)),
      );
      const requiredChecksPassed = operation.postConditions.every(
        (check, index) => !check.required || checks[index] === true,
      );
      staticVerification =
        exitAllowed && requiredChecksPassed && unexpectedChanges.length === 0
          ? "passed"
          : "failed";
      if (staticVerification === "passed") {
        state = "installed";
      } else {
        recoveryAttempted = true;
        await restoreCaptures(captures, this.#backups);
        recoveryCompleted = unexpectedChanges.length === 0;
        recoveryMessage =
          unexpectedChanges.length === 0
            ? "Declared write roots were restored to their frozen pre-state."
            : "Declared roots were restored, but undeclared game-root changes require manual recovery.";
        state = recoveryCompleted ? "rolled_back" : "recovery_required";
      }
      await this.#journals.save({
        ...journal,
        phase:
          state === "installed"
            ? "committed"
            : state === "rolled_back"
              ? "rolled_back"
              : "recovery_required",
        process: processResult,
        observedChanges,
        unexpectedChanges,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (captures.length > 0) {
        recoveryAttempted = true;
        try {
          await restoreCaptures(captures, this.#backups);
          recoveryCompleted = true;
          recoveryMessage = "Declared write roots were restored after installer failure.";
          state = "rolled_back";
        } catch (restoreError) {
          recoveryMessage =
            restoreError instanceof Error ? restoreError.message : String(restoreError);
          state = "recovery_required";
        }
      }
      if (processResult.stderr.length === 0) {
        processResult.stderr =
          error instanceof Error ? error.message : String(error);
      }
      const journal = await this.#journals.get(input.plan.planId);
      if (journal !== null) {
        await this.#journals.save({
          ...journal,
          phase:
            state === "rolled_back" ? "rolled_back" : "recovery_required",
          process: processResult,
          observedChanges,
          unexpectedChanges,
          updatedAt: new Date().toISOString(),
        });
      }
    } finally {
      await lock.release();
    }

    const declaredRoots = await Promise.all(
      captures.map(async (capture) => ({
        root: capture.root,
        preState: capture.preState,
        postState: await inspectPathState(capture.absolutePath),
        backupId: capture.backupId,
      })),
    );
    return installerInstallationRecordSchema.parse({
      schemaVersion: 2,
      installationId,
      transactionId,
      planId: input.plan.planId,
      planHash: input.plan.planHash,
      evidencePackId: input.plan.evidenceBinding.evidencePackId,
      gameContextId: input.context.gameContextId,
      gameRoot: input.context.instance.gameRoot,
      bundle:
        input.plan.source.bundleId === null ||
        input.plan.source.bundleNodeId === null
          ? null
          : {
              bundleId: input.plan.source.bundleId,
              nodeId: input.plan.source.bundleNodeId,
            },
      state,
      process: {
        runtime: operation.entry.runtime,
        entryRelativePath: operation.entry.relativePath,
        entrySha256: operation.entry.sha256,
        arguments: operation.arguments,
        ...processResult,
      },
      declaredRoots,
      observedChanges,
      unexpectedChanges,
      verification: {
        static: staticVerification,
        contextReprobed: false,
      },
      reversibilityLevel: operation.reversibilityLevel,
      recovery: {
        attempted: recoveryAttempted,
        completed: recoveryCompleted,
        message: recoveryMessage,
      },
      installedAt: new Date().toISOString(),
    });
  }

  async #recoverInterrupted(input: {
    plan: InstallPlanV2;
    context: DynamicGameContext;
    journal: ControlledInstallerJournal;
    operation: BundledInstallerOperation;
  }): Promise<InstallerInstallationRecord> {
    if (
      input.journal.planHash !== input.plan.planHash ||
      input.journal.planId !== input.plan.planId
    ) {
      throw new NexusError(
        "RECOVERY_REQUIRED",
        "Controlled installer journal does not match the immutable plan.",
      );
    }
    const captures: RootCapture[] = input.journal.captures.map((capture) => {
      const resolved = resolveManagedTarget({
        gameRoot: input.context.instance.gameRoot,
        targetRelativePath: capture.root.path,
        writableRoots: input.context.pathPolicy.writableRoots.map(
          (root) => root.path,
        ).concat(capture.root.path),
        protectedRoots: input.context.pathPolicy.protectedRoots.map(
          (root) => root.path,
        ),
        platform: input.context.instance.operatingSystem,
      });
      if (path.resolve(capture.absolutePath) !== path.resolve(resolved.targetAbsolutePath)) {
        throw new NexusError(
          "RECOVERY_REQUIRED",
          "A controlled installer journal path no longer matches game policy.",
        );
      }
      return capture;
    });
    let recoveryCompleted = false;
    let recoveryMessage: string;
    let state: InstallerInstallationRecord["state"];
    if (input.journal.phase === "committed") {
      state = "installed";
      recoveryMessage =
        "Recovered the durable success result from a committed installer journal.";
    } else {
      try {
        await restoreCaptures(captures, this.#backups);
        const sideEffectsProven =
          input.journal.phase === "preflight" ||
          input.journal.phase === "backed_up" ||
          (input.journal.phase === "process_finished" &&
            input.journal.unexpectedChanges.length === 0) ||
          input.journal.phase === "rolled_back";
        recoveryCompleted = sideEffectsProven;
        state = sideEffectsProven ? "rolled_back" : "recovery_required";
        recoveryMessage = sideEffectsProven
          ? "Recovered declared roots from the interrupted installer journal."
          : "Declared roots were restored, but interruption occurred while process side effects were not fully observed.";
      } catch (error) {
        state = "recovery_required";
        recoveryMessage =
          error instanceof Error ? error.message : String(error);
      }
    }
    const declaredRoots = await Promise.all(
      captures.map(async (capture) => ({
        root: capture.root,
        preState: capture.preState,
        postState: await inspectPathState(capture.absolutePath),
        backupId: capture.backupId,
      })),
    );
    return installerInstallationRecordSchema.parse({
      schemaVersion: 2,
      installationId: randomUUID(),
      transactionId: input.journal.transactionId,
      planId: input.plan.planId,
      planHash: input.plan.planHash,
      evidencePackId: input.plan.evidenceBinding.evidencePackId,
      gameContextId: input.context.gameContextId,
      gameRoot: input.context.instance.gameRoot,
      bundle:
        input.plan.source.bundleId === null ||
        input.plan.source.bundleNodeId === null
          ? null
          : {
              bundleId: input.plan.source.bundleId,
              nodeId: input.plan.source.bundleNodeId,
            },
      state,
      process: {
        runtime: input.operation.entry.runtime,
        entryRelativePath: input.operation.entry.relativePath,
        entrySha256: input.operation.entry.sha256,
        arguments: input.operation.arguments,
        ...input.journal.process,
      },
      declaredRoots,
      observedChanges: input.journal.observedChanges,
      unexpectedChanges: input.journal.unexpectedChanges,
      verification: {
        static: state === "installed" ? "passed" : "blocked",
        contextReprobed: false,
      },
      reversibilityLevel: input.operation.reversibilityLevel,
      recovery: {
        attempted: input.journal.phase !== "committed",
        completed: recoveryCompleted,
        message: recoveryMessage,
      },
      installedAt: new Date().toISOString(),
    });
  }
}
