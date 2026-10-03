// src/ingest/html/links.ts
// Anchor extraction shared by alert emails and job-board listing pages.
import { decodeEntities, htmlToText } from "../text.js";

export interface PageLink {
  href: string;
  text: string;
}

const DEFAULT_MAX_LINKS = 200;
const SKIP_LINK_RE = /unsubscribe|dezabonare|preferences|settings|privacy|help|support|\/legal|facebook\.com|twitter\.com|x\.com\/|instagram\.com|youtube\.com|apps\.apple\.com|play\.google\.com/i;

/**
 * Absolute http(s) links with their anchor text, deduplicated by href (most descriptive text wins).
 * `baseUrl` resolves relative hrefs (listing pages); without it only absolute links are kept (emails).
 */
export function extractLinks(html: string, opts: { baseUrl?: string; include?: RegExp; max?: number } = {}): PageLink[] {
  const max = opts.max ?? DEFAULT_MAX_LINKS;
  const links = new Map<string, PageLink>();
  const anchorRe = /<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorRe)) {
    const raw = decodeEntities(match[1] ?? "").trim();
    let href: string;
    try {
      href = new URL(raw, opts.baseUrl).toString(); // throws on relative hrefs when there is no base
    } catch {
      continue;
    }
    const text = htmlToText(match[2] ?? "").replace(/\s+/g, " ").trim();
    if (!/^https?:\/\//i.test(href) || text.length < 2 || SKIP_LINK_RE.test(href)) continue;
    if (opts.include && !opts.include.test(href)) continue;
    const existing = links.get(href);
    if (!existing || text.length > existing.text.length) links.set(href, { href, text });
    if (links.size >= max) break;
  }
  return [...links.values()];
}
