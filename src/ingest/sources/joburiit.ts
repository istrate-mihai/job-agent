// src/ingest/sources/joburiit.ts
// JoburiIT.ro (Romanian IT-only board). Its listing page renders with JavaScript, but the site is WordPress
// and publishes its "jobs-vacancies" post type on the public REST API (robots.txt only disallows /wp-admin/).
// - Listing: /wp-json/wp/v2/jobs-vacancies (id, link, title, date, location/category term ids). No LLM.
// - The REST body carries neither the employer nor the description, so each NEW posting's page is fetched once:
//   company from "<Role> – <Company> | JoburiIT.ro" in <title>, description from the page body.
// - Known postings cost one listing request per run; new ones are fetched sequentially and spaced out.
import { and, eq, inArray } from "drizzle-orm";
import { parse } from "node-html-parser";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { SearchConfig } from "../../config/searchConfig.js";
import { isAllowed, parseRobots, type RobotsRules } from "../html/robots.js";
import { decodeEntities, htmlToText, inferWorkMode, parseDate } from "../text.js";
import type { JobSource, NormalizedPosting, WorkMode } from "../types.js";

type JoburiItConfig = SearchConfig["sources"]["joburiit"];

const SOURCE = "joburiit";
const ORIGIN = "https://joburiit.ro";
const API = `${ORIGIN}/wp-json/wp/v2`;
const PER_PAGE = 100; // WP REST maximum
const MAX_LIST_PAGES = 5; // ⚡ Perf: the board has ~35 active jobs; 500 is a safety ceiling, not a target
const DETAIL_DELAY_MS = 1_500; // politeness: one posting page every 1.5s
const SITE_SUFFIX_RE = /\s*\|\s*JoburiIT(?:\.ro)?\s*$/i;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 job-agent/0.1",
  "Accept-Language": "ro-RO,ro;q=0.9,en;q=0.8",
};

const TermSchema = z.object({ id: z.number().int(), name: z.string(), slug: z.string() });
const TermListSchema = z.array(TermSchema);

const VacancySchema = z.object({
  id: z.number().int(),
  link: z.url(),
  date_gmt: z.string().nullish(),
  title: z.object({ rendered: z.string() }),
  "vacancy-location": z.array(z.number().int()).default([]),
  "vacancy-category": z.array(z.number().int()).default([]),
});
export type Vacancy = z.infer<typeof VacancySchema>;
const VacancyListSchema = z.array(VacancySchema);

export interface VacancyPage {
  company: string;
  description: string;
}

export interface JoburiItDeps {
  /** sourceIds already stored for this source; injected so tests don't need a database. */
  knownIds(ids: string[]): Promise<Set<string>>;
}

/** Pure: a posting page → employer + plain-text description. Exported for tests. */
export function parseVacancyPage(html: string, title: string): VacancyPage {
  const root = parse(html);
  const pageTitle = decodeEntities(root.querySelector("title")?.text ?? "").replace(SITE_SUFFIX_RE, "").trim();
  // "<Role> – <Company>": split on the LAST dash separator, since role titles can contain " – " themselves
  const sep = /\s+[–—-]\s+(?!.*\s[–—-]\s)/.exec(pageTitle);
  const company = sep && pageTitle.slice(0, sep.index).trim().length > 0 ? pageTitle.slice(sep.index + sep[0].length).trim() : "";

  root.querySelectorAll("script, style, noscript, svg, form, nav, header, footer, aside").forEach((n) => n.remove());
  const body = root.querySelector("main") ?? root.querySelector("article") ?? root.querySelector("body") ?? root;
  const text = htmlToText(body.innerHTML);
  // Elementor wraps the page in site chrome; the posting itself starts at its own heading
  const start = text.indexOf(title);
  return { company, description: (start >= 0 ? text.slice(start) : text).trim() };
}

/** Pure: REST row + resolved terms + page data → normalized posting. Exported for tests. */
export function toPosting(v: Vacancy, locations: ReadonlyMap<number, string>, page: VacancyPage): NormalizedPosting {
  const title = htmlToText(v.title.rendered);
  const places = v["vacancy-location"].map((id) => locations.get(id)).filter((n): n is string => n !== undefined);
  const remoteTagged = places.some((p) => /^remote$/i.test(p.trim()));
  const locationText = places.join("; ");
  const workMode: WorkMode = inferWorkMode(locationText, title, page.description.slice(0, 3000));
  return {
    source: SOURCE,
    sourceId: String(v.id),
    company: page.company,
    title,
    url: v.link,
    locationText,
    workMode: workMode === "unknown" && remoteTagged ? "remote" : workMode,
    // Romanian-only board: a "Remote" tag means remote within Romania unless the description narrows it
    remoteScope: remoteTagged ? "Romania" : null,
    description: page.description,
    postedAt: parseDate(v.date_gmt ? `${v.date_gmt}Z` : null), // date_gmt has no zone suffix
    raw: { via: "wp-rest", id: v.id, categories: v["vacancy-category"] },
  };
}

