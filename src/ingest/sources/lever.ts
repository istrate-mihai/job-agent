// src/ingest/sources/lever.ts
import { z } from "zod";
import { fetchJson } from "../http.js";
import { htmlToText, inferWorkMode, parseDate } from "../text.js";
import type { JobSource, NormalizedPosting, WorkMode } from "../types.js";

const LeverPostingSchema = z.object({
  id: z.string(),
  text: z.string(),
  hostedUrl: z.url(),
  createdAt: z.number(),
  categories: z.object({
    location: z.string().optional(),
    commitment: z.string().optional(),
  }),
  workplaceType: z.string().optional(),
  descriptionPlain: z.string().optional(),
  additionalPlain: z.string().optional(),
  lists: z.array(z.object({ text: z.string(), content: z.string() })).optional(),
});

const LeverResponseSchema = z.array(LeverPostingSchema);

function mapWorkplaceType(value: string | undefined, fallbackText: string): WorkMode {
  switch (value?.toLowerCase()) {
    case "remote":
      return "remote";
    case "hybrid":
      return "hybrid";
    case "on-site":
    case "onsite":
      return "onsite";
    default:
      return inferWorkMode(fallbackText);
  }
}

export function leverSource(company: string, slug: string, region: "global" | "eu"): JobSource {
  const host = region === "eu" ? "api.eu.lever.co" : "api.lever.co";
  return {
    name: `lever:${slug}`,
    async fetch(signal): Promise<NormalizedPosting[]> {
      const url = `https://${host}/v0/postings/${encodeURIComponent(slug)}?mode=json`;
      const postings = LeverResponseSchema.parse(await fetchJson(url, signal));
      return postings.map((p) => {
        const location = p.categories.location ?? "";
        const sections = (p.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`);
        const description = [p.descriptionPlain ?? "", ...sections, p.additionalPlain ?? ""]
          .filter((s) => s.trim().length > 0)
          .join("\n\n");
        return {
          source: "lever",
          sourceId: `${slug}:${p.id}`,
          company,
          title: p.text.trim(),
          url: p.hostedUrl,
          locationText: location,
          workMode: mapWorkplaceType(p.workplaceType, `${location} ${p.text}`),
          remoteScope: null,
          description,
          postedAt: parseDate(p.createdAt),
          raw: p,
        };
      });
    },
  };
}
