// src/scripts/atsProbe.ts
// Finds which public ATS feed an employer uses and prints ready-to-paste config.
// Usage: npm run ats:probe -- <careers-page-url | company name> [...]
//   npm run ats:probe -- https://www.tremend.com/careers "NTT DATA" Endava
// URL → scans the page for ATS links. Name → tries slug guesses on every supported ATS.
// Read-only: no DB, no LLM.
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { greenhouseSource } from "../ingest/sources/greenhouse.js";
import { leverSource } from "../ingest/sources/lever.js";
import { personioSource } from "../ingest/sources/personio.js";
import { recruiteeSource } from "../ingest/sources/recruitee.js";
import { workableSource } from "../ingest/sources/workable.js";
import { normalizeText } from "../ingest/text.js";
import type { JobSource } from "../ingest/types.js";

type Ats = "smartrecruiters" | "greenhouse" | "lever" | "lever-eu" | "workable" | "recruitee" | "personio-de" | "personio-com";
interface Candidate {
  ats: Ats;
  slug: string;
}
interface Hit extends Candidate {
  total: number;
  romania: number;
}

const DELAY_MS = 300; // politeness between API calls
const TIMEOUT_MS = 20_000;
const RO_TERMS = ["romania", "bucuresti", "bucharest", "brasov", "cluj", "iasi", "timisoara", "sibiu", "craiova", "oradea", "constanta"];
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
};

const SUPPORTED: readonly { ats: Ats; re: RegExp }[] = [
  { ats: "smartrecruiters", re: /(?:jobs|careers)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/g },
  { ats: "greenhouse", re: /(?:boards|job-boards(?:\.eu)?)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([A-Za-z0-9_-]+)/g },
  { ats: "lever-eu", re: /jobs\.eu\.lever\.co\/([A-Za-z0-9_-]+)/g },
  { ats: "lever", re: /jobs\.lever\.co\/([A-Za-z0-9_-]+)/g },
  { ats: "workable", re: /apply\.workable\.com\/([A-Za-z0-9_-]+)/g },
  { ats: "recruitee", re: /([a-z0-9-]+)\.recruitee\.com/g },
  { ats: "personio-de", re: /([a-z0-9-]+)\.jobs\.personio\.de/g },
  { ats: "personio-com", re: /([a-z0-9-]+)\.jobs\.personio\.com/g },
];
// Detected but no public feed source yet: tell the user to cover them via email alerts instead
const UNSUPPORTED: readonly [string, RegExp][] = [
  ["Workday", /myworkdayjobs\.com|myworkdaysite\.com/],
  ["SAP SuccessFactors", /successfactors\.(?:com|eu)|jobs\.sap\.com/],
  ["Avature", /avature\.net/],
  ["Phenom", /phenompeople\.com/],
  ["Teamtailor", /teamtailor\.com/],
  ["BambooHR", /bamboohr\.com/],
  ["softgarden", /softgarden\.io/],
  ["eJobs employer page", /ejobs\.ro\/company/],
];

const IGNORED_SLUGS = new Set(["embed", "api", "v1", "www", "jobs", "careers", "app", "j"]);

function isRomania(location: string): boolean {
  const n = normalizeText(location);
  return RO_TERMS.some((t) => n.includes(t)) || /(^|[\s,])ro($|[\s,])/.test(n);
}

function slugGuesses(name: string): string[] {
  const words = name.trim().split(/\s+/);
  return [...new Set([words.join(""), words.join("-").toLowerCase(), words.join("").toLowerCase(), words.join("").toUpperCase()])];
}

function sourceFor(c: Candidate, company: string): JobSource | null {
  switch (c.ats) {
    case "greenhouse":
      return greenhouseSource(company, c.slug);
    case "lever":
      return leverSource(company, c.slug, "global");
    case "lever-eu":
      return leverSource(company, c.slug, "eu");
    case "workable":
      return workableSource(company, c.slug);
    case "recruitee":
      return recruiteeSource(company, c.slug);
    case "personio-de":
      return personioSource(company, c.slug, "de");
    case "personio-com":
      return personioSource(company, c.slug, "com");
    case "smartrecruiters":
      return null; // its source needs the DB; probed directly below
  }
}

