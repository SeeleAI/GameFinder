import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import type { NexusBrowserAutomation } from "./browser/browser-service.js";
import { NexusBrowserService } from "./browser/browser-service.js";
import { BrowserDownloadManager } from "./browser-download-manager.js";
import { DownloadBundleService } from "./download-bundle-service.js";
import { DownloadManager, selectDownloadFile } from "./download-manager.js";
import { asNexusError, NexusError } from "./errors.js";
import {
  InstallService,
  resolveDefaultManagerRoot
} from "./install/install-service.js";
import {
  AgenticInstallService,
  installProposalDraftSchema
} from "./install/v2/index.js";
import { NexusClient } from "./nexus-client.js";
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
      "Use rollback_mod_install with the reported transactionId before another install.",
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
      "This MCP build cannot safely execute the proposed operation yet; preserve the evidence and stop before modifying the game."
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

export interface NexusMcpService {
  server: McpServer;
  close: () => Promise<void>;
}

export function createNexusMcpServer(
  client = new NexusClient(),
  browser: NexusBrowserAutomation = new NexusBrowserService(),
  options: { managerRoot?: string } = {}
): NexusMcpService {
  const downloads = new DownloadManager(client);
  const browserDownloads = new BrowserDownloadManager(browser);
  const sessionBackends = new Map<string, "native" | "persistent_chromium">();
  const managerRoot = options.managerRoot ?? resolveDefaultManagerRoot();
  let installServicePromise: Promise<InstallService> | undefined;
  let agenticInstallServicePromise: Promise<AgenticInstallService> | undefined;
  let downloadBundleServicePromise: Promise<DownloadBundleService> | undefined;
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
        "Use this server first for Nexus game identity, Mod research, dependency-aware authorized downloads, and bounded local installation. Require canonical Nexus URLs for research and download. Treat rankScope and coverage literally; search relevance is not popularity. Never expose API keys, browser cookies, or temporary download authorization. Research tools are read-only. Before downloading, resolve dependencies and freeze a Download Plan; download each selected file through the normal single-file backend, then create a verified Bundle Manifest from all receipts. For new installation work prefer Contract V2: probe_game_context, prepare_install_evidence, query_install_methods, submit_install_proposal, freeze_install_plan, show the immutable plan, and call apply_agentic_install_plan with only planId after explicit approval. V2 may use a verified learned Method, a legacy Adapter candidate, or a bounded Agent proposal; lack of a prewritten Adapter is not itself a blocker. Never replace MCP installation tools with shell copy, extraction, or deletion. rollback_mod_install recovers incomplete transactions; it is not uninstall."
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
        return ok(
          `Created ${plan.status} Download Plan ${plan.planId} with ${plan.items.filter((item) => item.action === "download").length} file downloads, ${plan.items.filter((item) => item.action === "satisfied").length} satisfied dependencies, and ${plan.manualRequirements.length} manual requirements.`,
          {
            ok: true,
            downloadPlan: plan,
            meta: meta("local", client.lastQuota, [
              "Review every dependency and selected file before starting any download.",
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
        "Prepare an explicitly requested single-mod download from a canonical Nexus Mod URL. Selects the requested fileId or latest active MAIN file. backend defaults to native; persistent_chromium prepares an asynchronous browser session without starting page clicks.",
      inputSchema: {
        modUrl: z.string().url(),
        fileId: z.number().int().positive().optional(),
        backend: z.enum(["native", "persistent_chromium"]).default("native")
      },
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
        return ok(summary, {
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
        return ok(`Download session is ${status.state}.`, {
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
        return ok(`Persistent Chromium download session started with state ${status.state}.`, {
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
        return ok(`Persistent Chromium download session is ${status.state}.`, {
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
        return ok(`Downloaded ${receipt.fileName} (${receipt.bytes} bytes) and verified SHA-256 ${receipt.sha256}.`, {
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
        "Create an immutable Contract V2 Dynamic Game Context for one exact game root. Use legacyProfileId when a registered profile exists; otherwise provide explicit game identity, anchor paths, and bounded writable roots. Does not modify game files.",
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
          .describe("Game-root-relative roots that an approved plan may modify."),
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
        "Verify one exact Nexus archive and receipt, inspect its safe inventory and package units, and persist an immutable Contract V2 Evidence Pack. Does not extract into or modify the game.",
      inputSchema: {
        archivePath: z.string().min(3),
        receiptPath: z.string().min(3),
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
    async ({ archivePath, receiptPath, gameContextId }) =>
      safe(async () => {
        const evidence = await (
          await agenticInstalls()
        ).prepareEvidence({
          archivePath,
          receiptPath,
          ...(gameContextId === undefined ? {} : { gameContextId })
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
        "Evaluate current Evidence and Dynamic Game Context against verified Method Store entries and legacy Adapter compatibility providers. An empty result means the Agent should research and submit a bounded Proposal; it does not require new code.",
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
        return ok(
          result.candidates.length === 0
            ? "No reusable installation Method matched; construct an evidence-bounded Agent Proposal."
            : `Found ${result.candidates.length} installation Method candidates.`,
          {
            ok: true,
            evidencePackId: result.evidence.evidencePackId,
            gameContextId: result.context.gameContextId,
            candidates: result.candidates,
            requiresAgentResearch: result.candidates.length === 0,
            meta: meta("local", null)
          }
        );
      })
  );

  server.registerTool(
    "submit_install_proposal",
    {
      title: "Submit a bounded Agent installation Proposal",
      description:
        "Validate and persist an immutable Contract V2 Proposal bound to exact Evidence and Game Context hashes. In M2, file-only install_tree operations are executable; bundled installer execution is reserved for M3.",
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
        "Revalidate exact Proposal, Evidence, archive, game boundaries, operations, conflicts, and reversibility, then freeze an immutable approval digest. Writes only manager staging and plan state; does not modify the game.",
      inputSchema: {
        proposalId: z.string().uuid(),
        ttlMs: z.number().int().min(60_000).max(86_400_000).optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ proposalId, ttlMs }) =>
      safe(async () => {
        const plan = await (
          await agenticInstalls()
        ).freezePlan({
          proposalId,
          ...(ttlMs === undefined ? {} : { ttlMs })
        });
        return ok(
          `Frozen Install Plan ${plan.planId} with ${plan.operations.length} operations; explicit approval is required.`,
          {
            ok: true,
            plan,
            meta: meta("local", null, [
              "The game directory is unchanged.",
              "Show the plan targets, conflicts, risk, reversibility, and approval digest before apply."
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
        return ok(`Retrieved Contract V2 Install Plan ${planId}.`, {
          ok: true,
          plan,
          meta: meta("local", null)
        });
      })
  );

  server.registerTool(
    "apply_agentic_install_plan",
    {
      title: "Apply one approved Contract V2 Install Plan",
      description:
        "Apply one exact, previously reviewed Contract V2 planId through the existing transactional backup, journal, verification, and rollback engine. Accepts no mutable operation fields.",
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
        const applied = result.applied;
        return ok(
          `Applied Contract V2 plan ${planId}; static verification passed for installation ${applied.record.installationId}.`,
          {
            ok: true,
            planId,
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
        "Verify the archive and receipt, probe the exact game root, stage only the selected package under manager state, and freeze a dry-run Install Plan. Does not modify the game. Review the returned operations and conflicts before apply_mod_install.",
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
          .describe("Required only when inspection reports multiple package units.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ archivePath, receiptPath, profileId, gameRoot, packageUnitId }) =>
      safe(async () => {
        const service = await installs();
        const planned = await service.plan({
          archivePath,
          receiptPath,
          profileId,
          gameRoot,
          ...(packageUnitId === undefined ? {} : { packageUnitId })
        });
        const { plan } = planned.result;
        return ok(
          `Created Install Plan ${plan.planId} for ${planned.result.packageUnit.identity.name ?? planned.result.packageUnit.identity.uniqueId ?? "the selected package"} with ${plan.operations.length} game-directory operations. Review it before apply.`,
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
              requiresExplicitApplyConfirmation: true
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
        "Apply a previously reviewed Install Plan. Accepts only planId, revalidates receipt, archive, staging, target pre-state, game-process locks, writes, and static verification, and automatically rolls back a failed transaction.",
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
