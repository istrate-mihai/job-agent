// src/ingest/sources/jobicy.ts
// Remote jobs filtered by geographic eligibility (e.g. "romania", "europe").
// ⚠ Jobicy terms: keep the canonical Jobicy url and do not poll more than once per hour.
import { z } from "zod";
import { fetchJson } from "../http.js";
import { htmlToText, parseDate } from "../text.js";
import type { JobSource, NormalizedPosting } from "../types.js";

const JobicyJobSchema = z.object({
  id: z.union([z.number(), z.string()]),
  url: z.url(),
  jobTitle: z.string(),
  companyName: z.string(),
  jobGeo: z.string().nullish(),
  jobLevel: z.string().nullish(),
  jobDescription: z.string().nullish(),
  jobExcerpt: z.string().nullish(),
  pubDate: z.string().nullish(),
});

const JobicyResponseSchema = z.object({ jobs: z.array(JobicyJobSchema).default([]) });

export function jobicySource(geos: readonly string[], count: number): JobSource {
  return {
    name: "jobicy",
    async fetch(signal): Promise<NormalizedPosting[]> {
      const byId = new Map<string, NormalizedPosting>();
      for (const geo of geos) {
        const url = `https://jobicy.com/api/v2/remote-jobs?count=${count}&geo=${encodeURIComponent(geo)}`;
        const { jobs } = JobicyResponseSchema.parse(await fetchJson(url, signal));
        for (const job of jobs) {
          const id = String(job.id);
          if (byId.has(id)) continue; // same job listed under several geos
          const scope = job.jobGeo?.trim() || geo;
          byId.set(id, {
            source: "jobicy",
            sourceId: id,
            company: job.companyName.trim(),
            title: htmlToText(job.jobTitle),
            url: job.url,
            locationText: scope,
            workMode: "remote",
            remoteScope: scope,
            description: htmlToText(job.jobDescription ?? job.jobExcerpt ?? ""),
            postedAt: parseDate(job.pubDate),
            raw: job,
          });
        }
      }
      return [...byId.values()];
    },
  };
}
