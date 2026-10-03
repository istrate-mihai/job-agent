// src/ingest/sources/personio.ts
// Personio public XML feed (no key): https://<slug>.jobs.personio.de/xml (or .com)
// Common with German/Austrian employers that have Romanian offices.
import type { JobSource, NormalizedPosting } from "../types.js";
import { decodeEntities, htmlToText, inferWorkMode, parseDate } from "../text.js";

export interface PersonioPosition {
  id: string;
  name: string;
  offices: string[];
  department: string;
  createdAt: string;
  description: string;
}

const tag = (xml: string, name: string): string[] =>
  [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1] ?? "");

const value = (raw: string): string => {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  return (cdata ? (cdata[1] ?? "") : decodeEntities(raw)).trim();
};

/** Pure XML → positions. Exported for tests. */
export function parsePersonioXml(xml: string): PersonioPosition[] {
  return tag(xml, "position").map((p) => {
    const additional = tag(p, "additionalOffices").flatMap((a) => tag(a, "office"));
    const office = tag(p, "office")[0] ?? ""; // first <office> is the main one (precedes additionalOffices)
    const sections = tag(p, "jobDescription").map((d) => `${value(tag(d, "name")[0] ?? "")}\n${htmlToText(value(tag(d, "value")[0] ?? ""))}`.trim());
    return {
      id: value(tag(p, "id")[0] ?? ""),
      name: value(tag(p, "name")[0] ?? ""),
      offices: [...new Set([value(office), ...additional.map(value)].filter((o) => o.length > 0))],
      department: value(tag(p, "department")[0] ?? ""),
      createdAt: value(tag(p, "createdAt")[0] ?? ""),
      description: sections.join("\n\n"),
    };
  }).filter((p) => p.id !== "" && p.name !== "");
}

export function personioSource(company: string, slug: string, domain: "de" | "com"): JobSource {
  const host = `${slug}.jobs.personio.${domain}`;
  return {
    name: `personio:${slug}`,
    async fetch(signal): Promise<NormalizedPosting[]> {
      const res = await fetch(`https://${host}/xml?language=en`, {
        signal,
        headers: { "User-Agent": "job-agent/0.1 (personal job search; github.com/istrate-mihai)", Accept: "application/xml" },
      });
      if (!res.ok) throw new Error(`GET https://${host}/xml → ${res.status} ${res.statusText}`);
      return parsePersonioXml(await res.text()).map((p) => {
        const location = p.offices.join("; ");
        return {
          source: "personio",
          sourceId: `${slug}:${p.id}`,
          company,
          title: p.name,
          url: `https://${host}/job/${encodeURIComponent(p.id)}`,
          locationText: location,
          workMode: inferWorkMode(location, p.name),
          remoteScope: null,
          description: p.description,
          postedAt: parseDate(p.createdAt),
          raw: { id: p.id, department: p.department, offices: p.offices },
        };
      });
    },
  };
}
