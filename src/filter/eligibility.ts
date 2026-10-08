// src/filter/eligibility.ts
// Deterministic checks the LLM score kept missing: "USA & Canada only" postings and hard years-of-experience demands.
// Both run on the description, so title-only postings get them after enrich/describe.
import { normalizeText } from "../ingest/text.js";

// Blocking: the posting explicitly limits who may apply to a country the candidate can't work from
const RESTRICTED_RE = [
  /\bopen (only )?to (residents|candidates|applicants|people) (of|in|based in|located in) (the )?(us|usa|united states|canada|us and canada|usa and canada|usa & canada|us & canada|north america|uk|united kingdom)( only)?\b/,
  /\b(usa?|united states|canada|u\.s\.?) (and|&) canada only\b/,
  /\b(usa?|united states|canada|uk|north america) (only|residents only|based only)\b/,
  /\bmust (be|reside|live|currently reside|currently live)( located| based)? in the (us|usa|united states|uk|united kingdom|continental us)\b/,
  /\bmust be (us|usa|u\.?s\.?) based\b/,
  /\b(us|u\.s\.) citizens?( only| required)\b/,
  /\b(active|current) (security|secret|top secret) clearance\b/,
  /\bcandidates? (must|need to) be (located|based) in (the )?(us|usa|united states|canada|north america)\b/,
];
// Non-blocking: common US boilerplate that sometimes still allows remote-from-EU; surfaced for review
const SOFT_RE = [/\bauthori[sz]ed to work in the (us|united states)\b/, /\bus time ?zones?\b/, /\b(pst|est|cst) (hours|business hours|overlap)\b/];

export interface EligibilityResult {
  blocked: string | null; // the matched phrase, when the posting excludes the candidate's country
  flags: string[];
}

export function checkEligibility(description: string): EligibilityResult {
  const text = normalizeText(description);
  for (const re of RESTRICTED_RE) {
    const m = re.exec(text);
    if (m) return { blocked: m[0], flags: [] };
  }
  const flags = SOFT_RE.filter((re) => re.test(text)).map((re) => `eligibility-check:${re.exec(text)?.[0] ?? ""}`);
  return { blocked: null, flags };
}

// "We have 20 years of experience in the market" describes the company, not the requirement
const COMPANY_RE = /\b(we have|we've|our (company|team|clients)|founded|for over|for more than|since \d{4}|track record of)\b/;
const OPTIONAL_RE = /\b(nice to have|plus|bonus|preferred|advantage|avantaj|ideally)\b/;
// "5+ years", "minimum 6 years", "at least 4 years", "4-6 years", "minim 5 ani"
const YEARS_RE = /\b(?:minimum|min\.?|at least|minim|cel putin)?\s*(\d{1,2})\s*(?:\+|\s\d{1,2}|plus|or more)?\s*(?:years?|yrs?|ani)\b/g;
const EXPERIENCE_RE = /\b(experience|experienta|professional|commercial|hands-on|background|working with|developing|development)\b/;

/** Highest years-of-experience demand in a REQUIRED sentence; null if none stated. Caps nonsense like "20 years". */
export function requiredYears(description: string): number | null {
  let max: number | null = null;
  for (const raw of description.split(/[.;\n•]+/)) {
    const s = normalizeText(raw);
    if (!EXPERIENCE_RE.test(s) || OPTIONAL_RE.test(s) || COMPANY_RE.test(s)) continue;
    for (const m of s.matchAll(YEARS_RE)) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 15 && (max === null || n > max)) max = n;
    }
  }
  return max;
}
