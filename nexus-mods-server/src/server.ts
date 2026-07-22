import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
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

export function createNexusMcpServer(client = new NexusClient()): NexusMcpService {
  const downloads = new DownloadManager(client);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Use this server first for Nexus game identity, mod discovery, rankings, metrics, files, changelogs, requirements, and authorized downloads. Require canonical Nexus URLs. Treat rankScope and coverage literally; search relevance is not popularity. Never expose API keys or temporary NXM download authorization. Use research tools as read-only evidence, and use download tools only after explicit user intent."
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
        "Prepare an explicitly requested single-mod download from a canonical Nexus Mod URL. Selects the requested fileId or the latest active MAIN file. For non-Premium accounts, starts a loopback-only authorization page that accepts the temporary NXM link without exposing it to the model.",
      inputSchema: {
        modUrl: z.string().url(),
        fileId: z.number().int().positive().optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ modUrl, fileId }) =>
      safe(async () => {
        const ref = parseModRef(modUrl);
        const [{ mod }, { files }, validation] = await Promise.all([
          client.getMod(ref.domainName, ref.modId),
          client.getModFiles(ref.domainName, ref.modId),
          client.validateCredentials()
        ]);
        if (!mod.available || mod.status.toLowerCase() !== "published") {
          throw new NexusError("INVALID_INPUT", `Mod ${ref.modId} is not currently published and available.`);
        }
        const file = selectDownloadFile(files, fileId);
        const prepared = await downloads.prepare({
          domainName: ref.domainName,
          modId: ref.modId,
          canonicalUrl: ref.canonicalUrl,
          file,
          isPremium: validation.isPremium
        });
        const summary = prepared.authorizationPageUrl
          ? `Prepared ${file.fileName}. Open the local authorization page, submit the matching NXM link, then call get_download_status.`
          : `Prepared ${file.fileName}; the Premium account can request a download link without interactive NXM authorization.`;
        return ok(summary, {
          ok: true,
          download: prepared,
          meta: meta("nexus-rest-v1", client.lastQuota, [
            "Preparing a download does not download, execute, extract, or install the archive.",
            ...(prepared.authorizationPageUrl
              ? ["Temporary NXM authorization must be submitted only to the loopback page, never as an MCP argument or chat message."]
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
        const status = downloads.status(sessionId);
        return ok(`Download session is ${status.state}.`, {
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
      await downloads.close();
      await server.close();
    }
  };
}
