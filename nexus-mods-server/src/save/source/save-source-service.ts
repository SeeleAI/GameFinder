import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, mkdir, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import { NexusError } from "../../errors.js";
import { sha256CanonicalJson } from "../../install/content-hash.js";
import { sha256File } from "../../install/file-hash.js";
import type { ModRequirements, NexusMod, NexusModFile } from "../../types.js";
import {
  fileExists,
  inspectArchive,
  resolveOutputDirectory,
  sanitizeDownloadFileName,
  verifyExistingDownloadReceipt,
} from "../../download-verifier.js";
import {
  type SaveDownloadReceipt,
  saveDownloadReceiptSchema,
  type SaveSourceCandidate,
  saveSourceCandidateSchema,
  type SaveSourceSnapshot,
  saveSourceSnapshotSchema,
} from "../contracts.js";
import { parseSpeedrunResourcesPage } from "./speedrun-resources-parser.js";
import { SaveSourceStore } from "./save-source-store.js";

const DEFAULT_NEXUS_QUERIES = Object.freeze([
  "100 percent complete save",
  "complete save",
  "all achievements save",
  "NG plus ready save",
]);
const MAX_SOURCE_HTML_BYTES = 5 * 1024 * 1024;
const MAX_SAVE_DOWNLOAD_BYTES = 20 * 1024 ** 3;

export interface NexusSaveResearchClient {
  searchMods(input: {
    domainName: string;
    query?: string;
    sort?: "downloads" | "unique_downloads" | "endorsements" | "updated" | "created" | "relevance";
    offset?: number;
    count?: number;
  }): Promise<{ mods: Array<{ modId: number; name: string; summary: string; totalDownloads: number; endorsements: number }>; totalCount: number; quota: unknown }>;
  getMod(domainName: string, modId: number): Promise<{ mod: NexusMod; quota: unknown }>;
  getModFiles(domainName: string, modId: number): Promise<{ files: NexusModFile[]; quota: unknown }>;
  getModRequirements(domainName: string, modId: number): Promise<{ requirements: ModRequirements; quota: unknown }>;
}

export type SaveSourceFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export interface SaveSourceResearchResult {
  snapshot: Readonly<SaveSourceSnapshot>;
  candidates: ReadonlyArray<Readonly<SaveSourceCandidate>>;
}

interface CandidateDraft {
  stableKey: string;
  source: SaveSourceCandidate["source"];
  title: string;
  summary: string;
  author: string | null;
  manager: string | null;
  pageUrl: string;
  status: SaveSourceCandidate["status"];
  claims: SaveSourceCandidate["claims"];
  metrics: SaveSourceCandidate["metrics"];
  updatedAt: string | null;
  selection: SaveSourceCandidate["selection"];
  rank: SaveSourceCandidate["rank"];
  metadata: unknown;
}

function authorClaims(text: string, requirements: ModRequirements): SaveSourceCandidate["claims"] {
  const normalized = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const version = normalized.match(/(?:patch|game\s*version|version|ver\.?)[\s:=-]*([0-9]+(?:\.[0-9]+){1,3})/i)?.[1] ?? null;
  const dlc = new Set(requirements.dlcRequirements.map((item) => item.name));
  if (/shadow of the erdtree|\bDLC\b/i.test(normalized)) dlc.add("Shadow of the Erdtree");
  return {
    progress: /100\s*%|100 percent|complete save|all (?:items|achievements|bosses)|ng\s*\+/i.test(normalized)
      ? normalized.slice(0, 4_000)
      : null,
    gameVersion: version,
    dlc: [...dlc].slice(0, 100),
    onlineSafety: /(?:online|multiplayer)\s*(?:safe|compatible)|safe\s+(?:online|for online)/i.test(normalized)
      ? "author-claimed"
      : "unknown",
  };
}

