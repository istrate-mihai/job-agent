// src/ingest/sources/webBoard.ts
// Public job-board listing pages (Juniors.ro, Hipo.ro, …): discovers postings, `enrich` fills descriptions later.
// - Honors robots.txt, fetches only the configured listing URLs, sequentially and spaced out.
// - Fast path: schema.org JobPosting JSON-LD on the listing page (no LLM).
// - Fallback: anchors matching `linkPattern` + page text → the same LLM extractor as alert emails,
//   and only for links not already stored, so an unchanged page costs zero tokens.
import { and, eq, inArray } from "drizzle-orm";
import { parse, type HTMLElement } from "node-html-parser";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { SearchConfig } from "../../config/searchConfig.js";
import { db } from "../../db/client.js";
import { postings } from "../../db/schema.js";
import { extractJobs } from "../gmail/extract.js";
import { extractLinks, type PageLink } from "../html/links.js";
import { isAllowed, parseRobots, type RobotsRules } from "../html/robots.js";
import { htmlToText, inferWorkMode, parseDate } from "../text.js";
import type { JobSource, NormalizedPosting, WorkMode } from "../types.js";

type BoardConfig = SearchConfig["sources"]["boards"][number];

const PAGE_DELAY_MS = 2_000; // politeness: one page every 2s per board
const MAX_LINKS_PER_PAGE = 120;
// Browser-like headers: several boards serve an empty shell or 403 to non-browser clients
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 job-agent/0.1",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "ro-RO,ro;q=0.9,en;q=0.8",
};

const PlaceSchema = z
  .object({
    address: z
      .union([
        z.string(),
        z.object({ addressLocality: z.string().nullish(), addressRegion: z.string().nullish(), addressCountry: z.unknown() }).partial(),
      ])
      .nullish(),
  })
  .partial();

const JobPostingLd = z.object({
  "@type": z.union([z.string(), z.array(z.string())]),
  title: z.string().min(2),
  url: z.string().nullish(),
  hiringOrganization: z.union([z.string(), z.object({ name: z.string().nullish() }).partial()]).nullish(),
  jobLocation: z.union([PlaceSchema, z.array(PlaceSchema)]).nullish(),
  jobLocationType: z.string().nullish(),
  datePosted: z.string().nullish(),
  validThrough: z.string().nullish(),
  description: z.string().nullish(),
});
type JobPostingLd = z.infer<typeof JobPostingLd>;

export interface ListingPage {
  title: string;
  text: string;
  jsonLd: JobPostingLd[];
  links: PageLink[];
}

const isJobPosting = (t: JobPostingLd["@type"]): boolean => (Array.isArray(t) ? t.includes("JobPosting") : t === "JobPosting");

function collectJsonLd(root: HTMLElement): JobPostingLd[] {
  const found: JobPostingLd[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if ("@graph" in obj) visit(obj["@graph"]);
    if ("itemListElement" in obj) visit(obj["itemListElement"]);
    if ("item" in obj) visit(obj["item"]); // ItemList → ListItem → item
    const parsed = JobPostingLd.safeParse(obj);
    if (parsed.success && isJobPosting(parsed.data["@type"])) found.push(parsed.data);
  };
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      visit(JSON.parse(script.text));
    } catch {
      // malformed JSON-LD block: ignore
    }
  }
  return found;
}

/** Pure: HTML → what the source needs. Exported for tests. */
export function parseListingPage(html: string, pageUrl: string, linkPattern: RegExp): ListingPage {
  const root = parse(html);
  const jsonLd = collectJsonLd(root);
  const title = root.querySelector("title")?.text.trim() ?? pageUrl;
  root.querySelectorAll("script, style, noscript, svg, header, footer, nav").forEach((n) => n.remove());
  const cleaned = root.toString();
  return {
    title,
    text: htmlToText(cleaned),
    jsonLd,
    links: extractLinks(cleaned, { baseUrl: pageUrl, include: linkPattern, max: MAX_LINKS_PER_PAGE }),
  };
}

function ldCompany(p: JobPostingLd): string {
  const org = p.hiringOrganization;
  return (typeof org === "string" ? org : org?.name ?? "").trim();
}

function ldLocation(p: JobPostingLd): string {
  const places = Array.isArray(p.jobLocation) ? p.jobLocation : p.jobLocation ? [p.jobLocation] : [];
  return [
    ...new Set(
      places
        .map((pl) => (typeof pl.address === "string" ? pl.address : [pl.address?.addressLocality, pl.address?.addressRegion].filter(Boolean).join(", ")))
        .filter((s) => s.length > 0),
    ),
  ].join("; ");
}

