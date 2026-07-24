import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import type { NexusBrowserAutomation } from "./browser/browser-service.js";
import { NexusBrowserService } from "./browser/browser-service.js";
import { BrowserDownloadManager } from "./browser-download-manager.js";
import { DownloadManager, selectDownloadFile } from "./download-manager.js";
import { asNexusError, NexusError } from "./errors.js";
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

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
};

export interface NexusMcpService {
  server: McpServer;
  close: () => Promise<void>;
}

export function createNexusMcpServer(
  client = new NexusClient(),
  browser: NexusBrowserAutomation = new NexusBrowserService()
): NexusMcpService {
  const downloads = new DownloadManager(client);
  const browserDownloads = new BrowserDownloadManager(browser);
  const sessionBackends = new Map<string, "native" | "persistent_chromium">();
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Use this server first for Nexus game identity, mod discovery, rankings, metrics, files, changelogs, requirements, and authorized downloads. Require canonical Nexus URLs. Treat rankScope and coverage literally; search relevance is not popularity. Never expose API keys, browser cookies, or temporary download authorization. Use research tools as read-only evidence, and use browser or download tools only after explicit user intent. The dedicated Chromium login tool opens a local persistent profile but never accepts account credentials. Native remains the default download backend; persistent_chromium downloads use prepare_download, start_download, get_download_status, and cancel_download."
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
