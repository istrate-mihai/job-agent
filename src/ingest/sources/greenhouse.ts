// src/ingest/sources/greenhouse.ts
import { z } from "zod";
import { fetchJson } from "../http.js";
import { htmlToText, inferWorkMode, parseDate } from "../text.js";
import type { JobSource, NormalizedPosting } from "../types.js";

const GreenhouseJobSchema = z.object({
  id: z.number(),
  title: z.string(),
  absolute_url: z.url(),
  updated_at: z.string(),
  first_published: z.string().nullish(),
  location: z.object({ name: z.string() }),
  content: z.string().nullish(),
});

const GreenhouseResponseSchema = z.object({ jobs: z.array(GreenhouseJobSchema) });

export function greenhouseSource(company: string, boardToken: string): JobSource {
  return {
    name: `greenhouse:${boardToken}`,
    async fetch(signal): Promise<NormalizedPosting[]> {
      const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs?content=true`;
      const { jobs } = GreenhouseResponseSchema.parse(await fetchJson(url, signal));
      return jobs.map((job) => {
        const description = htmlToText(job.content ?? "");
        return {
          source: "greenhouse",
          sourceId: `${boardToken}:${job.id}`,
          company,
          title: job.title.trim(),
          url: job.absolute_url,
          locationText: job.location.name,
          workMode: inferWorkMode(job.location.name, job.title),
          remoteScope: null,
          description,
          postedAt: parseDate(job.first_published ?? job.updated_at),
          raw: job,
        };
      });
    },
  };
}
