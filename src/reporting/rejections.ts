// src/reporting/rejections.ts
// Spots rejection emails for applications you are tracking. Pure functions only (no DB, no Gmail, no LLM):
// src/scripts/rejections.ts feeds them emails and applications and decides what to store.
// "high" = safe to auto-mark rejected (undo-able); "low" = shown in the UI for you to confirm or ignore.
import { hasTerm, normalizeText } from "../ingest/text.js";

export interface EmailForMatching {
  id: string;
  from: string; // raw From header: "Ana Pop <careers@endava.com>"
  subject: string;
  text: string;
  receivedAt: Date | null;
}

export interface ApplicationForMatching {
  id: string;
  company: string;
  title: string;
  appliedAt: Date | null;
}

export interface RejectionMatch {
  postingId: string;
  confidence: "high" | "low";
  phrase: string; // the rejection phrase that matched (normalized)
  reason: string; // why this confidence, shown in the UI
  snippet: string; // a few lines around the phrase, so you can judge without opening the email
}

// Phrases that only appear in rejections. Normalized form: lowercase, no diacritics (see normalizeText).
const DEFINITIVE = [
  // English
  "regret to inform",
  "not be moving forward",
  "not moving forward",
  "decided not to move forward",
  "decided not to proceed",
  "will not be proceeding",
  "not to proceed with your application",
  "move forward with other candidates",
  "moving forward with other candidates",
  "proceed with other candidates",
  "pursue other candidates",
  "other candidates whose",
  "other applicants whose",
  "decided to go with another candidate",
  "have not been selected",
  "were not selected",
  "was not selected",
  "not been successful",
  "position has been filled",
  "role has been filled",
  "no longer considering your application",
  "will not be progressing",
  "not progress your application",
  "unable to offer you",
  "unsuccessful on this occasion",
  // Romanian
  "nu vom continua",
  "nu putem continua",
  "am decis sa continuam cu alt",
  "am ales sa continuam cu alt",
  "alti candidati",
  "alt candidat",
  "nu ati fost selectat",
  "nu a fost selectat",
  "nu ati fost selectata",
  "nu va putem oferi",
  "postul a fost ocupat",
  "pozitia a fost ocupata",
  "nu mergem mai departe",
  "nu vom merge mai departe",
] as const;

// Common in rejections but also in other mail ("unfortunately the link expired"): never enough for auto-marking
const SOFT = ["unfortunately", "din pacate", "not a match", "not the right fit", "nu se potriveste"] as const;

// Signs the email moves the process forward or asks for something: downgrade to "low" even with a definitive phrase
const GUARDS = [
  "next step",
  "schedule",
  "invite you",
  "invitation",
  "assessment",
  "complete the",
  "technical issue",
  "reapply",
  "re apply",
  "pasul urmator",
  "pasii urmatori",
  "va invitam",
  "programa",
  "interviu tehnic",
  "evaluare",
] as const;

// Applicant-tracking and job-board senders: the domain names the platform, not the employer
const PLATFORM_DOMAINS = [
  "greenhouse.io",
  "greenhouse-mail.io",
  "lever.co",
  "smartrecruiters.com",
  "workable.com",
  "workablemail.com",
  "ashbyhq.com",
  "myworkday.com",
  "workday.com",
  "successfactors.com",
  "successfactors.eu",
  "teamtailor.com",
  "teamtailor-mail.com",
  "recruitee.com",
  "personio.de",
  "personio.com",
  "icims.com",
  "taleo.net",
  "jobvite.com",
  "bamboohr.com",
  "breezy.hr",
  "linkedin.com",
  "ejobs.ro",
  "bestjobs.eu",
  "stepstone.de",
  "stepstone.com",
  "hipo.ro",
  "gmail.com",
  "yahoo.com",
  "outlook.com",
] as const;

// Job alerts mention dozens of companies: never treat them as an answer to an application
const ALERT_SUBJECT_RE = /job alert|new jobs|jobs for you|recommended jobs|jobs you may|joburi noi|locuri de munca noi|alerta/i;
const ALERT_SENDER_RE = /jobalerts|job-alerts|jobs-listings|alerts?@|newsletter|noreply-jobs/i;

// Words that are part of a company's legal name, not the name people use ("Tchibo Romania SRL" → "tchibo")
const COMPANY_NOISE = new Set(["romania", "ro", "srl", "s.r.l.", "sa", "s.a.", "s", "a", "inc", "ltd", "llc", "gmbh", "plc", "ag", "bv", "nv", "group", "the", "international", "global", "technologies", "technology", "services", "solutions", "software", "consulting", "company", "co"]);

const MAX_TEXT_CHARS = 6_000; // rejection emails are short; the rest is footer and legal text
const SNIPPET_RADIUS = 160;

/** Name variants a recruiter would write: "LSEG (London Stock Exchange Group)" → ["lseg", "london stock exchange"]. */
export function companyKeys(company: string): string[] {
  const variants = company.split(/[()]/).map((v) => v.trim()).filter(Boolean);
  const keys = variants.map((v) =>
    normalizeText(v)
      .split(" ")
      .filter((w) => !COMPANY_NOISE.has(w))
      .join(" ")
      .trim(),
  );
  return [...new Set(keys.filter((k) => k.replace(/\s/g, "").length >= 3))];
}

