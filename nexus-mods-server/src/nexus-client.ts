import { NexusError } from "./errors.js";
import type {
  DiscoveredMod,
  DownloadLink,
  ModRequirements,
  NexusGame,
  NexusMod,
  NexusModFile,
  QuotaSnapshot
} from "./types.js";
import { buildModUrl, normalizeDomainName } from "./url.js";

const REST_BASE = "https://api.nexusmods.com/v1";
const GRAPHQL_URL = "https://api.nexusmods.com/v2/graphql";
const APP_NAME = "nexus-mods-server";
const APP_VERSION = "0.1.0";

interface RequestResult<T> {
  data: T;
  quota: QuotaSnapshot;
}

interface RawGame {
  id: number;
  name: string;
  domain_name: string;
  approved_date?: number;
  authors?: number;
  mods?: number;
  downloads?: number;
  file_count?: number;
}

interface RawMod {
  mod_id: number;
  name: string;
  summary?: string;
  description?: string;
  version?: string;
  author?: string;
  uploaded_by?: string;
  domain_name: string;
  category_id?: number;
  contains_adult_content?: boolean;
  status?: string;
  available?: boolean;
  mod_downloads?: number;
  mod_unique_downloads?: number;
  endorsement_count?: number;
  created_timestamp?: number;
  updated_timestamp?: number;
  picture_url?: string;
}

interface RawFile {
  file_id: number;
  name?: string;
  version?: string;
  category_id?: number;
  category_name?: string;
  file_name?: string;
  size_kb?: number;
  size?: number;
  size_in_bytes?: number;
  uploaded_timestamp?: number;
  is_primary?: boolean;
  description?: string;
  content_preview_link?: string;
}

interface RawFileResponse {
  files?: RawFile[];
  file_updates?: unknown[];
}

interface ValidateResponse {
  is_premium?: boolean;
  is_supporter?: boolean;
}

interface GraphResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

function numberHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readQuota(headers: Headers): QuotaSnapshot {
  return {
    dailyLimit: numberHeader(headers, "x-rl-daily-limit"),
    dailyRemaining: numberHeader(headers, "x-rl-daily-remaining"),
    hourlyLimit: numberHeader(headers, "x-rl-hourly-limit"),
    hourlyRemaining: numberHeader(headers, "x-rl-hourly-remaining")
  };
}

function isoFromTimestamp(value: number | undefined): string | null {
  if (!value || !Number.isFinite(value)) return null;
  return new Date(value * 1000).toISOString();
}

function mapGame(raw: RawGame): NexusGame {
  const result: NexusGame = {
    id: raw.id,
    name: raw.name,
    domainName: raw.domain_name
  };
  if (raw.approved_date !== undefined) result.approvedDate = raw.approved_date;
  if (raw.authors !== undefined) result.authors = raw.authors;
  if (raw.mods !== undefined) result.mods = raw.mods;
  if (raw.downloads !== undefined) result.downloads = raw.downloads;
  if (raw.file_count !== undefined) result.fileCount = raw.file_count;
  return result;
}

function mapMod(raw: RawMod): NexusMod {
  return {
    modId: raw.mod_id,
    name: raw.name,
    summary: raw.summary ?? "",
    description: raw.description ?? "",
    version: raw.version ?? "",
    author: raw.author ?? "",
    uploadedBy: raw.uploaded_by ?? "",
    domainName: raw.domain_name,
    categoryId: raw.category_id ?? 0,
    containsAdultContent: raw.contains_adult_content ?? false,
    status: raw.status ?? "unknown",
    available: raw.available ?? false,
    totalDownloads: raw.mod_downloads ?? 0,
    uniqueDownloads: raw.mod_unique_downloads ?? 0,
    endorsements: raw.endorsement_count ?? 0,
    createdAt: isoFromTimestamp(raw.created_timestamp),
    updatedAt: isoFromTimestamp(raw.updated_timestamp),
    pictureUrl: raw.picture_url ?? null,
    canonicalUrl: buildModUrl(raw.domain_name, raw.mod_id)
  };
}

function mapFile(raw: RawFile): NexusModFile {
  return {
    fileId: raw.file_id,
    name: raw.name ?? "",
    version: raw.version ?? "",
    categoryId: raw.category_id ?? 0,
    categoryName: raw.category_name ?? "UNKNOWN",
    fileName: raw.file_name ?? `file-${raw.file_id}`,
    sizeKb: raw.size_kb ?? raw.size ?? 0,
    sizeInBytes: raw.size_in_bytes ?? null,
    uploadedAt: isoFromTimestamp(raw.uploaded_timestamp),
    isPrimary: raw.is_primary ?? false,
    description: raw.description ?? "",
    contentPreviewLink: raw.content_preview_link ?? null
  };
}

