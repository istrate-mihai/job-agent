// src/ingest/sources/smartrecruiters.ts
// Public SmartRecruiters Posting API (used by Endava and many other employers in Romania).
// The list call has no description, so details are fetched only for new postings whose title matches.
import { and, eq, inArray } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { SearchConfig } from "../../config/searchConfig.js";
import { db } from "../../db/client.js";
import { postings } from "../../db/schema.js";
import { fetchJson } from "../http.js";
import { hasTerm, htmlToText, inferWorkMode, normalizeText, parseDate } from "../text.js";
import type { JobSource, NormalizedPosting, WorkMode } from "../types.js";

const API = "https://api.smartrecruiters.com/v1/companies";
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const DETAIL_DELAY_MS = 250; // ⚡ Perf/politeness: sequential detail calls, spaced out

const LocationSchema = z
  .object({
    city: z.string().nullish(),
    region: z.string().nullish(),
    country: z.string().nullish(),
    remote: z.boolean().nullish(),
    hybrid: z.boolean().nullish(),
    fullLocation: z.string().nullish(),
  })
  .nullish();

const ListSchema = z.object({
  totalFound: z.number().optional(),
  content: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      releasedDate: z.string().nullish(),
      location: LocationSchema,
    }),
  ),
});

const SectionSchema = z.object({ title: z.string().nullish(), text: z.string().nullish() }).nullish();
const DetailSchema = z.object({
  applyUrl: z.string().nullish(),
  postingUrl: z.string().nullish(),
  jobAd: z
    .object({
      sections: z
        .object({
          jobDescription: SectionSchema,
          qualifications: SectionSchema,
          additionalInformation: SectionSchema,
        })
        .partial()
        .nullish(),
    })
    .nullish(),
});

type ListItem = z.infer<typeof ListSchema>["content"][number];

function locationText(loc: ListItem["location"]): string {
  if (!loc) return "";
  if (loc.fullLocation) return loc.fullLocation;
  return [loc.city, loc.region, loc.country?.toUpperCase() === "RO" ? "Romania" : loc.country].filter(Boolean).join(", ");
}

function workModeOf(loc: ListItem["location"], text: string): WorkMode {
  if (loc?.remote) return "remote";
  if (loc?.hybrid) return "hybrid";
  const inferred = inferWorkMode(text);
  return inferred === "unknown" ? "onsite" : inferred; // SmartRecruiters flags remote/hybrid explicitly
}

export function smartRecruitersSource(
  company: string,
  companyId: string,
  country: string | null,
  titles: SearchConfig["titles"],
): JobSource {
  const titleMatches = (title: string): boolean => {
    const t = normalizeText(title);
    return titles.include.some((term) => hasTerm(t, term)) && !titles.exclude.some((term) => hasTerm(t, term));
  };

  return {
    name: `smartrecruiters:${companyId}`,
    timeoutMs: 120_000,
    async fetch(signal): Promise<NormalizedPosting[]> {
      const items: ListItem[] = [];
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
        if (country) params.set("country", country);
        const data = ListSchema.parse(await fetchJson(`${API}/${encodeURIComponent(companyId)}/postings?${params}`, signal));
        items.push(...data.content);
        if (data.content.length < PAGE_SIZE) break;
      }

      // Title pre-filter + skip postings already stored: avoids one detail request per posting per run
      const candidates = items.filter((i) => titleMatches(i.name));
      const sourceIds = candidates.map((i) => `${companyId}:${i.id}`);
      const known =
        sourceIds.length === 0
          ? []
          : await db
              .select({ sourceId: postings.sourceId })
              .from(postings)
              .where(and(eq(postings.source, "smartrecruiters"), inArray(postings.sourceId, sourceIds)));
      const knownIds = new Set(known.map((k) => k.sourceId));

      const results: NormalizedPosting[] = [];
      for (const item of candidates) {
        const sourceId = `${companyId}:${item.id}`;
        if (knownIds.has(sourceId)) continue;
        const detail = DetailSchema.parse(await fetchJson(`${API}/${encodeURIComponent(companyId)}/postings/${encodeURIComponent(item.id)}`, signal));
        const sections = detail.jobAd?.sections;
        const description = [sections?.jobDescription, sections?.qualifications, sections?.additionalInformation]
          .filter((s) => s?.text)
          .map((s) => `${s?.title ?? ""}\n${htmlToText(s?.text ?? "")}`.trim())
          .join("\n\n");
        const loc = locationText(item.location);
        results.push({
          source: "smartrecruiters",
          sourceId,
          company,
          title: item.name.trim(),
          url: detail.postingUrl ?? `https://jobs.smartrecruiters.com/${encodeURIComponent(companyId)}/${encodeURIComponent(item.id)}`,
          locationText: loc,
          workMode: workModeOf(item.location, `${loc} ${item.name}`),
          remoteScope: item.location?.remote ? loc || null : null,
          description,
          postedAt: parseDate(item.releasedDate),
          raw: { list: item, applyUrl: detail.applyUrl ?? null },
        });
        await sleep(DETAIL_DELAY_MS, undefined, { signal });
      }
      return results;
    },
  };
}
