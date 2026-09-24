// src/filter/hardFilter.ts
import type { SearchConfig } from "../config/searchConfig.js";
import { hasTerm, normalizeText } from "../ingest/text.js";
import type { NormalizedPosting } from "../ingest/types.js";

export type LocationTier = "remote" | "tierA" | "tierB";

export interface FilterResult {
  pass: boolean;
  tier: LocationTier | null;
  reasons: string[]; // why it was rejected (empty = passed)
  flags: string[]; // non-blocking signals for scoring/review
}

type City = SearchConfig["locations"]["tierA"][number];

const REQUIRED_RE = /\b(required|mandatory|must|fluent|native|proficient|proficiency|business level|c1|c2|b2)\b/;
const OPTIONAL_RE = /\b(plus|nice to have|advantage|bonus|preferred|optional)\b/;
const DAY_MS = 86_400_000;

function matchesCity(location: string, cities: readonly City[]): boolean {
  return cities.some((c) => [c.name, ...c.aliases].some((term) => hasTerm(location, term)));
}

function classifyLocation(
  p: NormalizedPosting,
  cfg: SearchConfig,
): { tier: LocationTier | null; reason: string | null; flags: string[] } {
  const { tierA, tierB, remoteScopeAllow, countryFallback } = cfg.locations;
  const location = normalizeText(`${p.locationText} ${p.remoteScope ?? ""}`);
  const cityTier: LocationTier | null = matchesCity(location, tierA)
    ? "tierA"
    : matchesCity(location, tierB)
      ? "tierB"
      : null;

  if (p.workMode === "remote" || hasTerm(location, "remote")) {
    const scopeAllowed =
      cityTier !== null || hasTerm(location, countryFallback) || remoteScopeAllow.some((t) => hasTerm(location, t));
    if (scopeAllowed) return { tier: "remote", reason: null, flags: [] };

    const onlyWordRemote = location.replace(/\bremote\b/g, "").replace(/[^a-z0-9]+/g, "").length === 0;
    if (onlyWordRemote || location.length === 0) {
      return { tier: "remote", reason: null, flags: ["remote-scope-unclear"] };
    }
    return { tier: null, reason: `remote-scope-excluded:${p.remoteScope ?? p.locationText}`, flags: [] };
  }

  if (cityTier !== null) {
    return { tier: cityTier, reason: null, flags: cityTier === "tierB" ? ["relocation"] : [] };
  }
  if (hasTerm(location, countryFallback)) {
    return { tier: "tierB", reason: null, flags: ["city-unspecified", "relocation"] };
  }
  return { tier: null, reason: `location-outside-targets:${p.locationText}`, flags: [] };
}

function languageFlags(description: string, languages: readonly string[]): string[] {
  const sentences = description.split(/[.!?\n]+/).map(normalizeText);
  const flags: string[] = [];
  for (const lang of languages) {
    const hits = sentences.filter((s) => hasTerm(s, lang));
    if (hits.length === 0) continue;
    const required = hits.some((s) => REQUIRED_RE.test(s) && !OPTIONAL_RE.test(s));
    flags.push(`${required ? "lang-required" : "lang-mentioned"}:${lang}`);
  }
  return flags;
}

export function hardFilter(p: NormalizedPosting, cfg: SearchConfig, now: Date = new Date()): FilterResult {
  const reasons: string[] = [];
  const flags: string[] = [];

  const company = normalizeText(p.company);
  if (cfg.companies.blocklist.some((b) => normalizeText(b) === company)) {
    reasons.push("company-blocklisted");
  }
  if (cfg.companies.allowlist.some((a) => normalizeText(a) === company)) {
    flags.push("allowlist-company");
  }

  const title = normalizeText(p.title);
  if (!cfg.titles.include.some((t) => hasTerm(title, t))) {
    reasons.push("title-not-matched");
  }
  const excluded = cfg.titles.exclude.find((t) => hasTerm(title, t));
  if (excluded !== undefined) {
    reasons.push(`title-excluded:${excluded}`);
  }
  if (hasTerm(title, "senior") || hasTerm(title, "sr")) {
    flags.push("title-senior"); // not rejected: LLM scoring judges actual requirements
  }

  if (p.postedAt === null) {
    flags.push("posted-date-unknown");
  } else if (now.getTime() - p.postedAt.getTime() > cfg.maxPostingAgeDays * DAY_MS) {
    const days = Math.floor((now.getTime() - p.postedAt.getTime()) / DAY_MS);
    // Career pages list only open roles, so age is informational there; job boards keep stale ads
    if (cfg.ageExemptSources.includes(p.source)) flags.push(`long-open:${days}d`);
    else reasons.push("too-old");
  }

  const location = classifyLocation(p, cfg);
  if (location.reason !== null) reasons.push(location.reason);
  flags.push(...location.flags);

  flags.push(...languageFlags(p.description, cfg.languageFlags));

  return { pass: reasons.length === 0, tier: location.tier, reasons, flags };
}