function candidateScore(text: string, metrics: SaveSourceCandidate["metrics"], mainFile: boolean): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const checks: Array<[RegExp, number, string]> = [
    [/100\s*%|100 percent/i, 35, "Author text explicitly claims 100% progress."],
    [/complete save|fully complete/i, 25, "Author text describes a complete save."],
    [/all (?:items|achievements|bosses|weapons|armor)/i, 15, "Author text names broad completion coverage."],
    [/shadow of the erdtree|\bDLC\b/i, 10, "Author text mentions DLC progress."],
    [/ng\s*\+|new game plus/i, 8, "Author text describes New Game Plus readiness."],
  ];
  for (const [pattern, points, reason] of checks) {
    if (pattern.test(text)) {
      score += points;
      reasons.push(reason);
    }
  }
  if (mainFile) {
    score += 10;
    reasons.push("The selected Nexus file is MAIN or marked primary.");
  }
  const downloads = metrics.uniqueDownloads ?? metrics.totalDownloads ?? 0;
  if (downloads > 0) {
    score += Math.min(15, Math.log10(downloads + 1) * 3);
    reasons.push("Download volume contributes a bounded popularity signal.");
  }
  if ((metrics.endorsements ?? 0) > 0) {
    score += Math.min(10, Math.log10((metrics.endorsements ?? 0) + 1) * 3);
    reasons.push("Endorsements contribute a bounded popularity signal.");
  }
  if (reasons.length === 0) reasons.push("Candidate is in the source Saves scope.");
  return { score: Number(score.toFixed(3)), reasons };
}

function safeSourceUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new NexusError("SAVE_SOURCE_UNAVAILABLE", "Save download URL must use HTTP(S).");
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(host) ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80:")
  ) {
    throw new NexusError("SAVE_SOURCE_UNAVAILABLE", "Save download URL resolves to a forbidden local address literal.");
  }
  return url;
}

function redactedUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}

function contentDispositionFileName(header: string | null): string | null {
  if (!header) return null;
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded.replace(/^"|"$/g, "")); } catch { return null; }
  }
  return header.match(/filename\s*=\s*"([^"]+)"/i)?.[1]
    ?? header.match(/filename\s*=\s*([^;]+)/i)?.[1]?.trim()
    ?? null;
}

export class SaveSourceService {
  readonly #store: SaveSourceStore;
  readonly #nexus: NexusSaveResearchClient;
  readonly #fetch: SaveSourceFetch;

  private constructor(input: {
    store: SaveSourceStore;
    nexus: NexusSaveResearchClient;
    fetch: SaveSourceFetch;
  }) {
    this.#store = input.store;
    this.#nexus = input.nexus;
    this.#fetch = input.fetch;
  }

  static async create(input: {
    managerRoot: string;
    nexus: NexusSaveResearchClient;
    fetch?: SaveSourceFetch;
  }): Promise<SaveSourceService> {
    return new SaveSourceService({
      store: await SaveSourceStore.create(input.managerRoot),
      nexus: input.nexus,
      fetch: input.fetch ?? fetch,
    });
  }

