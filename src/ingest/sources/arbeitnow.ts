// src/ingest/sources/arbeitnow.ts
// Arbeitnow public job board API (no key): https://www.arbeitnow.com/api/job-board-api
// ⚠ Terms: free public API, "please do not abuse", link back to the posting (we keep its url).
// Mostly German/EU employers; remote-only by default, the location filter then keeps EU/Romania scopes.
import { z } from "zod";
import { fetchJson } from "../http.js";
import { htmlToText } from "../text.js";
import type { JobSource, NormalizedPosting } from "../types.js";

const ArbeitnowJobSchema = z.object({
  slug: z.string().min(1),
  company_name: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullish(),
  remote: z.boolean(),
  url: z.url(),
  tags: z.array(z.string()).default([]),
  location: z.string().nullish(),
  created_at: z.number().nullish(), // unix seconds
});

const ArbeitnowResponseSchema = z.object({
  data: z.array(ArbeitnowJobSchema),
  links: z.object({ next: z.string().nullish() }).partial().default({}),
});

export interface ArbeitnowOptions {
  remoteOnly: boolean;
  pages: number; // 300 postings per page, newest first
}

export function arbeitnowSource(options: ArbeitnowOptions): JobSource {
  return {
    name: "arbeitnow",
    async fetch(signal): Promise<NormalizedPosting[]> {
      const results: NormalizedPosting[] = [];
      for (let page = 1; page <= options.pages; page += 1) {
        const url = `https://www.arbeitnow.com/api/job-board-api?page=${page}`;
        const { data, links } = ArbeitnowResponseSchema.parse(await fetchJson(url, signal));
        for (const job of data) {
          if (options.remoteOnly && !job.remote) continue;
          const location = job.location?.trim() ?? "";
          results.push({
            source: "arbeitnow",
            sourceId: job.slug,
            company: job.company_name.trim(),
            title: htmlToText(job.title),
            url: job.url,
            locationText: job.remote ? `Remote; ${location}`.replace(/; $/, "") : location,
            workMode: job.remote ? "remote" : "unknown",
            remoteScope: job.remote ? location || null : null, // a city/country here usually means "remote within that country"
            description: htmlToText(job.description ?? ""),
            postedAt: job.created_at ? new Date(job.created_at * 1000) : null,
            raw: job,
          });
        }
        if (!links.next) break;
      }
      return results;
    },
  };
}
