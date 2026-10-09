import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import type { NexusBrowserAutomation } from "./browser/browser-service.js";
import { NexusBrowserService } from "./browser/browser-service.js";
import { BrowserDownloadManager } from "./browser-download-manager.js";
import {
  classifyDownloadPlanReview,
  DownloadBundleService
} from "./download-bundle-service.js";
import { DownloadManager, selectDownloadFile } from "./download-manager.js";
import { asNexusError, NexusError } from "./errors.js";
import {
  InstallService,
  resolveDefaultManagerRoot
} from "./install/install-service.js";
import { LocalInstallationQueryService } from "./install/local-installation-query.js";
import {
  AgenticInstallService,
  collectDependencyClosure,
  installProposalDraftSchema
} from "./install/v2/index.js";
import { NexusClient } from "./nexus-client.js";
import {
  effectivePlanReview,
  planReviewModeSchema,
  type PlanReview,
  type PlanReviewAction
} from "./plan-review.js";
import { GenericSaveImportService, saveImportInputSchema } from "./save/generic/import-service.js";
import { resolveDefaultSaveManagerRoot } from "./save/manager-root.js";
import { DirectSaveBackupService, directSaveBackupInputSchema } from "./save/generic/backup-service.js";
import { LegacySaveRecoveryService, legacySaveRecoveryInputSchema } from "./save/legacy/recovery-service.js";
import { EldenRingFileService, eldenRingAnalyzeInputSchema, eldenRingPrepareInputSchema } from "./save/formats/elden-ring.js";
import type { QuotaSnapshot, ResponseMeta } from "./types.js";
import { parseGameRef, parseModRef } from "./url.js";

const SERVER_NAME = "nexus-mods-server";
const SERVER_VERSION = "0.1.0";

function meta(source: ResponseMeta["source"], quota: QuotaSnapshot | null, warnings: string[] = []): ResponseMeta {
  return {
    source,
    fetchedAt: new Date().toISOString(),
    cache: "bypass",
    quota,
    warnings
  };
}

function ok(summary: string, structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent
  };
}

const preparedDownloadOutputSchema = {
  ok: z.literal(true),
  download: z.object({
    sessionId: z.string().uuid().describe("Opaque local session handle required by the next download tool."),
    backend: z.enum(["native", "persistent_chromium"]),
    state: z.string(),
    expiresAt: z.string()
  }).passthrough(),
  meta: z.object({}).passthrough()
};


const genericSaveResultSchema = {
  ok: z.literal(true),
  plan: z.object({ planId: z.string().uuid() }).passthrough(),
  operation: z.object({ planId: z.string().uuid(), state: z.string() }).passthrough().nullable(),
  backupFiles: z.array(z.object({}).passthrough()),
  recoveryFiles: z.array(z.object({}).passthrough()),
  recordPath: z.string(), backupRoot: z.string(), runtimeVerification: z.literal("not_performed"),
  meta: z.object({}).passthrough()
};

function downloadContinuationSummary(
  summary: string,
  prepared: {
    sessionId: string;
    backend: "native" | "persistent_chromium";
    state: string;
    expiresAt: string;
  }
): string {
  const nextTool = prepared.backend === "persistent_chromium"
    ? "start_download"
    : prepared.state === "ready"
      ? "download_mod_file"
      : "get_download_status";
  return [
    summary,
    "Download continuation (retain these values even if structuredContent is unavailable):",
    `sessionId: ${prepared.sessionId}`,
    `backend: ${prepared.backend}`,
    `nextTool: ${nextTool}`,
    `expiresAt: ${prepared.expiresAt}`
  ].join("\n");
}

function reviewForPlan(input: {
  review: PlanReview | undefined;
  action: PlanReviewAction;
  targetIds: string[];
  planHash: string;
}): PlanReview {
  return effectivePlanReview(input.review, {
    action: input.action,
    targetIds: input.targetIds,
    planHash: input.planHash
  });
}

function reviewSummary(label: string, planId: string, review: PlanReview): string {
  if (review.nextAction === "apply_now") {
    return `${label} ${planId} is auto_safe and may be applied in the same turn.`;
  }
  if (review.nextAction === "request_confirmation") {
    return `${label} ${planId} is review_required and needs confirmation of this exact current Plan.`;
  }
  return `${label} ${planId} is blocked and must not be applied.`;
}

async function safe(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    const nexusError = asNexusError(error);
    const structuredContent: Record<string, unknown> = {
      ok: false,
      error: {
        code: nexusError.code,
        message: nexusError.message,
        retryable: nexusError.retryable,
        nextAction: installErrorNextAction(nexusError.code),
        ...(nexusError.status === undefined ? {} : { status: nexusError.status }),
        ...(nexusError.details === undefined ? {} : { details: nexusError.details })
      }
    };
    return {
      isError: true,
      content: [{ type: "text", text: `${nexusError.code}: ${nexusError.message}` }],
      structuredContent
    };
  }
}

function installErrorNextAction(code: string): string | null {
  const actions: Record<string, string> = {
    INPUT_RECEIPT_MISMATCH:
      "Use the exact archive and .nexus-receipt.json produced by download-nexus-mods; do not edit either file.",
    ARCHIVE_UNSUPPORTED:
      "Use a supported ZIP archive or stop; Phase 6B does not convert archive formats.",
    ARCHIVE_UNSAFE:
      "Stop installation and inspect the archive source; do not bypass archive safety checks.",
    ARCHIVE_LIMIT_EXCEEDED:
      "Stop and review the archive size and entry count before changing configured limits.",
    PLAN_REVIEW_BLOCKED:
      "Do not apply this Plan; resolve its review reason codes and generate a fresh Plan.",
    GAME_PROFILE_NOT_FOUND:
      "Call list_game_profiles and choose a registered profile.",
    GAME_INSTANCE_NOT_FOUND:
      "Provide the exact game installation root, then call probe_game_install.",
    ADAPTER_NOT_FOUND:
      "No deterministic installer supports this package; do not copy files manually.",
    ADAPTER_AMBIGUOUS:
      "Inspect package units and obtain an explicit packageUnitId before planning again.",
    DEPENDENCY_MISSING:
      "Install or repair the reported game loader dependency, then probe and plan again.",
    INSTALL_CONFLICT:
      "Review the reported target conflicts; do not force or delete existing files manually.",
    GAME_PROCESS_RUNNING:
      "Close the game and loader processes, then generate or apply a fresh plan.",
    PLAN_STALE:
      "Call plan_mod_install again and review the new plan before applying.",
    LOCK_BUSY:
      "Wait for the active transaction on this game instance to finish.",
    VERIFY_FAILED:
      "Do not claim success; inspect the returned transaction and verification evidence.",
    ROLLBACK_FAILED:
      "Stop writes and use rollback_mod_install with the reported transactionId.",
    RECOVERY_REQUIRED:
      "Recover through the originating workflow: restore_save_import(planId) for generic saves, or rollback_mod_install(transactionId) for legacy Mod transactions. Do not replay interrupted writes.",
    DEPENDENCY_UNRESOLVED:
      "Review the normalized dependency graph and resolve every required external, unavailable, cyclic, or depth-limited node.",
    DOWNLOAD_PLAN_STALE:
      "Generate and review a new dependency-aware Download Plan.",
    BUNDLE_INCOMPLETE:
      "Download every planned file and pass each verified receipt before creating the Bundle Manifest.",
    BUNDLE_INVALID:
      "Use the immutable Bundle Manifest and exact archives/receipts produced by the dependency-aware download workflow.",
    GAME_CONTEXT_REQUIRED:
      "Probe the exact game root with probe_game_context, supplying explicit boundaries when no registered legacy profile exists.",
    EVIDENCE_CONFLICT:
      "Recreate the Evidence Pack from the exact verified archive and receipt; do not reuse a stale Proposal or Plan.",
    METHOD_STALE:
      "Query installation methods again and bind a new Proposal to the current Method revision, or submit a fully evidenced agent proposal.",
    METHOD_QUARANTINED:
      "Do not reuse this Method; query alternatives or submit a new bounded agent proposal from current evidence.",
    METHOD_RESEARCH_REQUIRED:
      "Inspect the Evidence Pack and Dynamic Game Context, research the package locally, then submit a bounded agent proposal.",
    PROPOSAL_INVALID:
      "Correct the Proposal so its package selection, source paths, target roots, ownership, and evidence bindings are exact.",
    USER_CHOICE_REQUIRED:
      "Resolve every reported choice with the user, then submit a new Proposal with no unresolved choices.",
    OPERATION_CAPABILITY_MISSING:
      "This MCP build cannot safely execute the proposed operation yet; preserve the evidence and stop before modifying the game.",
    DEPENDENTS_EXIST:
      "Keep the dependency installed. Uninstall or migrate every reported active dependent first, then inspect and generate a fresh Uninstall Plan.",
    INSTALLATION_DIRTY:
      "Stop before uninstall. Review the reported modified, protected, or replaced managed paths; do not force-delete them.",
    UNINSTALL_BLOCKED:
      "Inspect the Installation Record and Uninstall Plan state. Do not substitute rollback_mod_install or manual deletion.",
    SAVE_PATH_INVALID:
      "Correct the target so it is a safe relative path under the specific save target root.",
    SAVE_PATH_PROTECTED:
      "Stop; the requested path is broad, unmanaged, or traverses a reparse point.",
    SAVE_CONVERSION_REQUIRED:
      "The required internal conversion is not supported; preserve the input and use a suitable format-specific tool.",
    SAVE_PROCESS_RUNNING:
      "Close the game and every reported lock-sensitive platform process, then create a fresh backup or restore plan.",
    SAVE_SOURCE_CHANGED_DURING_BACKUP:
      "Close the game and synchronization clients, then retry the backup after the selected files are stable.",
    SAVE_BACKUP_INVALID:
      "Stop restore work; inspect and verify the selected Save Backup before generating a new plan.",
    SAVE_INPUT_UNSUPPORTED:
      "Provide a supported regular file, directory, ZIP, RAR with UnRAR, or 7z with a discovered bsdtar capability.",
    SAVE_ARCHIVE_UNSAFE:
      "Stop staging and inspect the source; do not bypass archive path, type, size, or extraction checks.",
    SAVE_INPUT_INVALID:
      "Inspect the frozen input; create a new import plan only after resolving source drift or corruption.",
    SAVE_TARGET_DRIFTED:
      "Do not retry the old plan; inspect current save state and generate a fresh save import plan.",
    SAVE_RESCUE_BACKUP_FAILED:
      "Stop before writing. Resolve the backup or process problem, then generate a fresh save import plan.",
    SAVE_STATIC_VERIFICATION_FAILED:
      "Do not claim success; preserve the transaction and rescue backup for recovery review.",
    SAVE_ROLLBACK_FAILED:
      "Stop all save writes and preserve the reported transaction and rescue backup for manual recovery."
  };
  return actions[code] ?? null;
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
};

const localReadOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

const localStateAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
};

export interface NexusMcpService {
  server: McpServer;
  close: () => Promise<void>;
}