  async researchNexus(input: {
    game: SaveSourceCandidate["game"];
    domainName: string;
    query?: string;
    maxCandidates?: number;
  }): Promise<SaveSourceResearchResult> {
    const maxCandidates = Math.min(Math.max(input.maxCandidates ?? 10, 1), 50);
    const queries = input.query?.trim() ? [input.query.trim()] : [...DEFAULT_NEXUS_QUERIES];
    const discovered = new Map<number, { modId: number; name: string; summary: string; totalDownloads: number; endorsements: number }>();
    for (const query of queries) {
      const result = await this.#nexus.searchMods({
        domainName: input.domainName,
        query,
        sort: "relevance",
        count: Math.min(20, Math.max(maxCandidates * 2, 10)),
      });
      for (const mod of result.mods) discovered.set(mod.modId, mod);
    }
    const rankedMods = [...discovered.values()]
      .sort((left, right) => {
        const leftMatch = candidateScore(`${left.name} ${left.summary}`, {
          totalDownloads: left.totalDownloads,
          uniqueDownloads: null,
          endorsements: left.endorsements,
        }, false).score;
        const rightMatch = candidateScore(`${right.name} ${right.summary}`, {
          totalDownloads: right.totalDownloads,
          uniqueDownloads: null,
          endorsements: right.endorsements,
        }, false).score;
        return rightMatch - leftMatch;
      })
      .slice(0, Math.min(25, maxCandidates * 3));
    const drafts: CandidateDraft[] = [];
    for (const discoveredMod of rankedMods) {
      const [{ mod }, { files }, { requirements }] = await Promise.all([
        this.#nexus.getMod(input.domainName, discoveredMod.modId),
        this.#nexus.getModFiles(input.domainName, discoveredMod.modId),
        this.#nexus.getModRequirements(input.domainName, discoveredMod.modId),
      ]);
      const eligibleFiles = files.filter((file) => {
        const category = file.categoryName.trim().toUpperCase().replace(/[ -]+/g, "_");
        return category === "MAIN" || file.isPrimary;
      });
      for (const file of eligibleFiles) {
        const fullText = `${mod.name} ${mod.summary} ${mod.description} ${file.name} ${file.description}`;
        const metrics = {
          totalDownloads: mod.totalDownloads,
          uniqueDownloads: mod.uniqueDownloads,
          endorsements: mod.endorsements,
        };
        const metadata = { mod, file, requirements };
        drafts.push({
          stableKey: `nexus:${input.domainName.toLowerCase()}:${mod.modId}:${file.fileId}`,
          source: "nexus",
          title: mod.name,
          summary: `${mod.summary}${file.description ? `\n\nSelected file: ${file.description}` : ""}`.slice(0, 20_000),
          author: mod.author || mod.uploadedBy || null,
          manager: null,
          pageUrl: mod.canonicalUrl,
          status: mod.available && mod.status.toLowerCase() === "published" ? "available" : "unavailable",
          claims: authorClaims(fullText, requirements),
          metrics,
          updatedAt: file.uploadedAt ?? mod.updatedAt,
          selection: {
            kind: "nexus",
            domainName: input.domainName.toLowerCase(),
            modId: mod.modId,
            fileId: file.fileId,
            fileName: file.fileName,
            fileVersion: file.version,
            categoryName: file.categoryName,
            sizeInBytes: file.sizeInBytes,
            isPrimary: file.isPrimary,
            contentPreviewLink: file.contentPreviewLink,
          },
          rank: candidateScore(fullText, metrics, true),
          metadata,
        });
      }
    }
    drafts.sort((left, right) => right.rank.score - left.rank.score || left.stableKey.localeCompare(right.stableKey));
    return await this.#publishResearch({
      source: "nexus",
      game: input.game,
      pageUrl: `https://www.nexusmods.com/games/${input.domainName.toLowerCase()}`,
      query: input.query?.trim() || null,
      fetchMode: "api",
      drafts: drafts.slice(0, maxCandidates),
      warnings: drafts.length === 0
        ? ["No available MAIN or primary Nexus save file candidates were found."]
        : ["Progress, game-version, DLC, and online-safety text remains author-supplied claims."],
    });
  }

  async researchSpeedrunFromSnapshot(input: {
    game: SaveSourceCandidate["game"];
    pageUrl: string;
    pageHtml: string;
    detailPages?: Readonly<Record<string, string>>;
    fetchMode?: "html" | "fixture";
  }): Promise<SaveSourceResearchResult> {
    if (Buffer.byteLength(input.pageHtml, "utf8") > MAX_SOURCE_HTML_BYTES) {
      throw new NexusError("SAVE_SOURCE_UNAVAILABLE", "Speedrun page snapshot exceeds the source inspection limit.");
    }
    const parsed = parseSpeedrunResourcesPage({
      html: input.pageHtml,
      pageUrl: input.pageUrl,
      ...(input.detailPages ? { detailPages: input.detailPages } : {}),
    });
    const drafts: CandidateDraft[] = parsed.resources.map((resource) => {
      const text = `${resource.title} ${resource.summary}`;
      const metrics = { totalDownloads: null, uniqueDownloads: null, endorsements: null };
      return {
        stableKey: `speedrun:${parsed.gameSlug}:${resource.resourceId ?? resource.resourceUrl}`,
        source: "speedrun" as const,
        title: resource.title,
        summary: resource.summary,
        author: resource.author,
        manager: resource.manager,
        pageUrl: resource.resourceUrl,
        status: resource.downloadUrl ? "available" as const : "manual-handoff" as const,
        claims: {
          progress: /100\s*%|complete|all /i.test(text) ? text.slice(0, 4_000) : null,
          gameVersion: text.match(/(?:version|ver\.?)[\s:=-]*([0-9]+(?:\.[0-9]+){1,3})/i)?.[1] ?? null,
          dlc: [],
          onlineSafety: "unknown" as const,
        },
        metrics,
        updatedAt: null,
        selection: {
          kind: "speedrun" as const,
          gameSlug: parsed.gameSlug,
          resourceUrl: resource.resourceUrl,
          resourceId: resource.resourceId,
          downloadUrl: resource.downloadUrl,
        },
        rank: candidateScore(text, metrics, false),
        metadata: resource,
      };
    });
    drafts.sort((left, right) => right.rank.score - left.rank.score || left.stableKey.localeCompare(right.stableKey));
    return await this.#publishResearch({
      source: "speedrun",
      game: input.game,
      pageUrl: input.pageUrl,
      query: null,
      fetchMode: input.fetchMode ?? "html",
      drafts,
      warnings: parsed.noSaves
        ? ["The Speedrun Saves category explicitly reports No Saves; other categories were not promoted."]
        : drafts.some((draft) => draft.status === "manual-handoff")
          ? ["Some Speedrun resource detail pages lack a direct download URL and require browser or manual handoff."]
          : [],
    });
  }

  async researchSpeedrunOnline(input: {
    game: SaveSourceCandidate["game"];
    pageUrl: string;
  }): Promise<SaveSourceResearchResult> {
    const pageHtml = await this.#fetchHtml(input.pageUrl);
    const index = parseSpeedrunResourcesPage({ html: pageHtml, pageUrl: input.pageUrl });
    const detailPages: Record<string, string> = {};
    for (const resource of index.resources) {
      detailPages[resource.resourceUrl] = await this.#fetchHtml(resource.resourceUrl);
    }
    return await this.researchSpeedrunFromSnapshot({
      ...input,
      pageHtml,
      detailPages,
      fetchMode: "html",
    });
  }

  async recordNexusDownload(input: {
    candidateId: string;
    nexusReceiptPath: string;
  }): Promise<Readonly<SaveDownloadReceipt>> {
    const candidate = await this.#store.getCandidate(input.candidateId);
    if (candidate.selection.kind !== "nexus" || candidate.status !== "available") {
      throw new NexusError("SAVE_SOURCE_UNAVAILABLE", "Candidate is not an available Nexus save selection.");
    }
    const receipt = await verifyExistingDownloadReceipt(input.nexusReceiptPath);
    if (
      receipt.domainName !== candidate.selection.domainName ||
      receipt.modId !== candidate.selection.modId ||
      receipt.fileId !== candidate.selection.fileId
    ) {
      throw new NexusError(
        "SAVE_SOURCE_UNAVAILABLE",
        "Nexus receipt does not match the frozen save candidate selection.",
      );
    }
    const snapshot = await this.#store.getSnapshot(candidate.snapshotId);
    return await this.#store.saveReceipt(this.#receipt({
      candidate,
      snapshot,
      backend: receipt.backend === "native" ? "nexus-native" : "nexus-persistent-chromium",
      originalFileName: candidate.selection.fileName,
      finalFileName: receipt.fileName,
      absolutePath: receipt.absolutePath,
      bytes: receipt.bytes,
      sha256: receipt.sha256,
      contentType: null,
      finalUrl: null,
      redirectChain: [],
      archiveCheck: receipt.archiveCheck,
      requestedAt: receipt.completedAt,
      completedAt: receipt.completedAt,
    }));
  }

  async recordManualDownload(input: {
    candidateId: string;
    absolutePath: string;
  }): Promise<Readonly<SaveDownloadReceipt>> {
    const candidate = await this.#store.getCandidate(input.candidateId);
    if (!path.isAbsolute(input.absolutePath)) {
      throw new NexusError("SAVE_CONTRACT_INVALID", "Manual save download path must be absolute.");
    }
    const resolved = path.resolve(input.absolutePath);
    const info = await stat(resolved).catch((error: unknown) => {
      throw new NexusError("SAVE_SOURCE_UNAVAILABLE", "Manual save download is unavailable.", { cause: error });
    });
    if (!info.isFile()) throw new NexusError("SAVE_SOURCE_UNAVAILABLE", "Manual save download is not a regular file.");
    const [sha256, archiveCheck, snapshot] = await Promise.all([
      sha256File(resolved),
      inspectArchive(resolved, path.basename(resolved), info.size),
      this.#store.getSnapshot(candidate.snapshotId),
    ]);
    if (archiveCheck.valid === false) throw new NexusError("ARCHIVE_INVALID", archiveCheck.detail);
    const now = new Date().toISOString();
    return await this.#store.saveReceipt(this.#receipt({
      candidate,
      snapshot,
      backend: "manual",
      originalFileName: path.basename(resolved),
      finalFileName: path.basename(resolved),
      absolutePath: resolved,
      bytes: info.size,
      sha256,
      contentType: null,
      finalUrl: null,
      redirectChain: [],
      archiveCheck,
      requestedAt: now,
      completedAt: now,
    }));
  }

  async downloadSpeedrun(input: {
    candidateId: string;
    outputDirectory: string;
  }): Promise<Readonly<SaveDownloadReceipt>> {
    const candidate = await this.#store.getCandidate(input.candidateId);
    if (
      candidate.selection.kind !== "speedrun" ||
      candidate.status !== "available" ||
      !candidate.selection.downloadUrl
    ) {
      throw new NexusError(
        "SAVE_SOURCE_UNAVAILABLE",
        "Speedrun candidate has no direct HTTP(S) download; use manual handoff.",
      );
    }
    const outputDirectory = await resolveOutputDirectory(input.outputDirectory);
    const stagingRoot = path.join(outputDirectory, ".save-download-staging");
    await mkdir(stagingRoot, { recursive: true });
    const stagingPath = path.join(stagingRoot, `${randomUUID()}.part`);
    const requestedAt = new Date().toISOString();
    const redirects: string[] = [];
    let current = safeSourceUrl(candidate.selection.downloadUrl);
    let response: Response | null = null;
    for (let count = 0; count <= 10; count += 1) {
      redirects.push(redactedUrl(current.href));
      response = await this.#fetch(current.href, {
        redirect: "manual",
        headers: { "user-agent": "GameFinder/0.1.0" },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location || count === 10) {
        throw new NexusError("SAVE_SOURCE_UNAVAILABLE", "Speedrun download redirect chain is invalid or too long.");
      }
      current = safeSourceUrl(new URL(location, current).href);
    }
    if (!response?.ok || !response.body) {
      throw new NexusError(
        "SAVE_SOURCE_UNAVAILABLE",
        `Speedrun download returned HTTP ${response?.status ?? 0}.`,
        { retryable: (response?.status ?? 0) >= 500 },
      );
    }
    const declaredBytes = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_SAVE_DOWNLOAD_BYTES) {
      throw new NexusError("SAVE_SOURCE_UNAVAILABLE", "Speedrun download exceeds the save download limit.");
    }
    let received = 0;
    const limiter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > MAX_SAVE_DOWNLOAD_BYTES) {
          controller.error(new NexusError("SAVE_SOURCE_UNAVAILABLE", "Speedrun download exceeds the save download limit."));
          return;
        }
        controller.enqueue(chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body.pipeThrough(limiter) as never),
        createWriteStream(stagingPath, { flags: "wx" }),
      );
      if (Number.isFinite(declaredBytes) && declaredBytes >= 0 && received !== declaredBytes) {
        throw new NexusError("DOWNLOAD_SIZE_MISMATCH", "Speedrun download size differs from HTTP metadata.");
      }
      const suggested = contentDispositionFileName(response.headers.get("content-disposition"))
        ?? path.basename(current.pathname)
        ?? `speedrun-save-${candidate.candidateId}.archive`;
      const finalFileName = sanitizeDownloadFileName(suggested, `speedrun-save-${candidate.candidateId}.archive`);
      const finalPath = path.join(outputDirectory, finalFileName);
      if (await fileExists(finalPath)) throw new NexusError("OUTPUT_FILE_EXISTS", `Output file already exists: ${finalPath}`);
      const [sha256, archiveCheck, snapshot] = await Promise.all([
        sha256File(stagingPath),
        inspectArchive(stagingPath, finalFileName, received),
        this.#store.getSnapshot(candidate.snapshotId),
      ]);
      if (archiveCheck.valid === false) throw new NexusError("ARCHIVE_INVALID", archiveCheck.detail);
      await link(stagingPath, finalPath);
      await unlink(stagingPath);
      try {
        return await this.#store.saveReceipt(this.#receipt({
          candidate,
          snapshot,
          backend: "http",
          originalFileName: path.basename(new URL(candidate.selection.downloadUrl).pathname) || finalFileName,
          finalFileName,
          absolutePath: finalPath,
          bytes: received,
          sha256,
          contentType: response.headers.get("content-type"),
          finalUrl: redactedUrl(current.href),
          redirectChain: redirects,
          archiveCheck,
          requestedAt,
          completedAt: new Date().toISOString(),
        }));
      } catch (error) {
        await rm(finalPath, { force: true });
        throw error;
      }
    } finally {
      await rm(stagingPath, { force: true }).catch(() => undefined);
    }
  }

  async getCandidate(candidateId: string): Promise<Readonly<SaveSourceCandidate>> {
    return await this.#store.getCandidate(candidateId);
  }

  async getSnapshot(snapshotId: string): Promise<Readonly<SaveSourceSnapshot>> {
    return await this.#store.getSnapshot(snapshotId);
  }

  async verifyReceipt(receiptId: string): Promise<Readonly<SaveDownloadReceipt>> {
    const receipt = await this.#store.getReceipt(receiptId);
    const info = await stat(receipt.absolutePath).catch((error: unknown) => {
      throw new NexusError("SAVE_SOURCE_UNAVAILABLE", "Downloaded save referenced by receipt is missing.", { cause: error });
    });
    if (
      !info.isFile() ||
      info.size !== receipt.bytes ||
      (await sha256File(receipt.absolutePath)) !== receipt.sha256
    ) {
      throw new NexusError("SAVE_SOURCE_UNAVAILABLE", "Downloaded save no longer matches its verified receipt.");
    }
    return receipt;
  }

  async #publishResearch(input: {
    source: SaveSourceSnapshot["source"];
    game: SaveSourceSnapshot["game"];
    pageUrl: string;
    query: string | null;
    fetchMode: SaveSourceSnapshot["fetchMode"];
    drafts: CandidateDraft[];
    warnings: string[];
  }): Promise<SaveSourceResearchResult> {
    const snapshotId = randomUUID();
    const previous = await this.#store.findLatestSnapshot({
      source: input.source,
      gameCanonicalId: input.game.canonicalId,
      pageUrl: input.pageUrl,
      query: input.query,
    });
    const previousCandidates = previous ? await this.#store.getCandidates(previous.snapshotId) : [];
    const previousByKey = new Map(previousCandidates.map((candidate) => [candidate.stableKey, candidate]));
    const candidates = input.drafts.map((draft) => {
      const sourceMetadataHash = sha256CanonicalJson(draft.metadata);
      const withoutHash = {
        schemaVersion: 1 as const,
        candidateId: randomUUID(),
        snapshotId,
        stableKey: draft.stableKey,
        source: draft.source,
        game: input.game,
        title: draft.title,
        summary: draft.summary,
        author: draft.author,
        manager: draft.manager,
        pageUrl: draft.pageUrl,
        status: draft.status,
        claims: draft.claims,
        metrics: draft.metrics,
        updatedAt: draft.updatedAt,
        selection: draft.selection,
        rank: draft.rank,
        sourceMetadataHash,
      };
      return saveSourceCandidateSchema.parse({
        ...withoutHash,
        candidateHash: sha256CanonicalJson(withoutHash),
      });
    });
    const currentByKey = new Map(candidates.map((candidate) => [candidate.stableKey, candidate]));
    const keys = [...new Set([...previousByKey.keys(), ...currentByKey.keys()])].sort();
    const drift: SaveSourceSnapshot["drift"] = keys.map((stableKey) => {
      const before = previousByKey.get(stableKey);
      const after = currentByKey.get(stableKey);
      return {
        stableKey,
        state: !before ? "new" as const : !after ? "removed" as const : before.sourceMetadataHash === after.sourceMetadataHash ? "unchanged" as const : "changed" as const,
        previousMetadataHash: before?.sourceMetadataHash ?? null,
        currentMetadataHash: after?.sourceMetadataHash ?? null,
      };
    });
    const fetchedAt = new Date().toISOString();
    const sourceContentHash = sha256CanonicalJson(
      candidates.map((candidate) => ({ stableKey: candidate.stableKey, sourceMetadataHash: candidate.sourceMetadataHash })),
    );
    const withoutHash = {
      schemaVersion: 1 as const,
      snapshotId,
      source: input.source,
      game: input.game,
      pageUrl: input.pageUrl,
      query: input.query,
      fetchedAt,
      fetchMode: input.fetchMode,
      candidateIds: candidates.map((candidate) => candidate.candidateId),
      sourceContentHash,
      previousSnapshotId: previous?.snapshotId ?? null,
      drift,
      warnings: input.warnings,
    };
    const snapshot = saveSourceSnapshotSchema.parse({
      ...withoutHash,
      snapshotHash: sha256CanonicalJson(withoutHash),
    });
    return await this.#store.saveResearch({ snapshot, candidates });
  }

  async #fetchHtml(url: string): Promise<string> {
    const response = await this.#fetch(safeSourceUrl(url).href, {
      redirect: "follow",
      headers: { "user-agent": "GameFinder/0.1.0" },
    });
    if (!response.ok) {
      throw new NexusError("SAVE_SOURCE_UNAVAILABLE", `Speedrun page returned HTTP ${response.status}.`, {
        status: response.status,
        retryable: response.status >= 500,
      });
    }
    const html = await response.text();
    if (
      Buffer.byteLength(html, "utf8") > MAX_SOURCE_HTML_BYTES ||
      /cf-chl-|enable javascript and cookies to continue|just a moment/i.test(html)
    ) {
      throw new NexusError(
        "SAVE_SOURCE_UNAVAILABLE",
        "Speedrun page requires a controlled browser snapshot or manual handoff.",
        { details: { handoff: "browser-page-snapshot" } },
      );
    }
    return html;
  }

  #receipt(input: {
    candidate: Readonly<SaveSourceCandidate>;
    snapshot: Readonly<SaveSourceSnapshot>;
    backend: SaveDownloadReceipt["backend"];
    originalFileName: string;
    finalFileName: string;
    absolutePath: string;
    bytes: number;
    sha256: string;
    contentType: string | null;
    finalUrl: string | null;
    redirectChain: string[];
    archiveCheck: SaveDownloadReceipt["archiveCheck"];
    requestedAt: string;
    completedAt: string;
  }): SaveDownloadReceipt {
    const selectionKey = input.candidate.selection.kind === "nexus"
      ? `${input.candidate.selection.domainName}:${input.candidate.selection.modId}:${input.candidate.selection.fileId}`
      : input.candidate.selection.resourceUrl;
    const withoutHash = {
      schemaVersion: 1 as const,
      receiptId: randomUUID(),
      candidateId: input.candidate.candidateId,
      candidateHash: input.candidate.candidateHash,
      source: input.candidate.source,
      sourceSnapshotId: input.snapshot.snapshotId,
      sourceSnapshotHash: input.snapshot.snapshotHash,
      pageUrl: input.candidate.pageUrl,
      selectionKey,
      backend: input.backend,
      originalFileName: input.originalFileName,
      finalFileName: input.finalFileName,
      absolutePath: input.absolutePath,
      bytes: input.bytes,
      sha256: input.sha256,
      contentType: input.contentType,
      finalUrl: input.finalUrl,
      redirectChain: input.redirectChain,
      archiveCheck: input.archiveCheck,
      requestedAt: input.requestedAt,
      completedAt: input.completedAt,
      status: "verified" as const,
      packageId: null,
    };
    return saveDownloadReceiptSchema.parse({
      ...withoutHash,
      receiptHash: sha256CanonicalJson(withoutHash),
    });
  }
}