function mapStatus(status: number, message: string): NexusError {
  if (status === 401) return new NexusError("AUTH_INVALID", "Nexus API rejected the configured API key.", { status });
  if (status === 404) return new NexusError("NOT_FOUND", "Nexus resource was not found.", { status });
  if (status === 429) return new NexusError("RATE_LIMITED", "Nexus API rate limit was reached.", { status, retryable: true });
  return new NexusError("UPSTREAM_ERROR", message || `Nexus API returned HTTP ${status}.`, {
    status,
    retryable: status >= 500
  });
}

export class NexusClient {
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;
  lastQuota: QuotaSnapshot | null = null;

  constructor(apiKey = process.env.NEXUS_API_KEY, timeoutMs = 20_000) {
    this.#apiKey = apiKey?.trim() || undefined;
    this.#timeoutMs = timeoutMs;
  }

  get configured(): boolean {
    return this.#apiKey !== undefined;
  }

  #headers(extra?: HeadersInit): Headers {
    if (!this.#apiKey) {
      throw new NexusError("AUTH_MISSING", "NEXUS_API_KEY is not configured.");
    }
    const headers = new Headers(extra);
    headers.set("apikey", this.#apiKey);
    headers.set("Application-Name", APP_NAME);
    headers.set("Application-Version", APP_VERSION);
    return headers;
  }

