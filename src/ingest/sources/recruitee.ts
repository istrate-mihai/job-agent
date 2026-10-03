// src/ingest/sources/recruitee.ts
// Recruitee public careers API (no key): <slug>.recruitee.com/api/offers/
import { z } from "zod";
import { fetchJson } from "../http.js";
import { htmlToText, inferWorkMode, parseDate } from "../text.js";
import type { JobSource, NormalizedPosting, WorkMode } from "../types.js";

const RecruiteeOfferSchema = z.object({
  id: z.number(),
  title: z.string().min(1),
  careers_url: z.string(),
  location: z.string().nullish(),
  city: z.string().nullish(),
  country: z.string().nullish(),
  remote: z.boolean().nullish(),
  hybrid: z.boolean().nullish(),
  on_site: z.boolean().nullish(),
  status: z.string().nullish(),
  published_at: z.string().nullish(),
  created_at: z.string().nullish(),
  description: z.string().nullish(),
  requirements: z.string().nullish(),
});

const RecruiteeResponseSchema = z.object({ offers: z.array(RecruiteeOfferSchema) });
type RecruiteeOffer = z.infer<typeof RecruiteeOfferSchema>;

export function recruiteeWorkMode(o: RecruiteeOffer, location: string): WorkMode {
  if (o.remote) return "remote";
  if (o.hybrid) return "hybrid";
  if (o.on_site) return "onsite";
  return inferWorkMode(location, o.title);
}

export function recruiteeSource(company: string, slug: string): JobSource {
  return {
    name: `recruitee:${slug}`,
    async fetch(signal): Promise<NormalizedPosting[]> {
      const url = `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`;
      const { offers } = RecruiteeResponseSchema.parse(await fetchJson(url, signal));
      return offers
        .filter((o) => !o.status || o.status === "published")
        .map((o) => {
          const location = o.location ?? [o.city, o.country].filter(Boolean).join(", ");
          return {
            source: "recruitee",
            sourceId: `${slug}:${o.id}`,
            company,
            title: o.title.trim(),
            url: o.careers_url,
            locationText: location,
            workMode: recruiteeWorkMode(o, location),
            remoteScope: null,
            description: [htmlToText(o.description ?? ""), htmlToText(o.requirements ?? "")].filter(Boolean).join("\n\n"),
            postedAt: parseDate(o.published_at ?? o.created_at),
            raw: { ...o, description: undefined, requirements: undefined },
          };
        });
    },
  };
}
