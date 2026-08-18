import { NexusError } from "../../errors.js";

export interface ParsedSpeedrunResource {
  resourceUrl: string;
  resourceId: string | null;
  title: string;
  author: string | null;
  manager: string | null;
  updatedText: string | null;
  summary: string;
  downloadUrl: string | null;
  downloadFileName: string | null;
}

function decodeHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, value: string) =>
      String.fromCodePoint(Number(value)),
    )
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function anchors(html: string, baseUrl: string): Array<{ href: string; text: string }> {
  const result: Array<{ href: string; text: string }> = [];
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = absoluteUrl(match[1] ?? "", baseUrl);
    const text = decodeHtml(match[2] ?? "");
    if (href && text) result.push({ href, text });
  }
  return result;
}

function resourceIdentity(resourceUrl: string, gameSlug: string): string | null {
  const url = new URL(resourceUrl);
  const match = url.pathname.match(
    new RegExp(`^/${gameSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/resources/([^/?#]+)$`, "i"),
  );
  return match?.[1] ?? null;
}

function sectionHtml(html: string, title: string): string | null {
  const headings = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)];
  const targetIndex = headings.findIndex((match) => decodeHtml(match[2] ?? "").toLowerCase() === title.toLowerCase());
  if (targetIndex < 0) return null;
  const target = headings[targetIndex];
  if (!target || target.index === undefined) return null;
  const start = target.index + target[0].length;
  const next = headings.slice(targetIndex + 1).find((match) =>
    /^(tools|splits|saves|patches|game stats)$/i.test(decodeHtml(match[2] ?? "")),
  );
  return html.slice(start, next?.index ?? html.length);
}

export function parseSpeedrunResourceDetail(input: {
  html: string;
  resourceUrl: string;
  fallbackTitle: string;
}): Omit<ParsedSpeedrunResource, "resourceId"> {
  const text = decodeHtml(input.html);
  const titleMatch = text.match(/(?:^|\s)Save:\s*([^|]{1,500}?)(?:\s+Resources\s+\/|\s+Updated\s+)/i);
  const title = titleMatch?.[1]?.trim() || input.fallbackTitle;
  const updated = text.match(/Updated\s+(.{1,100}?)\s+by\s+([^\s|]{1,200})/i);
  const download = anchors(input.html, input.resourceUrl).find((anchor) =>
    /^download\b/i.test(anchor.text),
  );
  const summaryMatch = text.match(
    /Updated\s+.{1,100}?\s+by\s+[^\s|]{1,200}\s+(.{1,4000}?)(?:\s+Download\b|\s+Game stats\b)/i,
  );
  return {
    resourceUrl: input.resourceUrl,
    title,
    author: updated?.[2]?.trim() ?? null,
    manager: updated?.[2]?.trim() ?? null,
    updatedText: updated?.[1]?.trim() ?? null,
    summary: summaryMatch?.[1]?.trim() ?? "",
    downloadUrl: download?.href ?? null,
    downloadFileName: download
      ? download.text.replace(/^download\s*/i, "").trim() || null
      : null,
  };
}

export function parseSpeedrunResourcesPage(input: {
  html: string;
  pageUrl: string;
  detailPages?: Readonly<Record<string, string>>;
}): { gameSlug: string; noSaves: boolean; resources: ParsedSpeedrunResource[] } {
  let page: URL;
  try {
    page = new URL(input.pageUrl);
  } catch (error) {
    throw new NexusError("SAVE_CONTRACT_INVALID", "Speedrun Resources URL is invalid.", { cause: error });
  }
  if (
    page.protocol !== "https:" ||
    page.hostname.toLowerCase() !== "www.speedrun.com" ||
    !/^\/[a-z0-9_-]+\/resources\/?$/i.test(page.pathname)
  ) {
    throw new NexusError(
      "SAVE_CONTRACT_INVALID",
      "Speedrun source must be a canonical https://www.speedrun.com/<game>/resources page.",
    );
  }
  const gameSlug = page.pathname.split("/").filter(Boolean)[0]!;
  const saves = sectionHtml(input.html, "Saves");
  if (saves === null) {
    throw new NexusError(
      "UPSTREAM_SCHEMA_CHANGED",
      "Speedrun Resources page did not expose a recognizable Saves section.",
    );
  }
  const sectionText = decodeHtml(saves);
  if (/^no saves(?:\s|$)/i.test(sectionText)) {
    return { gameSlug, noSaves: true, resources: [] };
  }
  const found = new Map<string, ParsedSpeedrunResource>();
  for (const anchor of anchors(saves, page.href)) {
    const resourceId = resourceIdentity(anchor.href, gameSlug);
    if (!resourceId || found.has(anchor.href)) continue;
    const detailHtml = input.detailPages?.[anchor.href];
    const detail = detailHtml
      ? parseSpeedrunResourceDetail({
          html: detailHtml,
          resourceUrl: anchor.href,
          fallbackTitle: anchor.text,
        })
      : {
          resourceUrl: anchor.href,
          title: anchor.text,
          author: null,
          manager: null,
          updatedText: null,
          summary: "",
          downloadUrl: null,
          downloadFileName: null,
        };
    found.set(anchor.href, { ...detail, resourceId });
  }
  if (found.size === 0) {
    throw new NexusError(
      "UPSTREAM_SCHEMA_CHANGED",
      "Speedrun Saves section was present but no canonical save resources were parsed.",
    );
  }
  return { gameSlug, noSaves: false, resources: [...found.values()] };
}
