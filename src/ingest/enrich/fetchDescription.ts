// src/ingest/enrich/fetchDescription.ts
// Fetches the full description of a title-only posting (job-alert emails carry only title/company/link).
// - LinkedIn: public logged-out job page (guest route); no account, no cookies.
// - Any other site (eJobs, BestJobs, company pages): schema.org JobPosting JSON-LD, which job sites embed for Google Jobs.
// Also detects postings that are closed, expired or removed.
import { parse, type HTMLElement } from "node-html-parser";
import { z } from "zod";
import { htmlToText } from "../text.js";

export type FetchResult =
  | { status: "ok"; description: string; via: string }
  | { status: "closed"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "rate-limited"; reason: string };

const MIN_DESCRIPTION_CHARS = 300;
// Browser-like headers: several job sites return an empty shell or 403 to non-browser clients
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9,ro;q=0.8",
};
const CLOSED_TEXT_RE =
  /no longer accepting applications|not currently accepting applications|this job (?:is no longer available|has expired)|position has been filled|job (?:posting )?(?:has )?expired|anun[tț]ul (?:a expirat|nu mai este (?:activ|disponibil))|job(?:ul)? (?:a expirat|nu mai este (?:activ|disponibil))/i;

const JobPostingLd = z.object({
  "@type": z.union([z.string(), z.array(z.string())]).optional(),
  description: z.string().optional(),
  validThrough: z.string().optional(),
});

function linkedInJobId(url: string): string | null {
  const m = /linkedin\.com\/(?:comm\/)?jobs\/view\/(?:[^/?#]*-)?(\d{6,})/i.exec(url);
  return m?.[1] ?? null;
}

function jsonLdPostings(root: HTMLElement): z.infer<typeof JobPostingLd>[] {
  const found: z.infer<typeof JobPostingLd>[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if ("@graph" in obj) visit(obj["@graph"]);
    const parsed = JobPostingLd.safeParse(obj);
    const type = parsed.success ? parsed.data["@type"] : undefined;
    if (parsed.success && (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting")))) found.push(parsed.data);
  };
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      visit(JSON.parse(script.text));
    } catch {
      // malformed JSON-LD block: ignore, try the next one
    }
  }
  return found;
}

function fromJsonLd(root: HTMLElement, now: Date): FetchResult | null {
  for (const p of jsonLdPostings(root)) {
    if (p.validThrough && !Number.isNaN(Date.parse(p.validThrough)) && Date.parse(p.validThrough) < now.getTime()) {
      return { status: "closed", reason: `expired ${p.validThrough.slice(0, 10)}` };
    }
    const description = htmlToText(p.description ?? "");
    if (description.length >= MIN_DESCRIPTION_CHARS) return { status: "ok", description, via: "json-ld" };
  }
  return null;
}

async function get(url: string, signal: AbortSignal): Promise<{ status: number; html: string }> {
  const response = await fetch(url, { headers: HEADERS, redirect: "follow", signal });
  return { status: response.status, html: response.status < 400 ? await response.text() : "" };
}

async function fetchLinkedIn(jobId: string, signal: AbortSignal, now: Date): Promise<FetchResult> {
  const { status, html } = await get(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`, signal);
  if (status === 404 || status === 410) return { status: "closed", reason: "removed from LinkedIn" };
  if (status === 429 || status === 999) return { status: "rate-limited", reason: `LinkedIn HTTP ${status}` };
  if (status >= 400) return { status: "unavailable", reason: `LinkedIn HTTP ${status}` };

  const root = parse(html);
  // Strip the similar-jobs rail and sign-in chrome; keep JSON-LD scripts for the fallback below
  root.querySelectorAll("aside, style, button").forEach((n) => n.remove());
  root.querySelectorAll("script").forEach((n) => {
    if (n.getAttribute("type") !== "application/ld+json") n.remove();
  });
  if (CLOSED_TEXT_RE.test(root.text)) return { status: "closed", reason: "no longer accepting applications" };

  const block = root.querySelector(".show-more-less-html__markup") ?? root.querySelector(".description__text");
  const description = block ? htmlToText(block.innerHTML) : "";
  if (description.length >= MIN_DESCRIPTION_CHARS) return { status: "ok", description, via: "linkedin" };
  return fromJsonLd(root, now) ?? { status: "unavailable", reason: "LinkedIn page had no description block" };
}

async function fetchGeneric(url: string, signal: AbortSignal, now: Date): Promise<FetchResult> {
  const { status, html } = await get(url, signal);
  if (status === 404 || status === 410) return { status: "closed", reason: `HTTP ${status} (removed)` };
  if (status === 429) return { status: "rate-limited", reason: "HTTP 429" };
  if (status >= 400) return { status: "unavailable", reason: `HTTP ${status}` };

  const root = parse(html);
  const ld = fromJsonLd(root, now);
  if (ld) return ld;
  root.querySelectorAll("script, style, nav, header, footer, aside").forEach((n) => n.remove());
  if (CLOSED_TEXT_RE.test(root.text)) return { status: "closed", reason: "page says the job is closed" };
  return { status: "unavailable", reason: "no JobPosting data on the page" };
}

export async function fetchDescription(url: string, opts: { linkedin: boolean; signal: AbortSignal; now?: Date }): Promise<FetchResult> {
  const now = opts.now ?? new Date();
  const jobId = linkedInJobId(url);
  if (jobId !== null) {
    return opts.linkedin ? fetchLinkedIn(jobId, opts.signal, now) : { status: "unavailable", reason: "LinkedIn enrichment disabled" };
  }
  return fetchGeneric(url, opts.signal, now);
}
