// src/ingest/sources/gmail.ts
import { inArray } from "drizzle-orm";
import { google } from "googleapis";
import type { SearchConfig } from "../../config/searchConfig.js";
import { db } from "../../db/client.js";
import { gmailMessages } from "../../db/schema.js";
import { loadGmailAuth } from "../gmail/auth.js";
import { resolveJobUrl } from "../gmail/canonicalUrl.js";
import { extractJobs } from "../gmail/extract.js";
import { parseMessage } from "../gmail/message.js";
import type { JobSource, NormalizedPosting } from "../types.js";

interface ProcessedMessage {
  id: string;
  subject: string;
  jobCount: number;
}

export function gmailSource(config: SearchConfig): JobSource {
  const processed: ProcessedMessage[] = [];

  return {
    name: "gmail",
    timeoutMs: 300_000, // one LLM call per new alert email, plus possible 429 waits on free tiers
    async fetch(signal): Promise<NormalizedPosting[]> {
      const { query, lookbackDays, maxMessages } = config.sources.gmail;
      const gmail = google.gmail({ version: "v1", auth: await loadGmailAuth() });

      const list = await gmail.users.messages.list(
        { userId: "me", q: `${query} newer_than:${lookbackDays}d`, maxResults: maxMessages },
        { signal },
      );
      const ids = (list.data.messages ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
      if (ids.length === 0) return [];

      const seen = await db.select({ id: gmailMessages.id }).from(gmailMessages).where(inArray(gmailMessages.id, ids));
      const seenIds = new Set(seen.map((r) => r.id));
      const freshIds = ids.filter((id) => !seenIds.has(id));

      const postings: NormalizedPosting[] = [];
      for (const id of freshIds) {
        const { data } = await gmail.users.messages.get({ userId: "me", id, format: "full" }, { signal });
        const email = parseMessage(data);
        const jobs = await extractJobs({ kind: "email", ...email }, config, signal); // budget + kill switch checked inside the router

        for (const job of jobs) {
          const url = await resolveJobUrl(job.url, signal);
          postings.push({
            source: "gmail",
            sourceId: url, // canonical posting URL: same job in two alerts collapses
            company: job.company,
            title: job.title,
            url,
            locationText: job.location,
            workMode: job.workMode,
            remoteScope: null,
            description: "", // alerts carry no description; scoring flags this and you open the link
            postedAt: email.receivedAt,
            raw: { messageId: id, from: email.from, subject: email.subject, extracted: job },
          });
        }
        processed.push({ id, subject: email.subject.slice(0, 500), jobCount: jobs.length });
        console.log(`[gmail] ${email.subject.slice(0, 70)} → ${jobs.length} jobs`);
      }
      return postings;
    },
    async commit(): Promise<void> {
      if (processed.length > 0) {
        await db.insert(gmailMessages).values(processed).onConflictDoNothing();
      }
    },
  };
}
