// src/ingest/sources/workable.ts
// Workable public job widget (no key): apply.workable.com/api/v1/widget/accounts/<slug>
// Slug from a careers link: apply.workable.com/<slug>/
import { z } from "zod";
import { fetchJson } from "../http.js";
import { htmlToText, inferWorkMode, parseDate } from "../text.js";
import type { JobSource, NormalizedPosting, WorkMode } from "../types.js";

const LocationSchema = z.object({ city: z.string().nullish(), region: z.string().nullish(), country: z.string().nullish() }).partial();

const WorkableJobSchema = z.object({
  title: z.string().min(1),
  shortcode: z.string().min(1),
  url: z.string().nullish(),
  application_url: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  country: z.string().nullish(),
  locations: z.array(LocationSchema).nullish(),
  telecommuting: z.boolean().nullish(),
  workplace_type: z.string().nullish(), // "on_site" | "hybrid" | "remote" on newer accounts
  published_on: z.string().nullish(),
  created_at: z.string().nullish(),
  description: z.string().nullish(),
});

const WorkableResponseSchema = z.object({ jobs: z.array(WorkableJobSchema) });
type WorkableJob = z.infer<typeof WorkableJobSchema>;

export function workableLocation(job: WorkableJob): string {
  const places = job.locations && job.locations.length > 0 ? job.locations : [{ city: job.city, region: job.state, country: job.country }];
  return [...new Set(places.map((l) => [l.city, l.region, l.country].filter(Boolean).join(", ")).filter((s) => s.length > 0))].join("; ");
}

export function workableWorkMode(job: WorkableJob, location: string): WorkMode {
  const wt = job.workplace_type?.toLowerCase().replace(/[-_ ]/g, "");
  if (wt === "remote" || job.telecommuting) return "remote";
  if (wt === "hybrid") return "hybrid";
  if (wt === "onsite") return "onsite";
  return inferWorkMode(location, job.title);
}

export function workableSource(company: string, slug: string): JobSource {
  return {
    name: `workable:${slug}`,
    async fetch(signal): Promise<NormalizedPosting[]> {
      const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`;
      const { jobs } = WorkableResponseSchema.parse(await fetchJson(url, signal));
      return jobs.map((job) => {
        const location = workableLocation(job);
        return {
          source: "workable",
          sourceId: `${slug}:${job.shortcode}`,
          company,
          title: job.title.trim(),
          url: job.url ?? `https://apply.workable.com/${encodeURIComponent(slug)}/j/${encodeURIComponent(job.shortcode)}/`,
          locationText: location,
          workMode: workableWorkMode(job, location),
          remoteScope: null,
          description: htmlToText(job.description ?? ""),
          postedAt: parseDate(job.published_on ?? job.created_at),
          raw: { ...job, description: undefined },
        };
      });
    },
  };
}