/** "Ana <careers@jobs.endava.com>" → { address, domain: "jobs.endava.com", label: "endava", display: "ana" }. */
export function parseSender(from: string): { address: string; domain: string; label: string; display: string } {
  const address = (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
  const domain = address.split("@")[1] ?? "";
  const parts = domain.split(".").filter(Boolean);
  // Registrable label: the part before the TLD, skipping two-part TLDs like co.uk / com.ro
  const twoPartTld = parts.length >= 3 && ["co", "com", "org", "net"].includes(parts[parts.length - 2] ?? "");
  const label = (twoPartTld ? parts[parts.length - 3] : parts[parts.length - 2]) ?? "";
  const display = normalizeText(from.replace(/<[^>]*>/g, "").replace(/"/g, ""));
  return { address, domain, label: label.replace(/-/g, ""), display };
}

const isPlatform = (domain: string): boolean => PLATFORM_DOMAINS.some((p) => domain === p || domain.endsWith(`.${p}`));

function findPhrase(haystack: string, phrases: readonly string[]): string | null {
  return phrases.find((p) => haystack.includes(p)) ?? null;
}

function snippetAround(text: string, phrase: string): string {
  const flat = text.replace(/\s+/g, " ");
  const index = normalizeText(flat).indexOf(phrase);
  // normalizeText keeps the length close to the original for Latin text, so the index is a good approximation
  const start = Math.max(0, (index < 0 ? 0 : index) - SNIPPET_RADIUS);
  const end = Math.min(flat.length, (index < 0 ? 0 : index) + phrase.length + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

/**
 * Returns one match per application this email is probably rejecting (usually zero or one).
 * Several applications at the same company and no title in the email → one "low" match per application.
 */
export function classifyRejection(email: EmailForMatching, applications: readonly ApplicationForMatching[]): RejectionMatch[] {
  if (ALERT_SUBJECT_RE.test(email.subject) || ALERT_SENDER_RE.test(email.from)) return [];

  const subject = normalizeText(email.subject);
  const body = normalizeText(email.text.slice(0, MAX_TEXT_CHARS));
  const all = `${subject} ${body}`;
  const definitive = findPhrase(all, DEFINITIVE);
  const soft = definitive ? null : findPhrase(all, SOFT);
  const phrase = definitive ?? soft;
  if (!phrase) return [];
  const guard = findPhrase(all, GUARDS);

  const sender = parseSender(email.from);
  const platform = isPlatform(sender.domain);

  // Which applications does this email talk about?
  const hits = applications
    .filter((a) => !a.appliedAt || !email.receivedAt || email.receivedAt.getTime() >= a.appliedAt.getTime() - 86_400_000)
    .map((a) => {
      const keys = companyKeys(a.company);
      const byDomain = !platform && sender.label.length >= 3 && keys.some((k) => k.replace(/\s/g, "") === sender.label);
      const byHeader = keys.some((k) => hasTerm(subject, k) || hasTerm(sender.display, k));
      const byBody = keys.some((k) => hasTerm(body, k));
      return { a, byDomain, byHeader, byBody };
    })
    .filter((h) => h.byDomain || h.byHeader || h.byBody);
  if (hits.length === 0) return [];

  // Same company, several roles: keep the ones whose title the email names, if any
  const titled = hits.filter((h) => {
    const title = normalizeText(h.a.title.split(/\s[-–|]\s|\(|,/)[0] ?? h.a.title);
    return title.length >= 6 && all.includes(title);
  });
  const chosen = titled.length > 0 ? titled : hits;
  const ambiguous = chosen.length > 1;

  return chosen.map((h) => {
    const strongCompany = h.byDomain || h.byHeader;
    const high = definitive !== null && guard === null && strongCompany && !ambiguous;
    const reason = high
      ? `"${phrase}" + ${h.byDomain ? `sender domain ${sender.domain}` : "company named in subject/sender"}`
      : [
          definitive ? null : `only a soft phrase ("${phrase}")`,
          guard ? `also mentions "${guard}"` : null,
          strongCompany ? null : "company found only in the email body",
          ambiguous ? `${chosen.length} applications at this company` : null,
        ]
          .filter(Boolean)
          .join("; ");
    return { postingId: h.a.id, confidence: high ? "high" : "low", phrase, reason, snippet: snippetAround(email.text.slice(0, MAX_TEXT_CHARS), phrase) };
  });
}

/** Gmail search that pre-selects likely rejections, so only a few emails are downloaded per run. */
export function rejectionQuery(days: number): string {
  const terms = ["unfortunately", "regret", "\"moving forward\"", "\"move forward\"", "\"other candidates\"", "\"not selected\"", "\"been filled\"", "\"din păcate\"", "\"alți candidați\"", "\"nu vom continua\"", "\"nu ați fost selectat\""];
  return `newer_than:${days}d -in:sent -in:chats -category:promotions (${terms.join(" OR ")})`;
}
