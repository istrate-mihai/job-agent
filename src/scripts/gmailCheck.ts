// src/scripts/gmailCheck.ts
// Diagnoses "[gmail] fetched 0": shows recent job-alert-looking emails, their real sender addresses,
// and whether the configured query matches them. Read-only; nothing is stored or sent to an LLM.
import { google } from "googleapis";
import { loadSearchConfig } from "../config/searchConfig.js";
import { loadGmailAuth } from "../ingest/gmail/auth.js";

const LOOKBACK_DAYS = 14;
const BROAD_QUERY =
  `newer_than:${LOOKBACK_DAYS}d (from:(linkedin.com OR ejobs.ro OR bestjobs.eu OR hipo.ro OR jobicy.com) ` +
  `OR subject:("job alert" OR jobs OR joburi OR "locuri de munca" OR "new jobs" OR "joburi noi"))`;

const config = await loadSearchConfig();
const gmail = google.gmail({ version: "v1", auth: await loadGmailAuth() });

async function ids(q: string, max: number): Promise<string[]> {
  const res = await gmail.users.messages.list({ userId: "me", q, maxResults: max });
  return (res.data.messages ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
}

const configured = `${config.sources.gmail.query} newer_than:${config.sources.gmail.lookbackDays}d`;
const matchedByConfig = new Set(await ids(configured, 100));
const broad = await ids(BROAD_QUERY, 25);

console.log(`Configured query: ${configured}`);
console.log(`→ matches ${matchedByConfig.size} email(s)\n`);
console.log(`Job-alert-looking emails in the last ${LOOKBACK_DAYS} days (${broad.length}):`);

const senders = new Map<string, number>();
for (const id of broad) {
  const { data } = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
  const header = (name: string): string => data.payload?.headers?.find((h) => h.name === name)?.value ?? "";
  const from = header("From");
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
  senders.set(address, (senders.get(address) ?? 0) + 1);
  const mark = matchedByConfig.has(id) ? "✔" : "✖";
  console.log(`  ${mark} ${header("Date").slice(0, 16).padEnd(16)}  ${address.padEnd(40)}  ${header("Subject").slice(0, 70)}`);
}

if (broad.length === 0) {
  console.log("  (none) → no job alerts are reaching this inbox yet. Check the alerts exist and use this Gmail address.");
} else {
  console.log(`\nSender addresses found: ${[...senders.keys()].join(", ")}`);
  console.log("✖ rows are alerts your configured query misses: add their sender to sources.gmail.query.");
}
