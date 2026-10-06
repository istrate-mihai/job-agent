// src/ingest/sources/rss.ts
// Generic RSS 2.0 source for public, attribution-only feeds (We Work Remotely category feeds, etc.).
// No key, no robots.txt concern: these feeds are explicitly published for third-party consumption.
import { decodeEntities, htmlToText, inferWorkMode, parseDate } from "../text.js";
import type { JobSource, NormalizedPosting } from "../types.js";

export interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  guid: string;
}

const tag = (xml: string, name: string): string[] =>
  [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1] ?? "");

const value = (raw: string): string => {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  return (cdata ? (cdata[1] ?? "") : decodeEntities(raw)).trim();
};

/** Pure: RSS 2.0 XML → items. Exported for tests. */
export function parseRssFeed(xml: string): RssItem[] {
  return tag(xml, "item")
    .map((item) => ({
      title: value(tag(item, "title")[0] ?? ""),
      link: value(tag(item, "link")[0] ?? ""),
      description: value(tag(item, "description")[0] ?? ""),
      pubDate: value(tag(item, "pubDate")[0] ?? ""),
      guid: value(tag(item, "guid")[0] ?? ""),
    }))
    .filter((i) => i.title !== "" && i.link !== "");
}

/**
 * We Work Remotely titles are formatted "Company: Job Title" — split that out so company/title
 * land in their own fields instead of both being jammed into `title`.
 */
function splitCompanyTitle(raw: string): { company: string; title: string } {
  const i = raw.indexOf(":");
  if (i < 0) return { company: "", title: raw.trim() };
  return { company: raw.slice(0, i).trim(), title: raw.slice(i + 1).trim() };
}

export function rssSource(name: string, url: string): JobSource {
  return {
    name: `rss:${name}`,
    async fetch(signal): Promise<NormalizedPosting[]> {
      const res = await fetch(url, {
        signal,
        headers: { "User-Agent": "job-agent/0.1 (personal job search; github.com/istrate-mihai)", Accept: "application/rss+xml, application/xml" },
      });
      if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
      const items = parseRssFeed(await res.text());
      return items.map((item) => {
        const { company, title } = splitCompanyTitle(item.title);
        const description = htmlToText(item.description);
        return {
          source: `rss:${name}`,
          sourceId: item.guid !== "" ? item.guid : item.link,
          company: company || name,
          title,
          url: item.link,
          locationText: "Remote",
          workMode: inferWorkMode("remote", description.slice(0, 500)),
          remoteScope: "worldwide",
          description,
          postedAt: parseDate(item.pubDate),
          raw: { via: "rss", feed: url },
        };
      });
    },
  };
}