  async #request<T>(url: string, init: RequestInit = {}): Promise<RequestResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        headers: this.#headers(init.headers),
        signal: controller.signal
      });
      const quota = readQuota(response.headers);
      this.lastQuota = quota;
      const text = await response.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          if (!response.ok) throw mapStatus(response.status, "Nexus API returned a non-JSON error.");
          throw new NexusError("UPSTREAM_SCHEMA_CHANGED", "Nexus API returned non-JSON data.", {
            status: response.status
          });
        }
      }
      if (!response.ok) {
        const message =
          typeof parsed === "object" && parsed !== null && "message" in parsed
            ? String((parsed as { message: unknown }).message)
            : typeof parsed === "object" && parsed !== null && "error" in parsed
              ? String((parsed as { error: unknown }).error)
              : "";
        throw mapStatus(response.status, message);
      }
      return { data: parsed as T, quota };
    } catch (error) {
      if (error instanceof NexusError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new NexusError("UPSTREAM_ERROR", "Nexus API request timed out.", {
          retryable: true,
          cause: error
        });
      }
      throw new NexusError("UPSTREAM_ERROR", "Nexus API request failed.", {
        retryable: true,
        cause: error
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async validateCredentials(): Promise<{
    valid: true;
    isPremium: boolean;
    isSupporter: boolean;
    capabilities: {
      research: true;
      downloadWithoutInteractiveNxmAuthorization: boolean;
    };
    quota: QuotaSnapshot;
  }> {
    const { data, quota } = await this.#request<ValidateResponse>(`${REST_BASE}/users/validate.json`);
    const isPremium = data.is_premium ?? false;
    return {
      valid: true,
      isPremium,
      isSupporter: data.is_supporter ?? false,
      capabilities: {
        research: true,
        downloadWithoutInteractiveNxmAuthorization: isPremium
      },
      quota
    };
  }

  async listGames(): Promise<{ games: NexusGame[]; quota: QuotaSnapshot }> {
    const { data, quota } = await this.#request<RawGame[]>(`${REST_BASE}/games.json`);
    return { games: data.map(mapGame), quota };
  }

  async getGame(domainName: string): Promise<{ game: NexusGame; quota: QuotaSnapshot }> {
    const domain = normalizeDomainName(domainName);
    const { data, quota } = await this.#request<RawGame>(`${REST_BASE}/games/${encodeURIComponent(domain)}.json`);
    return { game: mapGame(data), quota };
  }

  async getMod(domainName: string, modId: number): Promise<{ mod: NexusMod; quota: QuotaSnapshot }> {
    const domain = normalizeDomainName(domainName);
    const { data, quota } = await this.#request<RawMod>(
      `${REST_BASE}/games/${encodeURIComponent(domain)}/mods/${modId}.json`
    );
    return { mod: mapMod(data), quota };
  }

  async getModFiles(domainName: string, modId: number): Promise<{ files: NexusModFile[]; quota: QuotaSnapshot }> {
    const domain = normalizeDomainName(domainName);
    const { data, quota } = await this.#request<RawFileResponse>(
      `${REST_BASE}/games/${encodeURIComponent(domain)}/mods/${modId}/files.json`
    );
    return { files: (data.files ?? []).map(mapFile), quota };
  }

  async getModChangelogs(
    domainName: string,
    modId: number
  ): Promise<{ changelogs: Record<string, string[]>; quota: QuotaSnapshot }> {
    const domain = normalizeDomainName(domainName);
    const { data, quota } = await this.#request<Record<string, string[]>>(
      `${REST_BASE}/games/${encodeURIComponent(domain)}/mods/${modId}/changelogs.json`
    );
    return { changelogs: data, quota };
  }

  async listFeed(
    domainName: string,
    feed: "latest_added" | "latest_updated" | "trending"
  ): Promise<{ mods: NexusMod[]; quota: QuotaSnapshot }> {
    const domain = normalizeDomainName(domainName);
    const { data, quota } = await this.#request<RawMod[]>(
      `${REST_BASE}/games/${encodeURIComponent(domain)}/mods/${feed}.json`
    );
    return { mods: data.map(mapMod), quota };
  }

  async #graph<T>(query: string, variables: Record<string, unknown>): Promise<RequestResult<T>> {
    const { data: response, quota } = await this.#request<GraphResponse<T>>(GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables })
    });
    if (!response.data) {
      const message = response.errors?.map((item) => item.message ?? "Unknown GraphQL error").join("; ") || "No data";
      throw new NexusError("UPSTREAM_SCHEMA_CHANGED", `Nexus GraphQL request failed: ${message}`);
    }
    return { data: response.data, quota };
  }

  async searchMods(input: {
    domainName: string;
    query?: string;
    sort?: "downloads" | "unique_downloads" | "endorsements" | "updated" | "created" | "relevance";
    offset?: number;
    count?: number;
  }): Promise<{ mods: DiscoveredMod[]; totalCount: number; quota: QuotaSnapshot }> {
    const domain = normalizeDomainName(input.domainName);
    const count = Math.min(Math.max(input.count ?? 10, 1), 50);
    const offset = Math.max(input.offset ?? 0, 0);
    const filters: Record<string, unknown>[] = [
      { gameDomainName: [{ value: domain, op: "EQUALS" }] },
      { status: [{ value: "published", op: "EQUALS" }] }
    ];
    const queryText = input.query?.trim();
    if (queryText) {
      filters.push({
        filter: [
          { nameStemmed: [{ value: queryText, op: "MATCHES" }] },
          { description: [{ value: queryText, op: "MATCHES" }] }
        ],
        op: "OR"
      });
    }
    const sortKey = input.sort ?? (queryText ? "relevance" : "downloads");
    const sortField: Record<string, string> = {
      downloads: "downloads",
      unique_downloads: "uniqueDownloads",
      endorsements: "endorsements",
      updated: "updatedAt",
      created: "createdAt",
      relevance: "relevance"
    };
    const graphQuery = `
      query SearchMods($filter: ModsFilter, $sort: [ModsSort!], $count: Int, $offset: Int) {
        mods(filter: $filter, sort: $sort, count: $count, offset: $offset) {
          totalCount
          nodes {
            modId name summary author version status downloads endorsements createdAt updatedAt
            game { domainName name }
          }
        }
      }
    `;
    interface SearchData {
      mods: {
        totalCount: number;
        nodes: Array<{
          modId: number;
          name: string;
          summary: string;
          author: string;
          version: string;
          status: string;
          downloads: number;
          endorsements: number;
          createdAt: string;
          updatedAt: string;
          game: { domainName: string; name: string };
        }>;
      };
    }
    const { data, quota } = await this.#graph<SearchData>(graphQuery, {
      filter: { filter: filters, op: "AND" },
      sort: [{ [sortField[sortKey] ?? "downloads"]: { direction: "DESC" } }],
      count,
      offset
    });
    return {
      totalCount: data.mods.totalCount,
      mods: data.mods.nodes.map((item) => ({
        modId: item.modId,
        name: item.name,
        summary: item.summary,
        author: item.author,
        version: item.version,
        status: item.status,
        domainName: item.game.domainName,
        totalDownloads: item.downloads,
        endorsements: item.endorsements,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        canonicalUrl: buildModUrl(item.game.domainName, item.modId)
      })),
      quota
    };
  }

  async getModRequirements(
    domainName: string,
    modId: number
  ): Promise<{ requirements: ModRequirements; quota: QuotaSnapshot }> {
    const domain = normalizeDomainName(domainName);
    const { game } = await this.getGame(domain);
    const uid = (BigInt(game.id) * 2n ** 32n + BigInt(modId)).toString();
    const graphQuery = `
      query ModRequirements($uids: [ID!]!) {
        modsByUid(uids: $uids) {
          nodes {
            modId
            modRequirements {
              dlcRequirements { notes gameExpansion { id gameId name } }
              nexusRequirements {
                totalCount nodes { id modId modName gameId url notes externalRequirement }
              }
              modsRequiringThisMod {
                totalCount nodes { id modId modName gameId url notes externalRequirement }
              }
            }
          }
        }
      }
    `;
    interface RequirementNode {
      id: string;
      modId: string;
      modName: string;
      gameId: string;
      url: string;
      notes?: string;
      externalRequirement: boolean;
    }
    interface RequirementData {
      modsByUid: {
        nodes: Array<{
          modId: number;
          modRequirements: {
            dlcRequirements: Array<{
              notes?: string;
              gameExpansion: { id: string; gameId: string; name: string };
            }>;
            nexusRequirements: { totalCount: number; nodes: RequirementNode[] };
            modsRequiringThisMod: { totalCount: number; nodes: RequirementNode[] };
          };
        }>;
      };
    }
    const { data, quota } = await this.#graph<RequirementData>(graphQuery, { uids: [uid] });
    const node = data.modsByUid.nodes.find((item) => item.modId === modId);
    if (!node) throw new NexusError("NOT_FOUND", "Mod requirements were not found.");
    const mapRequirement = (item: RequirementNode) => ({
      id: item.id,
      modId: item.modId,
      modName: item.modName,
      gameId: item.gameId,
      url: item.url,
      notes: item.notes ?? null,
      externalRequirement: item.externalRequirement
    });
    return {
      requirements: {
        dlcRequirements: node.modRequirements.dlcRequirements.map((item) => ({
          id: item.gameExpansion.id,
          gameId: item.gameExpansion.gameId,
          name: item.gameExpansion.name,
          notes: item.notes ?? null
        })),
        nexusRequirements: node.modRequirements.nexusRequirements.nodes.map(mapRequirement),
        modsRequiringThisMod: node.modRequirements.modsRequiringThisMod.nodes.map(mapRequirement),
        counts: {
          nexusRequirements: node.modRequirements.nexusRequirements.totalCount,
          modsRequiringThisMod: node.modRequirements.modsRequiringThisMod.totalCount
        }
      },
      quota
    };
  }

  async getDownloadLinks(input: {
    domainName: string;
    modId: number;
    fileId: number;
    key?: string;
    expires?: number;
  }): Promise<{ links: DownloadLink[]; quota: QuotaSnapshot }> {
    const domain = normalizeDomainName(input.domainName);
    const url = new URL(
      `${REST_BASE}/games/${encodeURIComponent(domain)}/mods/${input.modId}/files/${input.fileId}/download_link.json`
    );
    if (input.key !== undefined && input.expires !== undefined) {
      url.searchParams.set("key", input.key);
      url.searchParams.set("expires", String(input.expires));
    }
    let result: RequestResult<Array<{ name?: string; short_name?: string; URI?: string }>>;
    try {
      result = await this.#request<Array<{ name?: string; short_name?: string; URI?: string }>>(url.href);
    } catch (error) {
      if (error instanceof NexusError && error.status === 403) {
        throw new NexusError(
          input.key === undefined ? "DOWNLOAD_AUTH_REQUIRED" : "DOWNLOAD_AUTH_EXPIRED",
          input.key === undefined
            ? "This non-Premium account requires a temporary NXM authorization from the Nexus website."
            : "Nexus rejected the temporary NXM authorization; prepare the download again.",
          { status: 403 }
        );
      }
      throw error;
    }
    const { data, quota } = result;
    return {
      links: data
        .filter((item) => typeof item.URI === "string")
        .map((item) => ({
          name: item.name ?? "Nexus CDN",
          shortName: item.short_name ?? "cdn",
          uri: item.URI as string
        })),
      quota
    };
  }
}
