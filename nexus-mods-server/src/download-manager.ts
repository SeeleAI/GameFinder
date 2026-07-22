import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, link, mkdir, open, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { NexusError } from "./errors.js";
import { NexusClient } from "./nexus-client.js";
import type { NexusModFile } from "./types.js";

interface NxmAuthorization {
  key: string;
  expires: number;
}

interface DownloadSession {
  id: string;
  domainName: string;
  modId: number;
  canonicalUrl: string;
  file: NexusModFile;
  isPremium: boolean;
  createdAt: number;
  expiresAt: number;
  authorization: NxmAuthorization | undefined;
  state: "awaiting_authorization" | "ready" | "downloading" | "completed" | "failed";
}

export interface PreparedDownload {
  sessionId: string;
  state: DownloadSession["state"];
  mod: {
    domainName: string;
    modId: number;
    canonicalUrl: string;
  };
  file: NexusModFile;
  capability: {
    isPremium: boolean;
    interactiveNxmAuthorizationRequired: boolean;
  };
  nexusFilesUrl: string;
  authorizationPageUrl: string | null;
  expiresAt: string;
}

export interface DownloadReceipt {
  canonicalModUrl: string;
  domainName: string;
  modId: number;
  fileId: number;
  fileName: string;
  bytes: number;
  sha256: string;
  completedAt: string;
  targetPath: string;
  receiptPath: string;
  archiveCheck: {
    format: string;
    valid: boolean | null;
    detail: string;
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeFileName(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/[. ]+$/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "nexus-mod-file";
  return cleaned.slice(0, 220);
}

function parseNxmAuthorization(value: string, session: DownloadSession): NxmAuthorization {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new NexusError("INVALID_INPUT", "The submitted value is not a valid NXM URL.");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    url.protocol !== "nxm:" ||
    url.hostname.toLowerCase() !== session.domainName ||
    segments[0]?.toLowerCase() !== "mods" ||
    Number(segments[1]) !== session.modId ||
    segments[2]?.toLowerCase() !== "files" ||
    Number(segments[3]) !== session.file.fileId
  ) {
    throw new NexusError("INVALID_INPUT", "The NXM URL does not match the prepared game, mod, and file.");
  }
  const key = url.searchParams.get("key")?.trim();
  const expires = Number(url.searchParams.get("expires"));
  if (!key || !Number.isSafeInteger(expires)) {
    throw new NexusError("INVALID_INPUT", "The NXM URL is missing its temporary key or expiry.");
  }
  if (expires * 1000 <= Date.now()) {
    throw new NexusError("DOWNLOAD_AUTH_EXPIRED", "The NXM authorization has expired.");
  }
  return { key, expires };
}

async function readRequestBody(request: IncomingMessage, maxBytes = 16_384): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new NexusError("INVALID_INPUT", "Authorization form body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function html(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff"
  });
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Nexus download authorization</title><style>body{font:16px system-ui;max-width:760px;margin:3rem auto;padding:0 1rem;line-height:1.5}input{width:100%;padding:.7rem;box-sizing:border-box}button{margin-top:1rem;padding:.6rem 1rem}code{overflow-wrap:anywhere}</style></head><body>${body}</body></html>`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function inspectArchive(filePath: string, fileName: string, bytes: number): Promise<DownloadReceipt["archiveCheck"]> {
  const extension = path.extname(fileName).toLowerCase();
  const handle = await open(filePath, "r");
  try {
    const magic = Buffer.alloc(Math.min(8, bytes));
    await handle.read(magic, 0, magic.length, 0);
    if (extension === ".zip" || magic.subarray(0, 2).equals(Buffer.from([0x50, 0x4b]))) {
      const tailLength = Math.min(bytes, 65_557);
      const tail = Buffer.alloc(tailLength);
      await handle.read(tail, 0, tailLength, bytes - tailLength);
      const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
      return tail.lastIndexOf(eocd) >= 0
        ? { format: "zip", valid: true, detail: "ZIP end-of-central-directory record found." }
        : { format: "zip", valid: false, detail: "ZIP end-of-central-directory record was not found." };
    }
    if (extension === ".7z" && magic.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) {
      return { format: "7z", valid: null, detail: "7z magic matched; deep archive validation is not enabled." };
    }
    if (extension === ".rar" && magic.subarray(0, 4).equals(Buffer.from([0x52, 0x61, 0x72, 0x21]))) {
      return { format: "rar", valid: null, detail: "RAR magic matched; deep archive validation is not enabled." };
    }
    return {
      format: extension.replace(/^\./, "") || "unknown",
      valid: null,
      detail: `Archive parser unavailable; leading magic is ${magic.toString("hex")}.`
    };
  } finally {
    await handle.close();
  }
}

export function selectDownloadFile(files: NexusModFile[], requestedFileId?: number): NexusModFile {
  if (requestedFileId !== undefined) {
    const selected = files.find((file) => file.fileId === requestedFileId);
    if (!selected) throw new NexusError("NOT_FOUND", `Nexus fileId ${requestedFileId} was not found for this mod.`);
    if (["ARCHIVED", "REMOVED"].includes(selected.categoryName.toUpperCase())) {
      throw new NexusError("INVALID_INPUT", `Nexus fileId ${requestedFileId} is ${selected.categoryName} and is not selected automatically.`);
    }
    return selected;
  }
  const main = files
    .filter((file) => file.categoryName.toUpperCase() === "MAIN")
    .sort((a, b) => {
      const primary = Number(b.isPrimary) - Number(a.isPrimary);
      if (primary !== 0) return primary;
      return (Date.parse(b.uploadedAt ?? "1970-01-01") || 0) - (Date.parse(a.uploadedAt ?? "1970-01-01") || 0);
    });
  if (main.length === 0) {
    throw new NexusError("INVALID_INPUT", "No active MAIN file exists. Supply an explicit fileId after reviewing candidates.", {
      details: { candidateFileIds: files.map((file) => file.fileId) }
    });
  }
  return main[0] as NexusModFile;
}

export class DownloadManager {
  readonly #client: NexusClient;
  readonly #sessions = new Map<string, DownloadSession>();
  #server: Server | undefined;
  #port: number | undefined;

  constructor(client: NexusClient) {
    this.#client = client;
  }

  async #ensureAuthorizationServer(): Promise<number> {
    if (this.#server && this.#port) return this.#port;
    this.#server = createServer((request, response) => {
      void this.#handleAuthorizationRequest(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.#server?.once("error", reject);
      this.#server?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.#server.address();
    if (!address || typeof address === "string") {
      throw new NexusError("UPSTREAM_ERROR", "Could not bind the local NXM authorization server.");
    }
    this.#port = address.port;
    return address.port;
  }

  async #handleAuthorizationRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const match = /^\/authorize\/([0-9a-f-]+)$/.exec(requestUrl.pathname);
      const session = match?.[1] ? this.#sessions.get(match[1]) : undefined;
      if (!session || session.expiresAt <= Date.now()) {
        html(response, 404, "<h1>Authorization session unavailable</h1><p>Create a new download session in Codex.</p>");
        return;
      }
      if (request.method === "GET") {
        const target = `${session.domainName} mod ${session.modId}, file ${session.file.fileId}`;
        html(
          response,
          200,
          `<h1>Authorize one Nexus download</h1><p>Target: <strong>${escapeHtml(target)}</strong></p><ol><li>Open the <a href="${escapeHtml(`https://www.nexusmods.com/${session.domainName}/mods/${session.modId}?tab=files&file_id=${session.file.fileId}`)}">Nexus files page</a> in your signed-in browser.</li><li>Right-click the matching <em>Mod Manager Download</em> action and copy its <code>nxm://</code> link.</li><li>Paste it below. It is sent only to this loopback server and is never returned to Codex.</li></ol><form method="post"><label for="nxmUrl">NXM URL</label><input id="nxmUrl" name="nxmUrl" type="password" autocomplete="off" required><button type="submit">Authorize this download</button></form>`
        );
        return;
      }
      if (request.method === "POST") {
        const body = await readRequestBody(request);
        const form = new URLSearchParams(body);
        const nxmUrl = form.get("nxmUrl") ?? "";
        session.authorization = parseNxmAuthorization(nxmUrl, session);
        session.state = "ready";
        html(response, 200, "<h1>Authorization received</h1><p>Return to Codex and continue the prepared download. This authorization is one-time and short-lived.</p>");
        return;
      }
      response.writeHead(405, { allow: "GET, POST" });
      response.end();
    } catch (error) {
      const message = error instanceof NexusError ? error.message : "Authorization could not be accepted.";
      html(response, 400, `<h1>Authorization failed</h1><p>${escapeHtml(message)}</p>`);
    }
  }

  async prepare(input: {
    domainName: string;
    modId: number;
    canonicalUrl: string;
    file: NexusModFile;
    isPremium: boolean;
  }): Promise<PreparedDownload> {
    const id = randomUUID();
    const now = Date.now();
    const session: DownloadSession = {
      id,
      domainName: input.domainName,
      modId: input.modId,
      canonicalUrl: input.canonicalUrl,
      file: input.file,
      isPremium: input.isPremium,
      createdAt: now,
      expiresAt: now + 15 * 60_000,
      authorization: undefined,
      state: input.isPremium ? "ready" : "awaiting_authorization"
    };
    this.#sessions.set(id, session);
    const port = input.isPremium ? undefined : await this.#ensureAuthorizationServer();
    return {
      sessionId: id,
      state: session.state,
      mod: { domainName: input.domainName, modId: input.modId, canonicalUrl: input.canonicalUrl },
      file: input.file,
      capability: {
        isPremium: input.isPremium,
        interactiveNxmAuthorizationRequired: !input.isPremium
      },
      nexusFilesUrl: `https://www.nexusmods.com/${input.domainName}/mods/${input.modId}?tab=files&file_id=${input.file.fileId}`,
      authorizationPageUrl: port ? `http://127.0.0.1:${port}/authorize/${id}` : null,
      expiresAt: new Date(session.expiresAt).toISOString()
    };
  }

  status(sessionId: string): Omit<PreparedDownload, "nexusFilesUrl" | "authorizationPageUrl"> {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new NexusError("NOT_FOUND", "Download session was not found.");
    if (session.expiresAt <= Date.now() && session.state !== "completed") {
      session.authorization = undefined;
      throw new NexusError("DOWNLOAD_AUTH_EXPIRED", "Download session expired. Prepare it again.");
    }
    return {
      sessionId,
      state: session.state,
      mod: { domainName: session.domainName, modId: session.modId, canonicalUrl: session.canonicalUrl },
      file: session.file,
      capability: {
        isPremium: session.isPremium,
        interactiveNxmAuthorizationRequired: !session.isPremium
      },
      expiresAt: new Date(session.expiresAt).toISOString()
    };
  }

  async download(sessionId: string, outputDirectory: string): Promise<DownloadReceipt> {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new NexusError("NOT_FOUND", "Download session was not found.");
    if (!path.isAbsolute(outputDirectory)) {
      throw new NexusError("INVALID_INPUT", "outputDirectory must be an absolute path.");
    }
    if (session.expiresAt <= Date.now()) {
      session.authorization = undefined;
      throw new NexusError("DOWNLOAD_AUTH_EXPIRED", "Download session expired. Prepare it again.");
    }
    if (session.state === "awaiting_authorization" || (!session.isPremium && !session.authorization)) {
      throw new NexusError("DOWNLOAD_AUTH_REQUIRED", "Complete the local NXM authorization page before downloading.");
    }
    if (session.state !== "ready") {
      throw new NexusError("INVALID_INPUT", `Download session is ${session.state}, not ready.`);
    }

    const resolvedDirectory = path.resolve(outputDirectory);
    if (path.parse(resolvedDirectory).root === resolvedDirectory) {
      throw new NexusError("INVALID_INPUT", "Refusing to use a filesystem root as outputDirectory.");
    }
    await mkdir(resolvedDirectory, { recursive: true });
    const fileName = safeFileName(session.file.fileName);
    const finalPath = path.join(resolvedDirectory, fileName);
    if (await fileExists(finalPath)) {
      throw new NexusError("OUTPUT_EXISTS", `Output file already exists: ${finalPath}`);
    }

    session.state = "downloading";
    let links;
    try {
      links = await this.#client.getDownloadLinks({
        domainName: session.domainName,
        modId: session.modId,
        fileId: session.file.fileId,
        ...(session.authorization
          ? { key: session.authorization.key, expires: session.authorization.expires }
          : {})
      });
    } finally {
      session.authorization = undefined;
    }
    const downloadUrl = links.links[0]?.uri;
    if (!downloadUrl) {
      session.state = "failed";
      throw new NexusError("DOWNLOAD_FAILED", "Nexus did not return a usable download mirror.");
    }
    const parsedDownloadUrl = new URL(downloadUrl);
    const host = parsedDownloadUrl.hostname.toLowerCase();
    if (parsedDownloadUrl.protocol !== "https:" || (host !== "nexus-cdn.com" && !host.endsWith(".nexus-cdn.com"))) {
      session.state = "failed";
      throw new NexusError("DOWNLOAD_FAILED", "Nexus returned a download host outside the allowed nexus-cdn.com boundary.");
    }

    const tempPath = path.join(resolvedDirectory, `.${fileName}.${randomUUID()}.part`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30 * 60_000);
    let handle;
    let bytes = 0;
    let finalExposed = false;
    const hash = createHash("sha256");
    let archiveCheck: DownloadReceipt["archiveCheck"];
    try {
      handle = await open(tempPath, "wx");
      const response = await fetch(parsedDownloadUrl, { redirect: "follow", signal: controller.signal });
      if (!response.ok || !response.body) {
        throw new NexusError("DOWNLOAD_FAILED", `Nexus CDN returned HTTP ${response.status}.`, {
          status: response.status,
          retryable: response.status >= 500
        });
      }
      const finalResponseUrl = new URL(response.url || parsedDownloadUrl.href);
      const finalHost = finalResponseUrl.hostname.toLowerCase();
      if (
        finalResponseUrl.protocol !== "https:" ||
        (finalHost !== "nexus-cdn.com" && !finalHost.endsWith(".nexus-cdn.com"))
      ) {
        throw new NexusError("DOWNLOAD_FAILED", "Nexus CDN redirected outside the allowed nexus-cdn.com boundary.");
      }
      const reader = response.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!chunk.value) continue;
        hash.update(chunk.value);
        let offset = 0;
        while (offset < chunk.value.byteLength) {
          const writeResult = await handle.write(chunk.value, offset, chunk.value.byteLength - offset);
          if (writeResult.bytesWritten <= 0) {
            throw new NexusError("DOWNLOAD_FAILED", "The output file stopped accepting download bytes.");
          }
          offset += writeResult.bytesWritten;
        }
        bytes += chunk.value.byteLength;
      }
      await handle.sync();
      await handle.close();
      handle = undefined;

      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > 0 && bytes !== contentLength) {
        throw new NexusError("DOWNLOAD_FAILED", `Downloaded ${bytes} bytes but HTTP declared ${contentLength}.`);
      }
      if (session.file.sizeInBytes !== null && session.file.sizeInBytes > 0 && bytes !== session.file.sizeInBytes) {
        throw new NexusError(
          "DOWNLOAD_FAILED",
          `Downloaded ${bytes} bytes but Nexus file metadata declares ${session.file.sizeInBytes}.`
        );
      }
      archiveCheck = await inspectArchive(tempPath, fileName, bytes);
      if (archiveCheck.valid === false) {
        throw new NexusError("DOWNLOAD_FAILED", archiveCheck.detail);
      }
      await link(tempPath, finalPath);
      finalExposed = true;
      await unlink(tempPath);
      const completedAt = new Date().toISOString();
      const receiptPath = `${finalPath}.nexus-receipt.json`;
      const receipt: DownloadReceipt = {
        canonicalModUrl: session.canonicalUrl,
        domainName: session.domainName,
        modId: session.modId,
        fileId: session.file.fileId,
        fileName,
        bytes,
        sha256: hash.digest("hex"),
        completedAt,
        targetPath: finalPath,
        receiptPath,
        archiveCheck
      };
      try {
        await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        await rm(finalPath, { force: true });
        throw new NexusError("DOWNLOAD_FAILED", "Downloaded archive was removed because its receipt could not be written.", {
          cause: error
        });
      }
      session.state = "completed";
      return receipt;
    } catch (error) {
      session.state = "failed";
      if (handle) await handle.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
      if (finalExposed) await rm(finalPath, { force: true }).catch(() => undefined);
      if (error instanceof NexusError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new NexusError("DOWNLOAD_FAILED", "Nexus download timed out.", { retryable: true, cause: error });
      }
      throw new NexusError("DOWNLOAD_FAILED", "Nexus download failed before completion.", {
        retryable: true,
        cause: error
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async close(): Promise<void> {
    for (const session of this.#sessions.values()) session.authorization = undefined;
    this.#sessions.clear();
    if (!this.#server) return;
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
    this.#server = undefined;
    this.#port = undefined;
  }
}