/** Pure: JSON-LD postings → normalized rows. Exported for tests. */
export function postingsFromJsonLd(board: string, pageUrl: string, items: JobPostingLd[], now: Date): NormalizedPosting[] {
  const out: NormalizedPosting[] = [];
  for (const p of items) {
    const company = ldCompany(p);
    if (!p.url || company === "") continue; // without both, the row can't be deduped or applied to
    if (p.validThrough && Date.parse(p.validThrough) < now.getTime()) continue;
    const url = new URL(p.url, pageUrl).toString();
    const location = ldLocation(p);
    const remote = p.jobLocationType?.toUpperCase() === "TELECOMMUTE";
    const description = htmlToText(p.description ?? "");
    const workMode: WorkMode = remote ? "remote" : inferWorkMode(location, p.title, description.slice(0, 2000));
    out.push({
      source: `board:${board}`,
      sourceId: url,
      company,
      title: p.title.trim(),
      url,
      locationText: location,
      workMode,
      remoteScope: remote ? location || null : null,
      description,
      postedAt: parseDate(p.datePosted),
      raw: { via: "json-ld", page: pageUrl },
    });
  }
  return out;
}

async function loadRobots(origin: string, signal: AbortSignal): Promise<RobotsRules> {
  const res = await fetch(`${origin}/robots.txt`, { headers: HEADERS, signal });
  if (res.status === 404 || res.status === 410) return { allow: [], disallow: [] }; // no robots.txt = no restrictions
  if (!res.ok) throw new Error(`robots.txt ${origin} → HTTP ${res.status}; skipping board to be safe`);
  return parseRobots(await res.text());
}

async function knownSourceIds(source: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ sourceId: postings.sourceId })
    .from(postings)
    .where(and(eq(postings.source, source), inArray(postings.sourceId, ids)));
  return new Set(rows.map((r) => r.sourceId));
}

export function webBoardSource(board: BoardConfig, config: SearchConfig): JobSource {
  const linkPattern = new RegExp(board.linkPattern, "i");
  const source = `board:${board.name}`;

  return {
    name: source,
    timeoutMs: 300_000, // LLM fallback per page, plus possible 429 waits on free tiers
    async fetch(signal): Promise<NormalizedPosting[]> {
      const robotsByOrigin = new Map<string, RobotsRules>();
      const results = new Map<string, NormalizedPosting>();
      const now = new Date();

      for (const [i, pageUrl] of board.urls.entries()) {
        if (i > 0) await sleep(PAGE_DELAY_MS, undefined, { signal });
        const url = new URL(pageUrl);
        let robots = robotsByOrigin.get(url.origin);
        if (!robots) {
          robots = await loadRobots(url.origin, signal);
          robotsByOrigin.set(url.origin, robots);
        }
        if (!isAllowed(robots, `${url.pathname}${url.search}`)) {
          console.warn(`[${source}] robots.txt disallows ${pageUrl}; skipped`);
          continue;
        }

        const res = await fetch(pageUrl, { headers: HEADERS, redirect: "follow", signal });
        if (res.status === 429) {
          console.warn(`[${source}] rate-limited (HTTP 429); stopping this board for this run`);
          break;
        }
        if (!res.ok) throw new Error(`GET ${pageUrl} → HTTP ${res.status}`);
        const page = parseListingPage(await res.text(), res.url || pageUrl, linkPattern);

        if (board.extract !== "llm") {
          const fromLd = postingsFromJsonLd(board.name, pageUrl, page.jsonLd, now);
          if (fromLd.length > 0 || board.extract === "json-ld") {
            fromLd.forEach((p) => results.set(p.sourceId, p));
            console.log(`[${source}] ${pageUrl} → ${fromLd.length} jobs (json-ld)`);
            continue;
          }
        }

        if (page.links.length === 0) {
          console.warn(`[${source}] ${pageUrl}: no links match linkPattern; page may be JS-rendered or the pattern is stale`);
          continue;
        }
        const known = await knownSourceIds(source, page.links.map((l) => l.href));
        const fresh = page.links.filter((l) => !known.has(l.href) && !results.has(l.href));
        if (fresh.length === 0) {
          console.log(`[${source}] ${pageUrl} → nothing new (${page.links.length} known)`);
          continue;
        }

        // ⚠ Security: page text is untrusted; the extractor returns JSON only and can pick only from `fresh` links
        const jobs = await extractJobs({ kind: "page", from: pageUrl, subject: page.title, text: page.text, links: fresh }, config, signal);
        for (const job of jobs) {
          results.set(job.url, {
            source,
            sourceId: job.url,
            company: job.company,
            title: job.title,
            url: job.url,
            locationText: job.location,
            workMode: job.workMode,
            remoteScope: null,
            description: "", // filled by `npm run enrich` from the posting page
            postedAt: null, // listing pages rarely carry a parseable date; flagged posted-date-unknown
            raw: { via: "llm", page: pageUrl, route: job.route },
          });
        }
        console.log(`[${source}] ${pageUrl} → ${jobs.length} jobs from ${fresh.length} new links (llm)`);
      }
      return [...results.values()];
    },
  };
}