async function getJson(url: string, signal: AbortSignal): Promise<{ body: unknown; totalPages: number }> {
  const res = await fetch(url, { headers: { ...HEADERS, Accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return { body: await res.json(), totalPages: Number(res.headers.get("x-wp-totalpages") ?? "1") || 1 };
}

async function loadRobots(signal: AbortSignal): Promise<RobotsRules> {
  const res = await fetch(`${ORIGIN}/robots.txt`, { headers: HEADERS, signal });
  if (res.status === 404 || res.status === 410) return { allow: [], disallow: [] };
  if (!res.ok) throw new Error(`robots.txt ${ORIGIN} → HTTP ${res.status}; skipping source to be safe`);
  return parseRobots(await res.text());
}

async function terms(taxonomy: string, signal: AbortSignal): Promise<z.infer<typeof TermListSchema>> {
  const { body } = await getJson(`${API}/${taxonomy}?per_page=${PER_PAGE}&_fields=id,name,slug`, signal);
  return TermListSchema.parse(body);
}

async function listVacancies(categoryIds: number[], signal: AbortSignal): Promise<Vacancy[]> {
  const fields = "id,link,date_gmt,title,vacancy-location,vacancy-category";
  const filter = categoryIds.length > 0 ? `&vacancy-category=${categoryIds.join(",")}` : "";
  const out: Vacancy[] = [];
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const url = `${API}/jobs-vacancies?per_page=${PER_PAGE}&page=${page}&orderby=date&order=desc&_fields=${fields}${filter}`;
    const { body, totalPages } = await getJson(url, signal);
    out.push(...VacancyListSchema.parse(body));
    if (page >= totalPages) break;
  }
  return out;
}

async function dbKnownIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const [{ db }, { postings }] = await Promise.all([import("../../db/client.js"), import("../../db/schema.js")]);
  const rows = await db
    .select({ sourceId: postings.sourceId })
    .from(postings)
    .where(and(eq(postings.source, SOURCE), inArray(postings.sourceId, ids)));
  return new Set(rows.map((r) => r.sourceId));
}

export function joburiItSource(cfg: JoburiItConfig, deps: JoburiItDeps = { knownIds: dbKnownIds }): JobSource {
  return {
    name: SOURCE,
    timeoutMs: 180_000, // first run fetches up to maxNewPerRun posting pages, 1.5s apart
    async fetch(signal): Promise<NormalizedPosting[]> {
      const robots = await loadRobots(signal);
      for (const path of ["/wp-json/wp/v2/jobs-vacancies", "/jobs-vacancies/"]) {
        if (!isAllowed(robots, path)) {
          console.warn(`[${SOURCE}] robots.txt disallows ${path}; skipped`);
          return [];
        }
      }

      const [locationTerms, categoryTerms] = await Promise.all([
        terms("vacancy-location", signal),
        cfg.categories.length > 0 ? terms("vacancy-category", signal) : Promise.resolve([]),
      ]);
      const locations = new Map(locationTerms.map((t) => [t.id, t.name]));
      const categoryIds = categoryTerms.filter((t) => cfg.categories.includes(t.slug)).map((t) => t.id);
      if (cfg.categories.length > 0 && categoryIds.length === 0) {
        console.warn(`[${SOURCE}] none of the configured categories exist (${cfg.categories.join(", ")}); fetching all`);
      }

      const vacancies = await listVacancies(categoryIds, signal);
      const known = await deps.knownIds(vacancies.map((v) => String(v.id)));
      const fresh = vacancies.filter((v) => !known.has(String(v.id)));
      // Postings over the cap stay unstored, so the next run picks them up as new
      const batch = fresh.slice(0, cfg.maxNewPerRun);

      const out: NormalizedPosting[] = [];
      for (const [i, v] of batch.entries()) {
        if (i > 0) await sleep(DETAIL_DELAY_MS, undefined, { signal });
        const res = await fetch(v.link, { headers: { ...HEADERS, Accept: "text/html,application/xhtml+xml" }, redirect: "follow", signal });
        if (res.status === 429) {
          console.warn(`[${SOURCE}] rate-limited (HTTP 429); remaining postings wait for the next run`);
          break;
        }
        if (!res.ok) {
          console.warn(`[${SOURCE}] ${v.link} → HTTP ${res.status}; skipped`);
          continue;
        }
        // ⚠ Security: page HTML is untrusted; only plain text leaves this function (never rendered as HTML)
        const page = parseVacancyPage(await res.text(), htmlToText(v.title.rendered));
        if (page.company === "") {
          console.warn(`[${SOURCE}] no employer in page title for ${v.link}; skipped`);
          continue;
        }
        out.push(toPosting(v, locations, page));
      }
      const deferred = fresh.length - batch.length;
      console.log(`[${SOURCE}] ${vacancies.length} listed, ${known.size} known, ${out.length} new${deferred > 0 ? `, ${deferred} deferred` : ""}`);
      return out;
    },
  };
}
