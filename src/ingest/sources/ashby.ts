// src/ingest/sources/ashby.ts
// Ashby public job board API (no key): api.ashbyhq.com/posting-api/job-board/<slug>
// Slug from a careers link: jobs.ashbyhq.com/<slug>
import { z } from "zod";
import { fetchJson } from "../http.js";
import { htmlToText, inferWorkMode, parseDate } from "../text.js";
import type { JobSource, NormalizedPosting, WorkMode } from "../types.js";

const AshbyJobSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  location: z.string().nullish(),
  secondaryLocations: z.array(z.object({ location: z.string().nullish() })).nullish(),
  isListed: z.boolean().nullish(),
  isRemote: z.boolean().nullish(),
  workplaceType: z.string().nullish(), // "OnSite" | "Hybrid" | "Remote"
  publishedAt: z.string().nullish(),
  jobUrl: z.url(),
  descriptionPlain: z.string().nullish(),
  descriptionHtml: z.string().nullish(),
});

const AshbyResponseSchema = z.object({ jobs: z.array(AshbyJobSchema) });
type AshbyJob = z.infer<typeof AshbyJobSchema>;

export function ashbyLocation(job: AshbyJob): string {
  const all = [job.location, ...(job.secondaryLocations ?? []).map((l) => l.location)];
  return [...new Set(all.map((l) => l?.trim() ?? "").filter((l) => l.length > 0))].join("; ");
}

export function ashbyWorkMode(job: AshbyJob, location: string): WorkMode {
  switch (job.workplaceType?.toLowerCase().replace(/[-_ ]/g, "")) {
    case "remote":
      return "remote";
    case "hybrid":
      return "hybrid";
    case "onsite":
      return "onsite";
  }
  if (job.isRemote) return "remote";
  return inferWorkMode(location, job.title);
}

export function ashbySource(company: string, slug: string): JobSource {
  return {
    name: `ashby:${slug}`,
    async fetch(signal): Promise<NormalizedPosting[]> {
      const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=false`;
      const { jobs } = AshbyResponseSchema.parse(await fetchJson(url, signal));
      return jobs
        .filter((job) => job.isListed !== false) // unlisted = internal/confidential, not applicable from outside
        .map((job) => {
          const locationText = ashbyLocation(job);
          const workMode = ashbyWorkMode(job, locationText);
          return {
            source: "ashby",
            sourceId: `${slug}:${job.id}`,
            company,
            title: job.title.trim(),
            url: job.jobUrl,
            locationText,
            workMode,
            remoteScope: workMode === "remote" ? locationText || null : null, // e.g. "Remote - Europe"
            description: job.descriptionPlain?.trim() || htmlToText(job.descriptionHtml ?? ""),
            postedAt: parseDate(job.publishedAt),
            raw: job,
          };
        });
    },
  };
}