export function createNexusMcpServer(
  client = new NexusClient(),
  browser: NexusBrowserAutomation = new NexusBrowserService(),
  options: {
    managerRoot?: string;
    saveManagerRoot?: string;
    saveProcessGuard?: (processNames: ReadonlyArray<string>) => Promise<void>;
  } = {}
): NexusMcpService {
  const downloads = new DownloadManager(client);
  const browserDownloads = new BrowserDownloadManager(browser);
  const sessionBackends = new Map<string, "native" | "persistent_chromium">();
  const managerRoot = options.managerRoot ?? resolveDefaultManagerRoot();
  const saveManagerRoot =
    options.saveManagerRoot ??
    (options.managerRoot === undefined
      ? resolveDefaultSaveManagerRoot()
      : managerRoot);
  let installServicePromise: Promise<InstallService> | undefined;
  let agenticInstallServicePromise: Promise<AgenticInstallService> | undefined;
  let localInstallationQueryServicePromise:
    | Promise<LocalInstallationQueryService>
    | undefined;
  let downloadBundleServicePromise: Promise<DownloadBundleService> | undefined;
  let genericSavesPromise: Promise<GenericSaveImportService> | undefined;
  const genericSaves = () => genericSavesPromise ??= GenericSaveImportService.create({
    managerRoot: saveManagerRoot,
    ...(options.saveProcessGuard === undefined ? {} : { processGuard: options.saveProcessGuard })
  });
  let directBackupPromise: Promise<DirectSaveBackupService> | undefined;
  const saveBackups = () => directBackupPromise ??= DirectSaveBackupService.create({ managerRoot: saveManagerRoot,
    ...(options.saveProcessGuard === undefined ? {} : { processGuard: options.saveProcessGuard }) });
  let formatsPromise: Promise<EldenRingFileService> | undefined;
  const saveFormats = () => formatsPromise ??= EldenRingFileService.create({ managerRoot: saveManagerRoot });
  const installs = (): Promise<InstallService> => {
    installServicePromise ??= InstallService.create(
      { managerRoot }
    );
    return installServicePromise;
  };
  const agenticInstalls = (): Promise<AgenticInstallService> => {
    agenticInstallServicePromise ??= installs().then((legacy) =>
      AgenticInstallService.create({ managerRoot, legacy })
    );
    return agenticInstallServicePromise;
  };
  const localInstallationQueries =
    (): Promise<LocalInstallationQueryService> => {
      localInstallationQueryServicePromise ??= installs().then((legacy) =>
        LocalInstallationQueryService.create({ managerRoot, legacy })
      );
      return localInstallationQueryServicePromise;
    };
  const downloadBundles = (): Promise<DownloadBundleService> => {
    downloadBundleServicePromise ??= DownloadBundleService.create({
      client,
      managerRoot
    });
    return downloadBundleServicePromise;
  };
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Use this server first for Nexus game identity, Mod research, dependency-aware authorized downloads, bounded local installation, managed file-Mod uninstall, and Windows game-save management. Require canonical Nexus URLs for research and download. Treat rankScope and coverage literally; search relevance is not popularity. Never expose API keys, browser cookies, or temporary download authorization. Research tools are read-only. Before marking a required Nexus dependency satisfied, call find_installed_nexus_mod instead of guessing Installation Record IDs; follow its current-verification guidance. For Mod/dependency-bundle downloads, resolve dependencies and freeze a Download Plan; download each selected file through the normal single-file backend, then create a verified Bundle Manifest from all receipts. For new installation work prefer Contract V2: list_game_profiles, probe_game_context, prepare_install_evidence, query_install_methods, then follow proposalReadiness.recommendedAction. Use a matching legacyProfileId instead of inventing explicit identity. Never invent package units; stop before Proposal when recommendedAction is stop_before_proposal. When a verified learned Method is selected, call instantiate_install_method instead of rebuilding its operations. File-tree and controlled bundled-installer Proposals require freeze_install_plan, exact Plan display, deterministic review classification, and apply_agentic_install_plan(planId). Apply auto_safe Plans in the same turn, request confirmation only for review_required Plans, and never apply blocked Plans. Controlled installers default to redirected_stdio; use pseudoterminal only when authoritative evidence proves Windows console semantics are required and operationCapabilities reports it available. Pseudoterminal mode supplies no input and does not automate interactive choices. Successful Agent Proposals may be learned as local_verified Methods, but every reuse still requires fresh Evidence, Context, Plan, and review classification. For uninstall, call inspect_mod_uninstall, stop on any blocker, freeze with plan_mod_uninstall, show the exact stored plan with get_mod_uninstall_plan, and follow review.nextAction. Re-run verify_mod_uninstall after apply. Active required dependents always block both planning and apply. For ordinary saves, use evidence-led research, prepare_download with persistent_chromium, inspect_save_input(stage:true), plan_save_import, and apply_save_import. Retain complete tool results and stable IDs. Keep the same download session and server instance through start/status/login continuation. Retain imported saves and verified backups; restore_save_import is recovery or requested rollback, not routine cleanup. Use specialized save tools only for actual format conversion or slot merging. Runtime load verification remains separate from file verification. Never replace MCP installation, uninstall, or save-restore tools with shell copy, extraction, process execution, or deletion. rollback_mod_install recovers incomplete legacy file transactions; it is not uninstall or save recovery."
    }
  );

  server.registerTool(
    "health_check",
    {
      title: "Nexus Mods server health",
      description: "Check whether the local Nexus Mods MCP server is running and whether an API key is configured. Does not call Nexus.",
      inputSchema: {},
      annotations: readOnlyAnnotations
    },
    async () =>
      ok("nexus-mods-server is running.", {
        ok: true,
        server: { name: SERVER_NAME, version: SERVER_VERSION },
        apiKeyConfigured: client.configured,
        meta: meta("local", null)
      })
  );

  server.registerTool(
    "inspect_save_input",
    {
      title: "Inspect a manual game save input",
      description:
        "Inspect a file, directory, ZIP, RAR or 7z without requiring a registered game. Use stage:true to safely extract/copy into managed staging and return exact files for generic plan_save_import mappings. Source remains unchanged.",
      inputSchema: {
        inputPath: z.string().trim().min(3),
        stage: z.boolean().optional()
      },
      outputSchema: {
        ok: z.literal(true), inspection: z.object({ inspectionId: z.string().uuid() }).passthrough(),
        stagedInput: z.object({ root: z.string(), files: z.array(z.object({}).passthrough()) }).passthrough().optional(),
        meta: z.object({}).passthrough()
      },
      annotations: localStateAnnotations
    },
    async ({ inputPath, stage }) =>
      safe(async () => {
        if (stage) {
          const result = await (await genericSaves()).inspect(inputPath);
          return ok(`Staged ${result.stagedInput.files.length} file(s); use their relativePath values in explicit source-to-target mappings.`, { ok: true, ...result, meta: meta("local", null) });
        }
        const inspection = await (await genericSaves()).inspector.inspect(inputPath);
        return ok(`Inspected ${inspection.entries.length} entries.`, { ok: true, inspection, meta: meta("local", null) });
      })
  );

  server.registerTool("plan_save_import", {
    title: "Plan a researched game save import",
    description: "Freeze exact file mappings and target prestate from an inspected source, with concrete game/player/compatibility evidence. Ordinary whole-file imports may have unknown internal format. Known internal conversion needs a specialist first. Only listed files are changed; deletions require explicit rationale.",
    inputSchema: saveImportInputSchema.shape,
    outputSchema: { ok: z.literal(true), plan: z.object({ planId: z.string().uuid() }).passthrough(), meta: z.object({}).passthrough() },
    annotations: localStateAnnotations
  }, async (input) => safe(async () => {
    const plan = await (await genericSaves()).plan(input);
    return ok(`Save import plan ${plan.planId}: ${plan.changes.length} exact file operation(s). If covered by the user's import request, apply this plan directly.`, { ok: true, plan, meta: meta("local", null) });
  }));
  server.registerTool("apply_save_import", {
    title: "Back up and apply a save import",
    description: "Apply a frozen generic import with process/prestate checks, verified backups, write-ahead recovery and file verification. Retains imported saves and backups. Repeated completed calls do not replay writes. Game load verification is separate. Interrupted operations require restore_save_import.",
    inputSchema: { planId: z.string().uuid() },
    outputSchema: genericSaveResultSchema,
    annotations: { ...localStateAnnotations, destructiveHint: true, idempotentHint: true }
  }, async ({ planId }) => safe(async () => {
    const result = await (await genericSaves()).apply(planId);
    return ok(`Save import ${planId}: ${result.operation?.state}. File verification only; game load not verified.`, { ok: true, ...result, meta: meta("local", null) });
  }));
  server.registerTool("get_save_import", {
    title: "Get save import plan and recovery status",
    description: "Read the frozen plan and persistent operation state by planId, including original and pre-restore backup IDs. This also works after a server restart; download session lifetimes are separate.",
    inputSchema: { planId: z.string().uuid() }, outputSchema: genericSaveResultSchema, annotations: localReadOnlyAnnotations
  }, async ({ planId }) => safe(async () => {
    const result = await (await genericSaves()).get(planId);
    return ok(`Save import ${planId}: ${result.operation?.state ?? "planned"}.`, { ok: true, ...result, meta: meta("local", null) });
  }));
  server.registerTool("restore_save_import", {
    title: "Restore or recover an exact save import",
    description: "Restore the precise files touched by a generic import, including an interrupted apply. First preserves current mapped files as rescue backups; unrelated later files remain untouched. Resumable after restart and idempotent after completion. Do not call routinely after successful import.",
    inputSchema: { planId: z.string().uuid() },
    outputSchema: genericSaveResultSchema,
    annotations: { ...localStateAnnotations, destructiveHint: true, idempotentHint: true }
  }, async ({ planId }) => safe(async () => {
    const result = await (await genericSaves()).restore(planId);
    return ok(`Save import ${planId}: ${result.operation?.state}.`, { ok: true, ...result, meta: meta("local", null) });
  }));

  server.registerTool("create_save_backup", {
    title: "Back up exact game save files",
    description: "Create a durable, hash-verified snapshot of explicit relative file paths under sourceRoot. Requires stopped relevant writers; changes no game files. Returns backupId and actual backup paths.",
    inputSchema: directSaveBackupInputSchema.shape,
    outputSchema: { ok: z.literal(true), backup: z.object({ backupId: z.string().uuid(), backupRoot: z.string() }).passthrough(), meta: z.object({}).passthrough() },
    annotations: localStateAnnotations
  }, async (input) => safe(async () => {
    const backup = await (await saveBackups()).createBackup(input);
    return ok(`Verified save backup ${backup.backupId}.`, { ok: true, backup, meta: meta("local", null) });
  }));
  server.registerTool("get_save_backup", {
    title: "Read and verify a direct save backup",
    description: "Read a durable backup by backupId and verify every stored file hash. No installation is required.",
    inputSchema: { backupId: z.string().uuid() }, annotations: localReadOnlyAnnotations
  }, async ({ backupId }) => safe(async () => {
    const backup = await (await saveBackups()).get(backupId);
    return ok(`Verified save backup ${backupId}.`, { ok: true, backup, meta: meta("local", null) });
  }));
  server.registerTool("prepare_save_backup_restore", {
    title: "Prepare a direct save backup for import",
    description: "Verify backup files and return explicit source mappings for plan_save_import. Then plan/apply through the same reversible import transaction to preserve the pre-restore state. Does not write saves or infer extra deletions.",
    inputSchema: { backupId: z.string().uuid(), targetRoot: z.string().min(3).optional(), processNames: directSaveBackupInputSchema.shape.processNames.optional() },
    annotations: localReadOnlyAnnotations
  }, async (input) => safe(async () => {
    const restoreInput = await (await saveBackups()).prepareRestore({ backupId: input.backupId, ...(input.targetRoot === undefined ? {} : { targetRoot: input.targetRoot }), ...(input.processNames === undefined ? {} : { processNames: input.processNames }) });
    return ok("Backup verified; add task evidence and use plan_save_import.", { ok: true, restoreInput, meta: meta("local", null) });
  }));
  server.registerTool("prepare_legacy_save_recovery", {
    title: "Export a historical save backup or operation for recovery",
    description: "Read and verify historical backup/operation/transaction records without loading retired game registration. Export verified original files plus exact recorded deletions for plan_save_import. Old plans cannot be resumed. Missing rescue blobs or reliable operation scope block recovery without writing game files.",
    inputSchema: legacySaveRecoveryInputSchema.shape, annotations: localStateAnnotations
  }, async (input) => safe(async () => {
    const restoreInput = await (await LegacySaveRecoveryService.create({ managerRoot: saveManagerRoot })).prepare(input);
    return ok("Historical files verified; add process names and task evidence, then use plan_save_import.", { ok: true, restoreInput, meta: meta("local", null) });
  }));
  server.registerTool("analyze_elden_ring_save", {
    title: "Analyze one Elden Ring PC save file",
    description: "Validate exact SL2 length, signature, slot and header checksums and account binding; return slots and fileSha256 for explicit conversion selection. Reads only the supplied file.",
    inputSchema: eldenRingAnalyzeInputSchema.shape, annotations: localReadOnlyAnnotations
  }, async (input) => safe(async () => {
    const analysis = await (await saveFormats()).analyze(input);
    return ok("Elden Ring save structure verified; game loading remains unverified.", { ok: true, analysis, meta: meta("local", null) });
  }));
  server.registerTool("prepare_elden_ring_import", {
    title: "Prepare Elden Ring account conversion and selected slots",
    description: "Merge explicitly selected source slots into an analyzed target, rebind account bytes and checksums, preserve unselected slots, and stage validated output. Occupied slot replacement needs explicit selection and allowOverwriteOccupied. Pass returned preparationId and exact mappings to plan_save_import; destination drift blocks the plan. Never writes the live target.",
    inputSchema: eldenRingPrepareInputSchema.shape,
    outputSchema: { ok: z.literal(true), preparation: z.object({ preparationId: z.string().uuid(), inputPath: z.string(), targetRoot: z.string() }).passthrough(), meta: z.object({}).passthrough() },
    annotations: localStateAnnotations
  }, async (input) => safe(async () => {
    const preparation = await (await saveFormats()).prepare(input);
    return ok(`Verified conversion ${preparation.preparationId}; use its exact preparationId and mappings in plan_save_import.`, { ok: true, preparation, meta: meta("local", null) });
  }));
  server.registerTool("get_elden_ring_preparation", {
    title: "Read and verify a staged Elden Ring conversion",
    description: "Recover a persisted preparationId after restart and verify the conversion receipt and staged bytes. Live destination state is rechecked by plan_save_import and apply_save_import.",
    inputSchema: { preparationId: z.string().uuid() }, annotations: localReadOnlyAnnotations
  }, async ({ preparationId }) => safe(async () => {
    const preparation = await (await saveFormats()).get(preparationId);
    return ok(`Verified conversion ${preparationId}.`, { ok: true, preparation, meta: meta("local", null) });
  }));

  server.registerTool(
    "browser_status",
    {
      title: "Dedicated Nexus Chromium status",
      description:
        "Check whether the Playwright Chromium engine and dedicated persistent profile are available, whether the browser is running, and the last observed Nexus login state. Does not expose the profile path, cookies, or account identity.",
      inputSchema: {},
      annotations: readOnlyAnnotations
    },
    async () =>
      safe(async () => {
        const status = await browser.status();
        const summary = status.running
          ? `Dedicated Nexus Chromium is running; login state is ${status.authState}.`
          : `Dedicated Nexus Chromium is stopped; engine installed: ${status.engineInstalled}.`;
        return ok(summary, {
          ok: true,
          browser: status,
          meta: meta("local", null)
        });
      })
  );

  server.registerTool(
    "open_nexus_login",
    {
      title: "Open dedicated Nexus login",
      description:
        "Start the visible dedicated persistent Chromium profile and open the normal Nexus login flow. The user enters credentials, 2FA, or CAPTCHA directly in Chromium; this tool never accepts or returns them.",
      inputSchema: {
        returnToModUrl: z
          .string()
          .url()
          .optional()
          .describe("Optional canonical Nexus Mod URL to open after login is observed.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ returnToModUrl }) =>
      safe(async () => {
        const canonicalReturnUrl =
          returnToModUrl === undefined ? undefined : parseModRef(returnToModUrl).canonicalUrl;
        const login = await browser.openLogin(canonicalReturnUrl);
        const summary =
          login.state === "authenticated"
            ? "The dedicated Nexus Chromium profile is already authenticated."
            : "The dedicated Nexus Chromium is open. Complete login in that browser, then call browser_status.";
        return ok(summary, {
          ok: true,
          login,
          meta: meta("local", null, [
            "Enter credentials, 2FA, and CAPTCHA only in the visible Nexus browser page, never as MCP arguments."
          ])
        });
      })
  );

  server.registerTool(
    "validate_credentials",
    {
      title: "Validate Nexus credentials",
      description:
        "Validate the locally configured NEXUS_API_KEY and return membership-derived capabilities and quota without returning identity or credential fields.",
      inputSchema: {},
      annotations: readOnlyAnnotations
    },
    async () =>
      safe(async () => {
        const validation = await client.validateCredentials();
        return ok(
          `Nexus credentials are valid. Premium: ${validation.isPremium}; Supporter: ${validation.isSupporter}.`,
          { ok: true, ...validation, meta: meta("nexus-rest-v1", validation.quota) }
        );
      })
  );

  server.registerTool(
    "resolve_game",
    {
      title: "Resolve Nexus game",
      description:
        "Resolve and verify an exact canonical Nexus game-page URL shaped like https://www.nexusmods.com/games/<slug>.",
      inputSchema: {
        gameUrl: z.string().url().describe("Canonical Nexus game URL under /games/<slug>.")
      },
      annotations: readOnlyAnnotations
    },
    async ({ gameUrl }) =>
      safe(async () => {
        const ref = parseGameRef(gameUrl);
        const { game, quota } = await client.getGame(ref.domainName);
        return ok(`Verified Nexus game: ${game.name} (${game.domainName}).`, {
          ok: true,
          game: { ...game, canonicalUrl: ref.canonicalUrl },
          meta: meta("nexus-rest-v1", quota)
        });
      })
  );

  server.registerTool(
    "list_games",
    {
      title: "List Nexus games",
      description: "List Nexus games from the official API. Use resolve_game when an exact game URL is already known.",
      inputSchema: {
        query: z.string().trim().min(1).max(100).optional().describe("Optional case-insensitive title/domain filter."),
        limit: z.number().int().min(1).max(100).default(50)
      },
      annotations: readOnlyAnnotations
    },
    async ({ query, limit }) =>
      safe(async () => {
        const { games, quota } = await client.listGames();
        const needle = query?.toLowerCase();
        const filtered = games
          .filter((game) => !needle || game.name.toLowerCase().includes(needle) || game.domainName.includes(needle))
          .slice(0, limit)
          .map((game) => ({ ...game, canonicalUrl: `https://www.nexusmods.com/games/${game.domainName}` }));
        return ok(`Found ${filtered.length} Nexus games.`, {
          ok: true,
          games: filtered,
          meta: meta("nexus-rest-v1", quota)
        });
      })
  );

  server.registerTool(
    "search_mods",
    {
      title: "Search and rank Nexus mods",
      description:
        "Search Nexus mods for an exact game URL using the official GraphQL index. Supports full-game rankings by downloads, unique downloads, endorsements, update time, or relevance. Returns declared rankScope and coverage.",
      inputSchema: {
        gameUrl: z.string().url(),
        query: z.string().trim().min(1).max(200).optional().describe("Feature or ecosystem terms, for example trainer menu utility."),
        sort: z
          .enum(["downloads", "unique_downloads", "endorsements", "updated", "created", "relevance"])
          .optional(),
        offset: z.number().int().min(0).default(0),
        count: z.number().int().min(1).max(50).default(10)
      },
      annotations: readOnlyAnnotations
    },
    async ({ gameUrl, query, sort, offset, count }) =>
      safe(async () => {
        const ref = parseGameRef(gameUrl);
        const result = await client.searchMods({
          domainName: ref.domainName,
          ...(query === undefined ? {} : { query }),
          ...(sort === undefined ? {} : { sort }),
          offset,
          count
        });
        const effectiveSort = sort ?? (query ? "relevance" : "downloads");
        const warnings = [
          ...(effectiveSort === "relevance" ? ["Relevance order is not popularity evidence."] : []),
          "GraphQL search returns total downloads and endorsements; call get_mod for unique downloads and full verification."
        ];
        return ok(`Found ${result.mods.length} mods from ${result.totalCount} matching records.`, {
          ok: true,
          game: ref,
          query: query ?? null,
          rankScope: query ? `matching-query:${effectiveSort}` : `all-game:${effectiveSort}`,
          coverage: "full-index-query",
          totalCount: result.totalCount,
          mods: result.mods,
          meta: meta("nexus-graphql-v2", result.quota, warnings)
        });
      })
  );

  server.registerTool(
    "list_feed_mods",
    {
      title: "List Nexus feed mods",
      description: "List latest-added, latest-updated, or trending mods for an exact Nexus game URL.",
      inputSchema: {
        gameUrl: z.string().url(),
        feed: z.enum(["latest_added", "latest_updated", "trending"])
      },
      annotations: readOnlyAnnotations
    },
    async ({ gameUrl, feed }) =>
      safe(async () => {
        const ref = parseGameRef(gameUrl);
        const { mods, quota } = await client.listFeed(ref.domainName, feed);
        return ok(`Retrieved ${mods.length} mods from the ${feed} feed.`, {
          ok: true,
          game: ref,
          feed,
          rankScope: `nexus-feed:${feed}`,
          coverage: "feed-only",
          mods,
          meta: meta("nexus-rest-v1", quota, ["Feed order must not be described as an all-time ranking."])
        });
      })
  );

  server.registerTool(
    "get_mod",
    {
      title: "Get Nexus mod details",
      description:
        "Verify one canonical Nexus Mod URL and return full description, version, dates, status, downloads, unique downloads, endorsements, and canonical URL.",
      inputSchema: { modUrl: z.string().url() },
      annotations: readOnlyAnnotations
    },
    async ({ modUrl }) =>
      safe(async () => {
        const ref = parseModRef(modUrl);
        const { mod, quota } = await client.getMod(ref.domainName, ref.modId);
        return ok(`${mod.name} v${mod.version}: ${mod.totalDownloads} downloads, ${mod.endorsements} endorsements.`, {
          ok: true,
          mod,
          meta: meta("nexus-rest-v1", quota)
        });
      })
  );

  server.registerTool(
    "get_mod_files",
    {
      title: "Get Nexus mod files",
      description:
        "List public file metadata for one canonical Nexus Mod URL, including category, version, filename, size, upload time, and primary flag. Does not return download URLs.",
      inputSchema: { modUrl: z.string().url() },
      annotations: readOnlyAnnotations
    },
    async ({ modUrl }) =>
      safe(async () => {
        const ref = parseModRef(modUrl);
        const { files, quota } = await client.getModFiles(ref.domainName, ref.modId);
        return ok(`Retrieved ${files.length} file records for mod ${ref.modId}.`, {
          ok: true,
          mod: ref,
          files,
          meta: meta("nexus-rest-v1", quota)
        });
      })
  );

  server.registerTool(
    "get_mod_changelogs",
    {
      title: "Get Nexus mod changelogs",
      description: "Return version-keyed changelog entries for one canonical Nexus Mod URL.",
      inputSchema: { modUrl: z.string().url() },
      annotations: readOnlyAnnotations
    },
    async ({ modUrl }) =>
      safe(async () => {
        const ref = parseModRef(modUrl);
        const { changelogs, quota } = await client.getModChangelogs(ref.domainName, ref.modId);
        return ok(`Retrieved ${Object.keys(changelogs).length} changelog versions for mod ${ref.modId}.`, {
          ok: true,
          mod: ref,
          changelogs,
          meta: meta("nexus-rest-v1", quota)
        });
      })
  );

  server.registerTool(
    "get_mod_requirements",
    {
      title: "Get Nexus mod requirements",
      description:
        "Return DLC requirements, Nexus dependencies, and reverse dependents for one canonical Nexus Mod URL using the current GraphQL modRequirements field.",
      inputSchema: { modUrl: z.string().url() },
      annotations: readOnlyAnnotations
    },
    async ({ modUrl }) =>
      safe(async () => {
        const ref = parseModRef(modUrl);
        const { requirements, quota } = await client.getModRequirements(ref.domainName, ref.modId);
        return ok(
          `Retrieved ${requirements.dlcRequirements.length} DLC and ${requirements.counts.nexusRequirements} Nexus requirements for mod ${ref.modId}.`,
          {
            ok: true,
            mod: ref,
            requirements,
            meta: meta("nexus-graphql-v2", quota)
          }
        );
      })
  );

  server.registerTool(
    "resolve_mod_dependencies",
    {
      title: "Resolve a normalized Mod dependency graph",
      description:
        "Recursively normalize one canonical Nexus Mod's required Nexus Mods, known loader runtimes, external requirements, and DLC into canonical nodes and edges. Does not select files or download anything.",
      inputSchema: {
        modUrl: z.string().url(),
        maxDepth: z.number().int().min(0).max(10).default(5)
      },
      annotations: readOnlyAnnotations
    },
    async ({ modUrl, maxDepth }) =>
      safe(async () => {
        const service = await downloadBundles();
        const resolution = await service.resolve({ modUrl, maxDepth });
        const downloadable = resolution.nodes.filter((node) =>
          ["nexus_mod", "loader_runtime"].includes(node.kind)
        ).length;
        const manual = resolution.nodes.length - downloadable;
        return ok(
          `Resolved ${resolution.nodes.length} dependency nodes: ${downloadable} Nexus-downloadable and ${manual} manual or external.`,
          {
            ok: true,
            dependencyResolution: resolution,
            meta: meta("nexus-graphql-v2", resolution.quota, resolution.warnings)
          }
        );
      })
  );

  server.registerTool(
    "find_installed_nexus_mod",
    {
      title: "Find successful local installations of one Nexus Mod",
      description:
        "Find successful managed Installation Records for one canonical Nexus Mod without guessing UUIDs. Searches both file-transaction and controlled-installer records, optionally scopes to an exact game root, evaluates only explicit numeric version constraints, re-verifies file installs, and returns the Evidence/Context needed to probe installer-based loaders before using satisfiedNodeIds.",
      inputSchema: {
        modUrl: z.string().url(),
        gameRoot: z
          .string()
          .min(3)
          .optional()
          .describe("Optional exact absolute game root used to exclude records for other game instances."),
        versionConstraint: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Optional explicit numeric constraint such as v4.1.7+, >=4.1.7, or =4.5.2. Natural-language notes remain unknown.")
      },
      annotations: localReadOnlyAnnotations
    },
    async ({ modUrl, gameRoot, versionConstraint }) =>
      safe(async () => {
        const ref = parseModRef(modUrl);
        const service = await localInstallationQueries();
        const result = await service.find({
          domainName: ref.domainName,
          modId: ref.modId,
          canonicalModUrl: ref.canonicalUrl,
          ...(gameRoot === undefined ? {} : { gameRoot }),
          ...(versionConstraint === undefined ? {} : { versionConstraint })
        });
        return ok(
          `Found ${result.counts.matches} successful managed installation records for ${ref.domainName}:${ref.modId}: ${result.counts.satisfied} currently satisfied, ${result.counts.candidatesRequiringProbe} requiring a fresh loader probe, and ${result.counts.notSatisfied} not satisfying the requested constraint or current check.`,
          {
            ok: true,
            ...result,
            meta: meta("local", null, [
              "A controlled-installer record is only a candidate until the exact game root is freshly probed and the expected loader/runtime is detected.",
              "Unsupported or natural-language version requirements remain unknown and must not be marked satisfied."
            ])
          }
        );
      })
  );

  server.registerTool(
    "get_installation_dependency_snapshot",
    {
      title: "Get one local Installation Dependency Snapshot",
      description:
        "Read and hash-verify the frozen dependency facts for one successful Installation Record. Also returns active snapshots which require this installation's Nexus node. Does not contact Nexus or modify the game.",
      inputSchema: {
        installationId: z.string().uuid()
      },
      annotations: localReadOnlyAnnotations
    },
    async ({ installationId }) =>
      safe(async () => {
        const service = await agenticInstalls();
        const snapshot = await service.getInstallationDependencySnapshot(
          installationId
        );
        const requiredBy = await service.findInstallationDependents({
          dependencyNodeId: snapshot.dependent.nexus.nodeId,
          gameRoot: snapshot.dependent.game.gameRoot
        });
        return ok(
          `Installation ${installationId} has ${snapshot.dependencies.length} frozen dependencies and is required by ${requiredBy.length} local installation snapshots.`,
          {
            ok: true,
            snapshot,
            requiredBy: requiredBy.map((dependent) => ({
              installationId: dependent.installationId,
              recordKind: dependent.dependent.recordKind,
              nexus: dependent.dependent.nexus,
              dependency: dependent.dependencies.find(
                (candidate) =>
                  candidate.nodeId.toLowerCase() ===
                  snapshot.dependent.nexus.nodeId.toLowerCase()
              )
            })),
            meta: meta("local", null)
          }
        );
      })
  );

  server.registerTool(
    "reconcile_installation_dependencies",
    {
      title: "Backfill local Installation Dependency Snapshots",
      description:
        "Create missing dependency snapshots for successful Contract V2 Bundle installations from immutable Bundle Completion, Evidence, Bundle Manifest, and Download Plan records. Writes manager metadata only and never modifies a game.",
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () =>
      safe(async () => {
        const result = await (
          await agenticInstalls()
        ).reconcileInstallationDependencies();
        return ok(
          `Created ${result.created.length} Installation Dependency Snapshots; ${result.unchangedInstallationIds.length} already existed and ${result.failures.length} could not be reconciled.`,
          {
            ok: result.failures.length === 0,
            ...result,
            meta: meta(
              "local",
              null,
              result.failures.map(
                (failure) =>
                  `${failure.installationId}: ${failure.message}`
              )
            )
          }
        );
      })
  );

  server.registerTool(
    "plan_mod_download",
    {
      title: "Plan a dependency-aware Mod download",
      description:
        "Resolve required dependencies, freeze exact active Nexus file selections for the root Mod and downloadable dependencies, preserve manual requirements, and return a reviewable Download Plan. Writes only manager plan state and does not start downloads.",
      inputSchema: {
        modUrl: z.string().url(),
        rootFileId: z.number().int().positive().optional(),
        dependencyFileOverrides: z
          .array(
            z.object({
              modUrl: z.string().url(),
              fileId: z.number().int().positive()
            })
          )
          .max(100)
          .optional(),
        satisfiedNodeIds: z
          .array(z.string().trim().min(1))
          .max(100)
          .optional()
          .describe("Dependencies independently proven present; never use this to guess satisfaction."),
        authorizationScope: z
          .enum(["root_only", "root_and_required_dependencies"])
          .default("root_only")
          .describe("Use root_and_required_dependencies only when the user's explicit request authorizes routine required prerequisites."),
        maxDepth: z.number().int().min(0).max(10).default(5)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({
      modUrl,
      rootFileId,
      dependencyFileOverrides,
      satisfiedNodeIds,
      authorizationScope,
      maxDepth
    }) =>
      safe(async () => {
        const service = await downloadBundles();
        const plan = await service.plan({
          modUrl,
          ...(rootFileId === undefined ? {} : { rootFileId }),
          ...(dependencyFileOverrides === undefined
            ? {}
            : { dependencyFileOverrides }),
          ...(satisfiedNodeIds === undefined ? {} : { satisfiedNodeIds }),
          maxDepth
        });
        const review = classifyDownloadPlanReview(plan, authorizationScope);
        return ok(
          `Created ${plan.status} Download Plan ${plan.planId} with ${plan.items.filter((item) => item.action === "download").length} file downloads, ${plan.items.filter((item) => item.action === "satisfied").length} satisfied dependencies, and ${plan.manualRequirements.length} manual requirements; review class is ${review.classification}.`,
          {
            ok: true,
            downloadPlan: plan,
            review,
            meta: meta("local", client.lastQuota, [
              review.classification === "auto_safe"
                ? "The exact frozen Plan may continue without a separate approval turn."
                : review.classification === "review_required"
                  ? "Display the exact frozen Plan and obtain approval before downloading."
                  : "Do not download; structural validation failed.",
              "Requirement notes are preserved as evidence and are not silently treated as machine-verified semantic version constraints."
            ])
          }
        );
      })
  );

  server.registerTool(
    "create_mod_bundle",
    {
      title: "Create a verified Mod Bundle Manifest",
      description:
        "After every file in one reviewed Download Plan is complete, verify all supplied receipts and archives, reject missing or extra files, and write one immutable Bundle Manifest with dependency-first install order. Does not install or extract anything.",
      inputSchema: {
        downloadPlanId: z.string().uuid(),
        receiptPaths: z.array(z.string().min(3)).min(1).max(200),
        outputDirectory: z.string().min(3)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ downloadPlanId, receiptPaths, outputDirectory }) =>
      safe(async () => {
        const service = await downloadBundles();
        const bundle = await service.createBundle({
          planId: downloadPlanId,
          receiptPaths,
          outputDirectory
        });
        return ok(
          `Created verified Mod Bundle ${bundle.bundleId} with ${bundle.archives.length} archives; state is ${bundle.state}.`,
          {
            ok: true,
            bundle,
            meta: meta("local", null, [
              "The Bundle records downloaded material only; it does not prove that loader runtimes or Mods are installed.",
              ...(bundle.manualRequirements.length > 0
                ? ["Manual or external requirements remain pending."]
                : [])
            ])
          }
        );
      })
  );

  server.registerTool(
    "inspect_mod_bundle",
    {
      title: "Inspect and verify a Mod Bundle Manifest",
      description:
        "Verify one absolute Bundle Manifest path, its content hash, every bundled receipt, and every archive hash, then return dependency-first install order. Read-only.",
      inputSchema: {
        bundlePath: z.string().min(3)
      },
      annotations: localReadOnlyAnnotations
    },
    async ({ bundlePath }) =>
      safe(async () => {
        const service = await downloadBundles();
        const bundle = await service.inspectBundle(bundlePath);
        return ok(
          `Verified Mod Bundle ${bundle.bundleId}: ${bundle.archives.length} archives in dependency-first order.`,
          {
            ok: true,
            bundle,
            meta: meta("local", null)
          }
        );
      })
  );

  server.registerTool(
    "prepare_download",
    {
      title: "Prepare one Nexus mod download",
      description:
        "Prepare an authorized single-mod download from a canonical Nexus Mod URL. Selects the requested fileId or latest active MAIN file. backend defaults to native; persistent_chromium prepares an asynchronous browser session without starting page clicks.",
      inputSchema: {
        modUrl: z.string().url(),
        fileId: z.number().int().positive().optional(),
        backend: z.enum(["native", "persistent_chromium"]).default("native")
      },
      outputSchema: preparedDownloadOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ modUrl, fileId, backend }) =>
      safe(async () => {
        const ref = parseModRef(modUrl);
        const [{ mod }, { files }] = await Promise.all([
          client.getMod(ref.domainName, ref.modId),
          client.getModFiles(ref.domainName, ref.modId)
        ]);
        if (!mod.available || mod.status.toLowerCase() !== "published") {
          throw new NexusError("INVALID_INPUT", `Mod ${ref.modId} is not currently published and available.`);
        }
        const file = selectDownloadFile(files, fileId);
        const prepared =
          backend === "persistent_chromium"
            ? browserDownloads.prepare({
                domainName: ref.domainName,
                modId: ref.modId,
                canonicalUrl: ref.canonicalUrl,
                file
              })
            : await (async () => {
                const validation = await client.validateCredentials();
                return downloads.prepare({
                  domainName: ref.domainName,
                  modId: ref.modId,
                  canonicalUrl: ref.canonicalUrl,
                  file,
                  isPremium: validation.isPremium
                });
              })();
        sessionBackends.set(prepared.sessionId, backend);
        const summary =
          backend === "persistent_chromium"
            ? `Prepared ${file.fileName} for the persistent Chromium backend. Call start_download with an absolute output directory.`
            : prepared.authorizationPageUrl
              ? `Prepared ${file.fileName}. Open the local authorization page, submit the matching NXM link, then call get_download_status.`
              : `Prepared ${file.fileName}; the Premium account can request a download link without interactive NXM authorization.`;
        return ok(downloadContinuationSummary(summary, prepared), {
          ok: true,
          download: prepared,
          meta: meta("nexus-rest-v1", client.lastQuota, [
            "Preparing a download does not download, execute, extract, or install the archive.",
            ...(backend === "native" && prepared.authorizationPageUrl
              ? ["Temporary NXM authorization must be submitted only to the loopback page, never as an MCP argument or chat message."]
              : []),
            ...(backend === "persistent_chromium"
              ? ["The browser workflow remains idle until start_download is called explicitly."]
              : [])
          ])
        });
      })
  );

  server.registerTool(
    "get_download_status",
    {
      title: "Get prepared download status",
      description:
        "Check whether a prepared download session is awaiting local NXM authorization, ready, downloading, completed, or failed. Never returns temporary download credentials.",
      inputSchema: { sessionId: z.string().uuid() },
      annotations: readOnlyAnnotations
    },
    async ({ sessionId }) =>
      safe(async () => {
        const backend = sessionBackends.get(sessionId);
        if (!backend) throw new NexusError("NOT_FOUND", "Download session was not found.");
        const status =
          backend === "persistent_chromium"
            ? browserDownloads.status(sessionId)
            : downloads.status(sessionId);
        return ok(`Download session ${sessionId} is ${status.state}.`, {
          ok: true,
          download: status,
          meta: meta("local", client.lastQuota)
        });
      })
  );

  server.registerTool(
    "start_download",
    {
      title: "Start one prepared browser download",
      description:
        "Start a prepared persistent_chromium session as an asynchronous visible-browser workflow. Returns quickly; poll get_download_status for interaction, verification, completion, or failure.",
      inputSchema: {
        sessionId: z.string().uuid(),
        outputDirectory: z.string().min(3).describe("Absolute directory for the archive, staging data, and receipt.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ sessionId, outputDirectory }) =>
      safe(async () => {
        const backend = sessionBackends.get(sessionId);
        if (!backend) throw new NexusError("NOT_FOUND", "Download session was not found.");
        if (backend !== "persistent_chromium") {
          throw new NexusError(
            "INVALID_INPUT",
            "start_download is only for persistent_chromium sessions; use download_mod_file for native sessions."
          );
        }
        const status = await browserDownloads.start(sessionId, outputDirectory);
        return ok(`Persistent Chromium download session ${sessionId} started with state ${status.state}.`, {
          ok: true,
          download: status,
          meta: meta("local", client.lastQuota, [
            "Poll get_download_status; inspect the visible Chromium window only when requiresUserInteraction is true.",
            "The archive will not be extracted, executed, or installed."
          ])
        });
      })
  );

  server.registerTool(
    "cancel_download",
    {
      title: "Cancel one browser download",
      description:
        "Cancel a prepared or active persistent_chromium download session. Does not close the shared browser Profile and does not affect completed native downloads.",
      inputSchema: { sessionId: z.string().uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ sessionId }) =>
      safe(async () => {
        const backend = sessionBackends.get(sessionId);
        if (!backend) throw new NexusError("NOT_FOUND", "Download session was not found.");
        if (backend !== "persistent_chromium") {
          throw new NexusError("INVALID_INPUT", "cancel_download is only for persistent_chromium sessions.");
        }
        const status = await browserDownloads.cancel(sessionId);
        return ok(`Persistent Chromium download session ${sessionId} is ${status.state}.`, {
          ok: true,
          download: status,
          meta: meta("local", client.lastQuota)
        });
      })
  );

  server.registerTool(
    "download_mod_file",
    {
      title: "Download one authorized Nexus mod file",
      description:
        "Download a ready, explicitly prepared Nexus file into an absolute output directory. Writes a temporary part file, verifies byte counts and SHA-256, performs a safe archive check, atomically exposes the final archive without overwriting, and writes a non-secret receipt. Does not extract, execute, or install the file.",
      inputSchema: {
        sessionId: z.string().uuid(),
        outputDirectory: z.string().min(3).describe("Absolute directory for the archive and receipt.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ sessionId, outputDirectory }) =>
      safe(async () => {
        const backend = sessionBackends.get(sessionId);
        if (!backend) throw new NexusError("NOT_FOUND", "Download session was not found.");
        if (backend === "persistent_chromium") {
          throw new NexusError(
            "INVALID_INPUT",
            "Use start_download and get_download_status for persistent_chromium sessions."
          );
        }
        const receipt = await downloads.download(sessionId, outputDirectory);
        return ok(`Download session ${sessionId} completed: downloaded ${receipt.fileName} (${receipt.bytes} bytes) and verified SHA-256 ${receipt.sha256}.`, {
          ok: true,
          receipt,
          meta: meta("local", client.lastQuota, ["Archive was not extracted, executed, or installed."])
        });
      })
  );

  server.registerTool(
    "probe_game_context",
    {
      title: "Probe a Dynamic Game Context",
      description:
        "Create an immutable Contract V2 Dynamic Game Context for one exact game root. Call list_game_profiles first and use legacyProfileId when a registered profile matches; use explicit identity and bounded roots only for an unregistered game. Do not substitute a Nexus numeric game ID for the stable profile/game ID. Does not modify game files.",
      inputSchema: {
        gameRoot: z.string().min(3).describe("Exact absolute game installation root."),
        legacyProfileId: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional registered V1 profile to use as verified context evidence."),
        gameId: z.string().trim().min(1).optional(),
        gameName: z.string().trim().min(1).optional(),
        nexusDomainName: z.string().trim().min(1).optional(),
        gameVersion: z.string().trim().min(1).optional(),
        platform: z
          .enum(["steam", "gog", "epic", "xbox", "manual", "unknown"])
          .optional(),
        platformAppId: z.string().trim().min(1).optional(),
        operatingSystem: z.enum(["win32", "linux", "darwin"]).optional(),
        anchorPaths: z
          .array(z.string().trim().min(1))
          .optional()
          .describe("Game-root-relative files or directories that prove this instance."),
        writableRoots: z
          .array(z.string().trim().min(1))
          .optional()
          .describe("Game-root-relative roots that a frozen executable Plan may modify."),
        protectedRoots: z.array(z.string().trim().min(1)).optional(),
        liveModRoots: z.array(z.string().trim().min(1)).optional(),
        knownProcessNames: z.array(z.string().trim().min(1)).optional(),
        lockSensitiveProcessNames: z.array(z.string().trim().min(1)).optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input) =>
      safe(async () => {
        const service = await agenticInstalls();
        const context =
          input.legacyProfileId !== undefined
            ? await service.probeGameContext({
                gameRoot: input.gameRoot,
                legacyProfileId: input.legacyProfileId
              })
            : await service.probeGameContext({
                gameRoot: input.gameRoot,
                gameId:
                  input.gameId ??
                  (() => {
                    throw new NexusError(
                      "GAME_CONTEXT_REQUIRED",
                      "Explicit game context requires gameId."
                    );
                  })(),
                gameName:
                  input.gameName ??
                  (() => {
                    throw new NexusError(
                      "GAME_CONTEXT_REQUIRED",
                      "Explicit game context requires gameName."
                    );
                  })(),
                ...(input.nexusDomainName === undefined
                  ? {}
                  : { nexusDomainName: input.nexusDomainName }),
                ...(input.gameVersion === undefined
                  ? {}
                  : { gameVersion: input.gameVersion }),
                ...(input.platform === undefined ? {} : { platform: input.platform }),
                ...(input.platformAppId === undefined
                  ? {}
                  : { platformAppId: input.platformAppId }),
                ...(input.operatingSystem === undefined
                  ? {}
                  : { operatingSystem: input.operatingSystem }),
                anchorPaths: input.anchorPaths ?? [],
                writableRoots: input.writableRoots ?? [],
                ...(input.protectedRoots === undefined
                  ? {}
                  : { protectedRoots: input.protectedRoots }),
                ...(input.liveModRoots === undefined
                  ? {}
                  : { liveModRoots: input.liveModRoots }),
                ...(input.knownProcessNames === undefined
                  ? {}
                  : { knownProcessNames: input.knownProcessNames }),
                ...(input.lockSensitiveProcessNames === undefined
                  ? {}
                  : {
                      lockSensitiveProcessNames: input.lockSensitiveProcessNames
                    })
              });
        return ok(
          `Created Dynamic Game Context ${context.gameContextId} for ${context.game.name}.`,
          {
            ok: true,
            context,
            meta: meta("local", null, [
              "This captures bounded game paths and evidence; it does not authorize installation."
            ])
          }
        );
      })
  );

  server.registerTool(
    "get_game_context",
    {
      title: "Get a Dynamic Game Context",
      description:
        "Read and hash-verify one immutable Contract V2 Dynamic Game Context.",
      inputSchema: {
        gameContextId: z.string().uuid()
      },
      annotations: localReadOnlyAnnotations
    },
    async ({ gameContextId }) =>
      safe(async () => {
        const context = await (await agenticInstalls()).getGameContext(gameContextId);
        return ok(`Retrieved Dynamic Game Context ${gameContextId}.`, {
          ok: true,
          context,
          meta: meta("local", null)
        });
      })
  );

  server.registerTool(
    "prepare_install_evidence",
    {
      title: "Prepare an installation Evidence Pack",
      description:
        "Verify either one exact Nexus archive/receipt or one exact Bundle Manifest node, inspect its safe inventory and package units, and persist an immutable Contract V2 Evidence Pack. Does not extract into or modify the game.",
      inputSchema: {
        archivePath: z.string().min(3).optional(),
        receiptPath: z.string().min(3).optional(),
        bundlePath: z.string().min(3).optional(),
        bundleNodeId: z.string().min(1).max(200).optional(),
        gameContextId: z
          .string()
          .uuid()
          .optional()
          .describe("Optional exact Dynamic Game Context to bind as observed evidence.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ archivePath, receiptPath, bundlePath, bundleNodeId, gameContextId }) =>
      safe(async () => {
        const agentic = await agenticInstalls();
        let resolvedArchivePath: string;
        let resolvedReceiptPath: string;
        let bundle:
          | {
              bundleId: string;
              bundlePath: string;
              bundleHash: string;
              nodeId: string;
              installOrderIndex: number;
            }
          | undefined;
        let dependencies:
          | Array<{
              nodeId: string;
              kind:
                | "nexus_mod"
                | "loader_runtime"
                | "manual_requirement"
                | "external_requirement";
              required: boolean;
              satisfied: boolean;
              evidence: string[];
            }>
          | undefined;
        if (bundlePath !== undefined || bundleNodeId !== undefined) {
          if (
            bundlePath === undefined ||
            bundleNodeId === undefined ||
            archivePath !== undefined ||
            receiptPath !== undefined
          ) {
            throw new NexusError(
              "INVALID_INPUT",
              "Provide either archivePath+receiptPath or bundlePath+bundleNodeId, never a partial or mixed input."
            );
          }
          const bundleService = await downloadBundles();
          const manifest = await bundleService.inspectBundle(bundlePath);
          const archive = manifest.archives.find(
            (candidate) => candidate.nodeId === bundleNodeId
          );
          const installOrderIndex = manifest.installOrder.indexOf(bundleNodeId);
          if (!archive || installOrderIndex < 0) {
            throw new NexusError(
              "BUNDLE_INVALID",
              "The selected Bundle node does not identify one verified archive."
            );
          }
          resolvedArchivePath = archive.archivePath;
          resolvedReceiptPath = archive.receiptPath;
          bundle = {
            bundleId: manifest.bundleId,
            bundlePath: manifest.bundlePath,
            bundleHash: manifest.bundleHash,
            nodeId: archive.nodeId,
            installOrderIndex
          };
          const satisfied = new Set([
            ...manifest.satisfiedNodeIds,
            ...(await agentic.getSatisfiedBundleNodeIds(manifest.bundleId))
          ]);
          const sourcePlan = await bundleService.getPlan(manifest.sourcePlanId);
          if (sourcePlan.planHash !== manifest.sourcePlanHash) {
            throw new NexusError(
              "DOWNLOAD_PLAN_STALE",
              "The Bundle Manifest no longer matches its frozen source Download Plan."
            );
          }
          dependencies = collectDependencyClosure(
            sourcePlan.dependencyResolution,
            bundleNodeId
          ).map(({ node, relation }) => {
              return {
                nodeId: node.nodeId,
                kind:
                  node.kind === "dlc"
                    ? ("manual_requirement" as const)
                    : node.kind,
                required: node.required,
                satisfied: satisfied.has(node.nodeId),
                evidence: [
                  ...node.evidence,
                  `Frozen Download Plan ${sourcePlan.planId} records this ${relation} dependency of ${bundleNodeId}.`
                ]
              };
            });
        } else {
          if (archivePath === undefined || receiptPath === undefined) {
            throw new NexusError(
              "INVALID_INPUT",
              "archivePath and receiptPath are both required for a single-archive Evidence Pack."
            );
          }
          resolvedArchivePath = archivePath;
          resolvedReceiptPath = receiptPath;
        }
        const evidence = await agentic.prepareEvidence({
          archivePath: resolvedArchivePath,
          receiptPath: resolvedReceiptPath,
          ...(gameContextId === undefined ? {} : { gameContextId }),
          ...(bundle === undefined ? {} : { bundle }),
          ...(dependencies === undefined ? {} : { dependencies })
        });
        return ok(
          `Created Evidence Pack ${evidence.evidencePackId} with ${evidence.packageUnits.length} package units.`,
          {
            ok: true,
            evidence,
            meta: meta("local", null, [
              "Evidence preparation writes only immutable manager state; the game directory is unchanged."
            ])
          }
        );
      })
  );

  server.registerTool(
    "get_install_evidence",
    {
      title: "Get an installation Evidence Pack",
      description:
        "Read and hash-verify one immutable Contract V2 installation Evidence Pack.",
      inputSchema: {
        evidencePackId: z.string().uuid()
      },
      annotations: localReadOnlyAnnotations
    },
    async ({ evidencePackId }) =>
      safe(async () => {
        const evidence = await (await agenticInstalls()).getEvidence(evidencePackId);
        return ok(`Retrieved Evidence Pack ${evidencePackId}.`, {
          ok: true,
          evidence,
          meta: meta("local", null)
        });
      })
  );

  server.registerTool(
    "query_install_methods",
    {
      title: "Query reusable installation methods",
      description:
        "Evaluate current Evidence and Dynamic Game Context against verified Method Store entries and legacy Adapter compatibility providers. Also returns operation and terminal-mode capabilities, package-unit Proposal readiness, and registered-profile advisories. Follow recommendedAction and never invent a package unit.",
      inputSchema: {
        evidencePackId: z.string().uuid(),
        gameContextId: z.string().uuid()
      },
      annotations: localReadOnlyAnnotations
    },
    async ({ evidencePackId, gameContextId }) =>
      safe(async () => {
        const result = await (
          await agenticInstalls()
        ).queryMethods({ evidencePackId, gameContextId });
        const summary =
          result.proposalReadiness.recommendedAction ===
          "reprobe_with_legacy_profile"
            ? "A registered Game Profile matches this explicit Context; re-probe with the returned legacyProfileId before planning."
            : result.proposalReadiness.recommendedAction ===
                "stop_before_proposal"
              ? "Evidence has no selectable package unit. Stop before Proposal submission."
              : result.proposalReadiness.recommendedAction ===
                  "construct_agent_installer_proposal"
                ? "A verified bundled-installer entry is available; research its bounded arguments, declared write roots, and postconditions, then construct one high-risk controlled installer Proposal."
              : result.proposalReadiness.recommendedAction ===
                  "construct_agent_file_proposal"
                ? "No verified reusable installation Method matched; construct an evidence-bounded file Proposal."
                : `Found ${result.candidates.length} installation Method candidates.`;
        return ok(
          summary,
          {
            ok: true,
            evidencePackId: result.evidence.evidencePackId,
            gameContextId: result.context.gameContextId,
            candidates: result.candidates,
            requiresAgentResearch:
              result.proposalReadiness.recommendedAction ===
              "construct_agent_file_proposal",
            operationCapabilities: result.operationCapabilities,
            proposalReadiness: result.proposalReadiness,
            contextAdvisories: result.contextAdvisories,
            meta: meta("local", null)
          }
        );
      })
  );

  server.registerTool(
    "instantiate_install_method",
    {
      title: "Instantiate one verified learned installation Method",
      description:
        "Resolve one exact local_verified or promoted Method against current Evidence, Dynamic Game Context, and package unit, then persist the resulting immutable Proposal. Does not modify the game.",
      inputSchema: {
        methodId: z.string().uuid(),
        methodRevision: z.number().int().positive(),
        evidencePackId: z.string().uuid(),
        gameContextId: z.string().uuid(),
        packageUnitId: z.string().min(1).max(200)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({
      methodId,
      methodRevision,
      evidencePackId,
      gameContextId,
      packageUnitId
    }) =>
      safe(async () => {
        const proposal = await (
          await agenticInstalls()
        ).instantiateMethodProposal({
          methodId,
          methodRevision,
          evidencePackId,
          gameContextId,
          packageUnitId
        });
        return ok(
          `Instantiated learned Method ${methodId} revision ${methodRevision} as Proposal ${proposal.proposalId}.`,
          {
            ok: true,
            proposal,
            meta: meta("local", null, [
              "The game directory is unchanged; freeze and review the Proposal as a new Plan."
            ])
          }
        );
      })
  );

  server.registerTool(
    "submit_install_proposal",
    {
      title: "Submit a bounded Agent installation Proposal",
      description:
        "Validate and persist an immutable Contract V2 Proposal bound to exact Evidence and Game Context hashes. Supports bounded install_tree, evidence-backed ensure_directory/install_new_file/replace_file mappings, or one controlled run_bundled_installer operation; redirected stdio is the default and Windows ConPTY must be explicitly selected and available.",
      inputSchema: {
        evidencePackId: z.string().uuid(),
        gameContextId: z.string().uuid(),
        draft: installProposalDraftSchema
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ evidencePackId, gameContextId, draft }) =>
      safe(async () => {
        const proposal = await (
          await agenticInstalls()
        ).submitProposal({ evidencePackId, gameContextId, draft });
        return ok(
          `Validated and stored Install Proposal ${proposal.proposalId}.`,
          {
            ok: true,
            proposal,
            meta: meta("local", null, [
              "A Proposal is not executable authority; freeze and review an Install Plan first."
            ])
          }
        );
      })
  );

  server.registerTool(
    "get_install_proposal",
    {
      title: "Get an installation Proposal",
      description:
        "Read and hash-verify one immutable Contract V2 installation Proposal.",
      inputSchema: {
        proposalId: z.string().uuid()
      },
      annotations: localReadOnlyAnnotations
    },
    async ({ proposalId }) =>
      safe(async () => {
        const proposal = await (await agenticInstalls()).getProposal(proposalId);
        return ok(`Retrieved Install Proposal ${proposalId}.`, {
          ok: true,
          proposal,
          meta: meta("local", null)
        });
      })
  );

  server.registerTool(
    "freeze_install_plan",
    {
      title: "Freeze a Contract V2 Install Plan",
      description:
        "Revalidate exact Proposal, Evidence, archive, game boundaries, operations, conflicts, and reversibility, then freeze an immutable Plan with a deterministic review classification. Writes only manager staging and plan state; does not modify the game.",
      inputSchema: {
        proposalId: z.string().uuid(),
        ttlMs: z.number().int().min(60_000).max(86_400_000).optional(),
        reviewMode: planReviewModeSchema.default("auto_safe")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ proposalId, ttlMs, reviewMode }) =>
      safe(async () => {
        const plan = await (
          await agenticInstalls()
        ).freezePlan({
          proposalId,
          reviewMode,
          ...(ttlMs === undefined ? {} : { ttlMs })
        });
        const review = reviewForPlan({
          review: plan.review,
          action: "install",
          targetIds: [
            plan.strategyBinding.proposalId,
            plan.evidenceBinding.evidencePackId,
            plan.gameBinding.gameContextId,
            plan.selection.packageUnitId
          ],
          planHash: plan.planHash
        });
        return ok(
          `Frozen Install Plan ${plan.planId} with ${plan.operations.length} operations. ${reviewSummary("Install Plan", plan.planId, review)}`,
          {
            ok: true,
            plan,
            review,
            meta: meta("local", null, [
              "The game directory is unchanged.",
              "Show the Plan targets, conflicts, risk, reversibility, and review decision before following review.nextAction."
            ])
          }
        );
      })
  );

  server.registerTool(
    "get_agentic_install_plan",
    {
      title: "Get a Contract V2 Install Plan",
      description:
        "Read and hash-verify one immutable, unexpired Contract V2 Install Plan.",
      inputSchema: {
        planId: z.string().uuid()
      },
      annotations: localReadOnlyAnnotations
    },
    async ({ planId }) =>
      safe(async () => {
        const plan = await (await agenticInstalls()).getPlan(planId);
        const review = reviewForPlan({
          review: plan.review,
          action: "install",
          targetIds: [
            plan.strategyBinding.proposalId,
            plan.evidenceBinding.evidencePackId,
            plan.gameBinding.gameContextId,
            plan.selection.packageUnitId
          ],
          planHash: plan.planHash
        });
        return ok(`Retrieved Contract V2 Install Plan ${planId}. ${reviewSummary("Install Plan", planId, review)}`, {
          ok: true,
          plan,
          review,
          meta: meta("local", null)
        });
      })
  );

  server.registerTool(
    "apply_agentic_install_plan",
    {
      title: "Apply one executable Contract V2 Install Plan",
      description:
        "Apply one exact Contract V2 planId through the existing transactional backup, journal, verification, and rollback engine. Auto-safe Plans may execute in the same turn; review-required Plans require confirmation; blocked Plans are rejected. Accepts no mutable operation fields.",
      inputSchema: {
        planId: z.string().uuid()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ planId }) =>
      safe(async () => {
        const result = await (await agenticInstalls()).applyPlan(planId);
        const review = reviewForPlan({
          review: result.plan.review,
          action: "install",
          targetIds: [
            result.plan.strategyBinding.proposalId,
            result.plan.evidenceBinding.evidencePackId,
            result.plan.gameBinding.gameContextId,
            result.plan.selection.packageUnitId
          ],
          planHash: result.plan.planHash
        });
        if (result.executionKind === "installer") {
          const response = ok(
            `Applied controlled-installer plan ${planId}; resulting state is ${result.record.state}.`,
            {
              ok: result.record.state === "installed",
              planId,
              review,
              executionKind: result.executionKind,
              installation: result.record,
              methodLearning: result.methodLearning,
              dependencySnapshot: result.dependencySnapshot,
              refreshedGameContext: result.refreshedGameContext,
              meta: meta("local", null, [
                result.record.verification.static === "passed"
                  ? "Declared side effects and static postconditions passed; in-game runtime verification has not run."
                  : "Do not claim success; inspect recovery state and unexpectedChanges."
              ])
            }
          );
          if (result.record.state !== "installed") response.isError = true;
          return response;
        }
        const applied = result.applied;
        return ok(
          `Applied Contract V2 plan ${planId}; static verification passed for installation ${applied.record.installationId}.`,
          {
            ok: true,
            planId,
            review,
            executionKind: result.executionKind,
            executionBridgePlanId: result.bridgePlanId,
            installation: {
              installationId: applied.record.installationId,
              transactionId: applied.transactionId,
              state: applied.record.state,
              methodExecutorId: applied.record.adapterId,
              sourcePlanId: applied.record.sourcePlanId,
              package: applied.record.packageSummary,
              operationOutcomes: applied.record.operationOutcomes,
              staticVerification: applied.staticVerification,
              runtimeVerification: applied.record.runtimeVerification
            },
            methodLearning: result.methodLearning,
            dependencySnapshot: result.dependencySnapshot,
            meta: meta("local", null, [
              "Static verification passed; runtime verification has not run."
            ])
          }
        );
      })
  );

  server.registerTool(
    "list_game_profiles",
    {
      title: "List supported game installation profiles",
      description:
        "List the built-in, versioned Game Profiles supported by the deterministic local installation engine. Does not scan disks or modify game files.",
      inputSchema: {},
      annotations: localReadOnlyAnnotations
    },
    async () =>
      safe(async () => {
        const service = await installs();
        const profiles = service.listProfiles().map((profile) => ({
          profileId: profile.profileId,
          profileVersion: profile.profileVersion,
          gameName: profile.gameName,
          nexusDomainName: profile.nexusDomainName,
          supportedOperatingSystems: profile.supportedOperatingSystems,
          loaders: profile.loaders.map((loader) => ({
            loaderId: loader.loaderId,
            modRoots: loader.modRoots
          })),
          writableRoots: profile.filesystem.writableRoots
        }));
        return ok(`Listed ${profiles.length} supported game installation profiles.`, {
          ok: true,
          profiles,
          meta: meta("local", null)
        });
      })
  );

  server.registerTool(
    "detect_game_installs",
    {
      title: "Detect supported game installations",
      description:
        "Probe conventional locations and optional explicit candidate roots for one registered Game Profile. Detection is bounded and read-only; an empty result means the exact root must be supplied to probe_game_install.",
      inputSchema: {
        profileId: z.string().trim().min(1).default("stardew-valley"),
        candidateRoots: z
          .array(z.string().min(3))
          .max(20)
          .optional()
          .describe("Optional absolute game-root candidates to probe.")
      },
      annotations: localReadOnlyAnnotations
    },
    async ({ profileId, candidateRoots }) =>
      safe(async () => {
        const service = await installs();
        const instances = await service.detectGameInstalls({
          profileId,
          ...(candidateRoots === undefined ? {} : { candidateRoots })
        });
        return ok(`Detected ${instances.length} verified game installations for ${profileId}.`, {
          ok: true,
          profileId,
          instances,
          meta: meta("local", null, [
            ...(instances.length === 0
              ? ["No conventional installation was verified; ask for the exact game root."]
              : [])
          ])
        });
      })
  );

  server.registerTool(
    "probe_game_install",
    {
      title: "Probe one exact game installation",
      description:
        "Verify an exact absolute game root against a registered Game Profile and report anchors and loader state. Read-only and bounded to the supplied root.",
      inputSchema: {
        profileId: z.string().trim().min(1).default("stardew-valley"),
        gameRoot: z.string().min(3).describe("Exact absolute game installation root.")
      },
      annotations: localReadOnlyAnnotations
    },
    async ({ profileId, gameRoot }) =>
      safe(async () => {
        const service = await installs();
        const instance = await service.probeGameInstall({ profileId, gameRoot });
        return ok(
          `Verified ${profileId} instance at ${instance.gameRoot}; loader states: ${instance.detectedLoaders
            .map((loader) => `${loader.loaderId}=${loader.state}`)
            .join(", ")}.`,
          {
            ok: true,
            instance,
            meta: meta("local", null)
          }
        );
      })
  );

  server.registerTool(
    "inspect_mod_archive",
    {
      title: "Inspect one verified Mod archive",
      description:
        "Verify an exact archive against its .nexus-receipt.json, safely inventory the ZIP, and identify package units without extracting into a game or manager staging directory.",
      inputSchema: {
        archivePath: z.string().min(3).describe("Absolute path to the downloaded ZIP."),
        receiptPath: z.string().min(3).describe("Absolute path to the matching .nexus-receipt.json.")
      },
      annotations: localReadOnlyAnnotations
    },
    async ({ archivePath, receiptPath }) =>
      safe(async () => {
        const service = await installs();
        const inspected = await service.inspect({ archivePath, receiptPath });
        return ok(
          `Verified and inspected ${inspected.verifiedInput.archive.fileName}: ${inspected.analysis.packages.length} supported package units and ${inspected.analysis.ambiguities.length} ambiguities.`,
          {
            ok: true,
            source: inspected.verifiedInput.source,
            archive: inspected.verifiedInput.archive,
            inventory: {
              format: inspected.inventory.format,
              entries: inspected.inventory.entries.length,
              totalUncompressedBytes: inspected.inventory.totalUncompressedBytes,
              commonTopLevelDirectory: inspected.inventory.commonTopLevelDirectory,
              warnings: inspected.inventory.warnings
            },
            analysis: inspected.analysis,
            meta: meta("local", null)
          }
        );
      })
  );

  server.registerTool(
    "match_install_adapters",
    {
      title: "Match installation adapters",
      description:
        "Read-only analysis that verifies the archive and exact game instance, then reports Adapter matches and loader compatibility. Does not stage or plan writes.",
      inputSchema: {
        archivePath: z.string().min(3),
        receiptPath: z.string().min(3),
        profileId: z.string().trim().min(1).default("stardew-valley"),
        gameRoot: z.string().min(3)
      },
      annotations: localReadOnlyAnnotations
    },
    async ({ archivePath, receiptPath, profileId, gameRoot }) =>
      safe(async () => {
        const service = await installs();
        const matched = await service.matchAdapters({
          archivePath,
          receiptPath,
          profileId,
          gameRoot
        });
        return ok(
          `Evaluated ${matched.matches.length} installation adapters; ${matched.matches.filter((item) => item.state === "matched").length} matched.`,
          {
            ok: true,
            analysisId: matched.analysis.analysisId,
            analysisHash: matched.analysis.analysisHash,
            packages: matched.analysis.packages,
            ambiguities: matched.analysis.ambiguities,
            instance: matched.instance,
            adapters: matched.matches,
            meta: meta("local", null)
          }
        );
      })
  );

  server.registerTool(
    "plan_mod_install",
    {
      title: "Plan one deterministic Mod installation",
      description:
        "Verify the archive and receipt, probe the exact game root, stage only the selected package under manager state, and freeze a dry-run Install Plan with a deterministic review classification. Does not modify the game.",
      inputSchema: {
        archivePath: z.string().min(3),
        receiptPath: z.string().min(3),
        profileId: z.string().trim().min(1).default("stardew-valley"),
        gameRoot: z.string().min(3),
        packageUnitId: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Required only when inspection reports multiple package units."),
        reviewMode: planReviewModeSchema.default("auto_safe")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ archivePath, receiptPath, profileId, gameRoot, packageUnitId, reviewMode }) =>
      safe(async () => {
        const service = await installs();
        const planned = await service.plan({
          archivePath,
          receiptPath,
          profileId,
          gameRoot,
          reviewMode,
          ...(packageUnitId === undefined ? {} : { packageUnitId })
        });
        const { plan } = planned.result;
        const review = reviewForPlan({
          review: plan.review,
          action: "install",
          targetIds: [plan.analysisId, plan.gameInstanceId, planned.result.packageUnit.packageUnitId],
          planHash: plan.planHash
        });
        return ok(
          `Created Install Plan ${plan.planId} for ${planned.result.packageUnit.identity.name ?? planned.result.packageUnit.identity.uniqueId ?? "the selected package"} with ${plan.operations.length} game-directory operations. ${reviewSummary("Install Plan", plan.planId, review)}`,
          {
            ok: true,
            plan: {
              planId: plan.planId,
              planHash: plan.planHash,
              status: plan.status,
              createdAt: plan.createdAt,
              expiresAt: plan.expiresAt,
              game: {
                profileId: plan.gameProfileId,
                profileVersion: plan.gameProfileVersion,
                instanceId: plan.gameInstanceId,
                gameRoot: planned.instance.gameRoot
              },
              source: planned.verifiedInput.source,
              archive: plan.archive,
              package: planned.result.packageUnit,
              adapter: planned.result.adapter,
              operations: plan.operations.map((operation) => ({
                operationId: operation.operationId,
                kind: operation.kind,
                targetRelativePath: operation.targetRelativePath,
                expectedPreState: operation.expectedPreState,
                expectedPostState: operation.expectedPostState
              })),
              conflicts: plan.conflicts,
              warnings: planned.result.warnings,
              verificationRequirements: planned.result.verificationRequirements,
              review
            },
            meta: meta("local", null, [
              "Planning writes only manager-owned staging and plan state; the game directory is unchanged.",
              "apply_mod_install accepts only this planId and revalidates all frozen inputs."
            ])
          }
        );
      })
  );

  server.registerTool(
    "apply_mod_install",
    {
      title: "Apply one frozen Mod Install Plan",
      description:
        "Apply an exact frozen Install Plan. Auto-safe Plans may execute in the same turn; review-required Plans require confirmation; blocked Plans are rejected. Accepts only planId, revalidates receipt, archive, staging, target pre-state, game-process locks, writes, and static verification, and automatically rolls back a failed transaction.",
      inputSchema: {
        planId: z.string().uuid().describe("The exact immutable planId returned by plan_mod_install.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ planId }) =>
      safe(async () => {
        const service = await installs();
        const applied = await service.apply(planId);
        return ok(
          `Installed ${applied.record.packageSummary.identity.name ?? applied.record.packageSummary.identity.uniqueId ?? "the selected Mod"} with static verification passed. Runtime verification has not run.`,
          {
            ok: true,
            installation: {
              installationId: applied.record.installationId,
              transactionId: applied.transactionId,
              state: applied.record.state,
              adapterId: applied.record.adapterId,
              sourcePlanId: applied.record.sourcePlanId,
              package: applied.record.packageSummary,
              operationOutcomes: applied.record.operationOutcomes,
              staticVerification: applied.staticVerification,
              runtimeVerification: applied.record.runtimeVerification
            },
            meta: meta("local", null, [
              "Static installation verification passed; this does not prove that the Mod loaded successfully in game."
            ])
          }
        );
      })
  );

  server.registerTool(
    "get_install_status",
    {
      title: "Get installation plan, transaction, or record status",
      description:
        "Read one local installation object by exact kind and UUID. Use plan for a dry-run object, transaction for journal state, or installation for the durable Installation Record.",
      inputSchema: {
        kind: z.enum(["plan", "transaction", "installation"]),
        id: z.string().uuid()
      },
      annotations: localReadOnlyAnnotations
    },
    async ({ kind, id }) =>
      safe(async () => {
        const service = await installs();
        const status =
          kind === "plan"
            ? await service.getPlan(id)
            : kind === "transaction"
              ? await service.getTransaction(id)
              : await service.getInstallation(id);
        return ok(`Retrieved ${kind} status for ${id}.`, {
          ok: true,
          kind,
          status,
          meta: meta("local", null)
        });
      })
  );

  server.registerTool(
    "verify_mod_install",
    {
      title: "Verify one installed Mod",
      description:
        "Read the durable Installation Record, compare current game paths with committed post-state, run Adapter static verification, and report runtime-verification availability. Does not launch the game or modify files.",
      inputSchema: {
        installationId: z.string().uuid()
      },
      annotations: localReadOnlyAnnotations
    },
    async ({ installationId }) =>
      safe(async () => {
        const service = await installs();
        const verified = await service.verifyInstallation(installationId);
        const passed =
          verified.staticVerification.state === "passed" &&
          !verified.inspection.blocking;
        return ok(
          passed
            ? `Installation ${installationId} passes current static verification; runtime verification is ${verified.runtimeVerification.state}.`
            : `Installation ${installationId} does not pass current static verification.`,
          {
            ok: true,
            installationId,
            passed,
            recordState: verified.record.state,
            inspection: verified.inspection,
            staticVerification: verified.staticVerification,
            runtimeVerification: verified.runtimeVerification,
            meta: meta("local", null, [
              ...(verified.runtimeVerification.state === "not-run"
                ? ["Runtime verification has not run; do not claim the Mod loaded successfully in game."]
                : [])
            ])
          }
        );
      })
  );

  server.registerTool(
    "inspect_mod_uninstall",
    {
      title: "Inspect one managed Mod for safe uninstall",
      description:
        "Inspect a file-transaction Installation Record, its current managed paths, and active reverse dependencies in the same game root. Returns blockers without creating an Uninstall Plan or changing the game.",
      inputSchema: {
        installationId: z.string().uuid()
      },
      annotations: localReadOnlyAnnotations
    },
    async ({ installationId }) =>
      safe(async () => {
        const inspection = await (
          await agenticInstalls()
        ).inspectUninstall(installationId);
        return ok(
          inspection.eligible
            ? `Installation ${installationId} is eligible for Uninstall Plan generation.`
            : `Installation ${installationId} has ${inspection.blockers.length} uninstall blocker(s).`,
          {
            ok: true,
            inspection,
            meta: meta("local", null, [
              "Eligibility is a current-state inspection, not approval to uninstall.",
              "Active required dependents must be removed or migrated before this target can be uninstalled."
            ])
          }
        );
      })
  );

  server.registerTool(
    "plan_mod_uninstall",
    {
      title: "Freeze a managed Mod Uninstall Plan",
      description:
        "Recheck active dependents and current managed paths, then freeze a separate immutable Uninstall Plan with a deterministic review classification. Writes manager plan metadata only; it does not modify the game.",
      inputSchema: {
        installationId: z.string().uuid(),
        reviewMode: planReviewModeSchema.default("auto_safe")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ installationId, reviewMode }) =>
      safe(async () => {
        const planned = await (
          await agenticInstalls()
        ).planUninstall(installationId, { reviewMode });
        const lifecycle = await (
          await agenticInstalls()
        ).getUninstallPlanLifecycle(planned.plan.uninstallPlanId);
        const review = reviewForPlan({
          review: planned.plan.review,
          action: "uninstall",
          targetIds: [planned.plan.installationId],
          planHash: planned.plan.uninstallPlanHash
        });
        return ok(
          `Frozen Uninstall Plan ${planned.plan.uninstallPlanId}. ${reviewSummary("Uninstall Plan", planned.plan.uninstallPlanId, review)}`,
          {
            ok: true,
            plan: planned.plan,
            lifecycle: lifecycle.lifecycle,
            inspection: planned.inspection,
            review,
            meta: meta("local", null, [
              "Show every action and retained path before following review.nextAction.",
              "The review decision applies only to this exact uninstallPlanId."
            ])
          }
        );
      })
  );

  server.registerTool(
    "get_mod_uninstall_plan",
    {
      title: "Get one exact managed Mod Uninstall Plan",
      description:
        "Read one stored Uninstall Plan by UUID, including its immutable creation status, derived current lifecycle, installation revision, inspection hash, exact actions, retained paths, and expiry. Does not modify the game.",
      inputSchema: {
        uninstallPlanId: z.string().uuid()
      },
      annotations: localReadOnlyAnnotations
    },
    async ({ uninstallPlanId }) =>
      safe(async () => {
        const result = await (
          await agenticInstalls()
        ).getUninstallPlanLifecycle(uninstallPlanId);
        const review = reviewForPlan({
          review: result.plan.review,
          action: "uninstall",
          targetIds: [result.plan.installationId],
          planHash: result.plan.uninstallPlanHash
        });
        return ok(
          `Retrieved Uninstall Plan ${uninstallPlanId}; lifecycle is ${result.lifecycle.state}. ${reviewSummary("Uninstall Plan", uninstallPlanId, review)}`,
          {
          ok: true,
          plan: result.plan,
          lifecycle: result.lifecycle,
          review,
          meta: meta("local", null)
          }
        );
      })
  );

  server.registerTool(
    "apply_mod_uninstall",
    {
      title: "Apply one executable managed Mod Uninstall Plan",
      description:
        "Apply exactly one Uninstall Plan by UUID. Rechecks active required dependents and all frozen plan/current-state guards before changing the game. Auto-safe Plans may execute in the same turn; review-required Plans require confirmation; blocked Plans are rejected.",
      inputSchema: {
        uninstallPlanId: z.string().uuid()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ uninstallPlanId }) =>
      safe(async () => {
        const applied = await (
          await agenticInstalls()
        ).applyUninstall(uninstallPlanId);
        const lifecycle = await (
          await agenticInstalls()
        ).getUninstallPlanLifecycle(uninstallPlanId);
        const review = reviewForPlan({
          review: lifecycle.plan.review,
          action: "uninstall",
          targetIds: [lifecycle.plan.installationId],
          planHash: lifecycle.plan.uninstallPlanHash
        });
        return ok(
          `Uninstall Plan ${uninstallPlanId} committed as transaction ${applied.transactionId}.`,
          {
            ok: true,
            uninstall: {
              uninstallPlanId,
              transactionId: applied.transactionId,
              installationId: applied.record.installationId,
              recordState: applied.record.state,
              retainedPaths: applied.retainedPaths,
              retainedFilePaths: applied.retainedFilePaths
            },
            lifecycle: lifecycle.lifecycle,
            review,
            meta: meta("local", null, [
              "Run verify_mod_uninstall before claiming that managed files were removed.",
              ...(applied.retainedPaths.length > 0
                ? ["Unmanaged or generated data was intentionally retained."]
                : [])
            ])
          }
        );
      })
  );

  server.registerTool(
    "verify_mod_uninstall",
    {
      title: "Verify one committed managed Mod uninstall",
      description:
        "Verify that the Installation Record is terminal and that each owned file was removed or each replaced path was restored to its pre-install state. Unmanaged retained data is allowed and reported. Does not modify the game.",
      inputSchema: {
        installationId: z.string().uuid()
      },
      annotations: localReadOnlyAnnotations
    },
    async ({ installationId }) =>
      safe(async () => {
        const verification = await (
          await agenticInstalls()
        ).verifyUninstall(installationId);
        return ok(
          verification.passed
            ? `Installation ${installationId} passes uninstall verification.`
            : `Installation ${installationId} does not pass uninstall verification.`,
          {
            ok: true,
            installationId,
            passed: verification.passed,
            recordState: verification.record.state,
            checks: verification.checks,
            retainedFilePaths: verification.retainedFilePaths,
            meta: meta(
              "local",
              null,
              verification.passed
                ? []
                : [
                    "Do not claim uninstall success; inspect the failed checks and transaction journal."
                  ]
            )
          }
        );
      })
  );

  server.registerTool(
    "rollback_mod_install",
    {
      title: "Recover one incomplete install transaction",
      description:
        "Recover or roll back one incomplete install transaction by transactionId using its journal and backups. This is crash/failure recovery only; it does not uninstall a committed Mod.",
      inputSchema: {
        transactionId: z.string().uuid()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ transactionId }) =>
      safe(async () => {
        const service = await installs();
        const recovery = await service.recoverInstallTransaction(transactionId);
        return ok(
          `Install transaction ${transactionId} recovery result: ${recovery.action}.`,
          {
            ok: true,
            recovery,
            meta: meta("local", null, [
              "A terminal committed installation is left installed; use a future uninstall workflow to remove it."
            ])
          }
        );
      })
  );

  return {
    server,
    close: async () => {
      try {
        await browserDownloads.close();
      } finally {
        try {
          await browser.close();
        } finally {
          try {
            await downloads.close();
          } finally {
            sessionBackends.clear();
            await server.close();
          }
        }
      }
    }
  };
}
