// src/ingest/sources/remotive.ts
import { z } from "zod";
import { fetchJson } from "../http.js";
import { htmlToText, parseDate } from "../text.js";
import type { JobSource, NormalizedPosting } from "../types.js";

const RemotiveJobSchema = z.object({
  id: z.number(),
  url: z.url(),
  title: z.string(),
  company_name: z.string(),
  publication_date: z.string(),
  candidate_required_location: z.string(),
  description: z.string(),
});

const RemotiveResponseSchema = z.object({ jobs: z.array(RemotiveJobSchema) });

// ⚠ Respect Remotive's API terms: attribution + low request frequency (2 runs/day is fine)
export function remotiveSource(categories: readonly string[]): JobSource {
  return {
    name: "remotive",
    async fetch(signal): Promise<NormalizedPosting[]> {
      const results: NormalizedPosting[] = [];
      for (const category of categories) {
        const url = `https://remotive.com/api/remote-jobs?category=${encodeURIComponent(category)}`;
        const { jobs } = RemotiveResponseSchema.parse(await fetchJson(url, signal));
        for (const job of jobs) {
          results.push({
            source: "remotive",
            sourceId: String(job.id),
            company: job.company_name.trim(),
            title: job.title.trim(),
            url: job.url,
            locationText: job.candidate_required_location,
            workMode: "remote",
            remoteScope: job.candidate_required_location,
            description: htmlToText(job.description),
            postedAt: parseDate(job.publication_date),
            raw: job,
          });
        }
      }
      return results;
    },
  };
}