const SrList = z.object({ totalFound: z.number(), content: z.array(z.object({ location: z.object({ country: z.string().nullish() }).nullish() })) });

async function probe(c: Candidate, company: string): Promise<Hit | null> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    if (c.ats === "smartrecruiters") {
      const res = await fetch(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(c.slug)}/postings?limit=100`, { signal });
      if (!res.ok) return null;
      const data = SrList.parse(await res.json());
      if (data.totalFound === 0) return null; // unknown companyIds also return 200 with 0 results
      const romania = data.content.filter((p) => p.location?.country?.toLowerCase() === "ro").length;
      return { ...c, total: data.totalFound, romania };
    }
    const source = sourceFor(c, company);
    if (!source) return null;
    const postings = await source.fetch(signal);
    return { ...c, total: postings.length, romania: postings.filter((p) => isRomania(p.locationText)).length };
  } catch {
    return null; // 404 / not this ATS / unexpected payload
  }
}

async function candidatesFromPage(url: string): Promise<{ candidates: Candidate[]; unsupported: string[] }> {
  const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const haystack = `${res.url}\n${res.ok ? await res.text() : ""}`;
  if (!res.ok) console.warn(`  page returned HTTP ${res.status}; checking the final URL only`);
  const candidates = new Map<string, Candidate>();
  for (const { ats, re } of SUPPORTED) {
    for (const m of haystack.matchAll(re)) {
      const slug = m[1] ?? "";
      if (slug.length > 1 && !IGNORED_SLUGS.has(slug.toLowerCase())) candidates.set(`${ats}:${slug}`, { ats, slug });
    }
  }
  const unsupported = UNSUPPORTED.filter(([, re]) => re.test(haystack)).map(([name]) => name);
  return { candidates: [...candidates.values()], unsupported };
}

function yamlLine(h: Hit, company: string): string {
  switch (h.ats) {
    case "smartrecruiters":
      return `smartrecruiters: - { company: ${company}, companyId: ${h.slug}, country: ro }`;
    case "greenhouse":
      return `greenhouse:      - { company: ${company}, boardToken: ${h.slug} }`;
    case "lever":
    case "lever-eu":
      return `lever:           - { company: ${company}, slug: ${h.slug}${h.ats === "lever-eu" ? ", region: eu" : ""} }`;
    case "workable":
      return `workable:        - { company: ${company}, slug: ${h.slug} }`;
    case "recruitee":
      return `recruitee:       - { company: ${company}, slug: ${h.slug} }`;
    case "personio-de":
    case "personio-com":
      return `personio:        - { company: ${company}, slug: ${h.slug}${h.ats === "personio-com" ? ", domain: com" : ""} }`;
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: npm run ats:probe -- <careers-page-url | "Company Name"> [...]');
    return 1;
  }
  for (const arg of args) {
    const isUrl = /^https?:\/\//i.test(arg);
    const company = isUrl ? new URL(arg).hostname.replace(/^(www|careers|jobs)\./, "").split(".")[0] ?? arg : arg;
    console.log(`\n▶ ${arg}`);
    let candidates: Candidate[];
    if (isUrl) {
      const found = await candidatesFromPage(arg);
      candidates = found.candidates;
      if (found.unsupported.length > 0) console.log(`  uses ${found.unsupported.join(", ")} (no feed source; rely on LinkedIn/eJobs email alerts)`);
      if (candidates.length === 0) console.log("  no supported ATS link on the page (JS-rendered page? try the company name instead)");
    } else {
      const allAts: Ats[] = ["smartrecruiters", "greenhouse", "lever", "lever-eu", "workable", "recruitee", "personio-de", "personio-com"];
      candidates = slugGuesses(arg).flatMap((slug) => allAts.map((ats) => ({ ats, slug })));
    }
    let hits = 0;
    for (const c of candidates) {
      const hit = await probe(c, company);
      if (hit) {
        hits += 1;
        console.log(`  ✔ ${hit.ats}/${hit.slug}: ${hit.total} open, ${hit.romania} in Romania`);
        console.log(`    ${yamlLine(hit, company)}`);
      }
      await sleep(DELAY_MS);
    }
    if (hits === 0 && candidates.length > 0) console.log("  ✖ no public feed found");
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
