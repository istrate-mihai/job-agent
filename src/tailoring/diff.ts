// src/tailoring/diff.ts
// Human review aid: what changed versus the base CV, and which posting requirements the CV actually proves.
import type { PostingRow, PostingScoreRow, TailoringSelection } from "../db/schema.js";
import { baseSelection } from "../cv/view.js";
import { hasTerm, normalizeText } from "../ingest/text.js";
import type { Fact, MasterCv } from "../schemas/masterCv.js";

export interface DiffInput {
  posting: PostingRow;
  score: PostingScoreRow | null;
  cv: MasterCv;
  selection: TailoringSelection; // final, after page-fit trimming
  summary: string;
  coverNote: string;
  postingKeywords: string[];
  availability: string | null;
  route: string;
  pages: number;
  trims: string[];
  notes: string[];
  warnings: string[];
}

// Requirement phrasing in postings vs the words the CV uses for the same thing
const SYNONYMS: ReadonlyArray<[RegExp, readonly string[]]> = [
  [/unit test|automated test|testing/i, ["phpunit", "feature tests", "test-driven development", "simulation-based testing"]],
  [/front[- ]?end/i, ["vue 3", "react", "html5", "frontend"]],
  [/back[- ]?end|server[- ]side/i, ["rest api", "laravel", "express", "fastapi", "backend"]],
  [/database|sql/i, ["mysql", "postgresql", "sqlite", "schema", "query optimization"]],
  [/security|authentication|authori[sz]ation/i, ["sanctum", "role-based authorization", "authentication"]],
  [/ci\/cd|continuous integration|pipeline/i, ["github actions", "ci"]],
  [/container/i, ["docker"]],
  [/agile|scrum|kanban/i, ["agile", "sprints"]],
  [/api/i, ["rest api", "api"]],
  [/\bllm|generative ai|agentic|ai agents?/i, ["llm", "ai agents", "tool-call", "tool calling"]],
];

const short = (text: string, max = 90): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function renderDiff(d: DiffInput): string {
  const facts = new Map<string, Fact>(
    [...d.cv.experience.flatMap((e) => e.facts), ...d.cv.projects.flatMap((p) => p.facts)].map((f) => [f.id, f]),
  );
  const base = baseSelection(d.cv);
  const kept = new Set([...d.selection.experienceFactIds, ...d.selection.projectFactIds]);
  const dropped = [...base.experienceFactIds, ...base.projectFactIds].filter((id) => !kept.has(id));
  const projectName = (id: string): string => d.cv.projects.find((p) => p.id === id)?.name ?? id;

  const evidence = normalizeText(
    [...kept].map((id) => `${facts.get(id)?.text ?? ""} ${(facts.get(id)?.skills ?? []).join(" ")}`).join(" \n ") +
      ` ${d.selection.prioritySkills.join(" ")}`,
  );
  // Generic phrases ("full-stack development") count as covered when all their words appear (5-letter stems)
  const stems = (text: string): string[] => normalizeText(text).split(/[^a-z0-9+#.]+/).filter((w) => w.length > 2).map((w) => w.slice(0, 5));
  const evidenceStems = new Set(stems(evidence));
  const coveredByWords = (k: string): boolean => {
    const words = stems(k);
    return words.length > 0 && !/\d/.test(k) && words.every((w) => evidenceStems.has(w));
  };
  // Years the CV itself claims ("4+ years of software development") vs the posting's "3+ years"
  const cvYears = Math.max(0, ...Object.values(d.cv.summarySeeds).flatMap((seed) => [...seed.matchAll(/(\d+)\+?\s*years/gi)].map((m) => Number(m[1]))));

  const coverage = d.postingKeywords.map((k) => {
    const years = /(\d+)\s*(?:\+|-\s*\d+)?\s*(?:\+\s*)?years?/i.exec(k);
    if (years) {
      const need = Number(years[1]);
      return need <= cvYears ? `- ✔ ${k} — CV states ${cvYears}+ years` : `- ✖ ${k} — CV states ${cvYears}+ years (prepare an honest answer)`;
    }
    const hitsFor = (term: string): string[] =>
      [...kept].filter((id) => {
        const f = facts.get(id);
        return f !== undefined && hasTerm(normalizeText(`${f.text} ${f.skills.join(" ")}`), term);
      });
    const hits = hitsFor(k);
    if (hits.length > 0) return `- ✔ ${k} — ${hits.slice(0, 3).join(", ")}`;
    if (hasTerm(evidence, k)) return `- ✔ ${k} — skills section`;
    // "Vue.js 3+" → "vue 3" → "vue"; "PHP 8+" → "php"
    const unversioned = normalizeText(k).replace(/\.js\b/g, "").replace(/\+/g, "").trim();
    const bare = unversioned.replace(/\s*\d+(?:\.\d+)*$/, "").trim();
    for (const variant of [unversioned, bare]) {
      if (variant && variant !== normalizeText(k) && (hitsFor(variant).length > 0 || hasTerm(evidence, variant))) {
        return `- ✔ ${k} — ${variant === bare && bare !== unversioned ? `${bare} (version not stated in CV)` : variant}`;
      }
    }
    const synonyms = SYNONYMS.find(([re]) => re.test(k))?.[1] ?? [];
    const viaSynonym = synonyms.find((syn) => hasTerm(evidence, syn));
    if (viaSynonym) return `- ✔ ${k} — via "${viaSynonym}"`;
    if (coveredByWords(k)) return `- ✔ ${k} — covered across bullets`;
    return `- ✖ ${k} — not evidenced in the CV (prepare an honest answer)`;
  });

  const lines = [
    `# ${d.posting.company} — ${d.posting.title}`,
    "",
    `- Posting: ${d.posting.url}`,
    `- Location: ${d.posting.locationText || "n/a"} (${d.posting.locationTier ?? "?"}, ${d.posting.workMode})`,
    d.score ? `- Fit score: ${d.score.total} (${d.score.recommendation}); gaps: ${d.score.mustHaveGaps.join(", ") || "none"}` : "- Fit score: n/a",
    `- Tailored by: ${d.route} · role focus: ${d.selection.roleFocus} · ${d.pages} page(s)`,
    d.availability ? `- Availability line: ${d.availability}` : "- Availability line: none (Brașov)",
    "",
    "## Posting requirements vs CV evidence",
    ...(coverage.length > 0 ? coverage : ["- (no keywords returned)"]),
    "",
    "## Summary",
    `**Base:** ${d.cv.summarySeeds.fullstack}`,
    "",
    `**Tailored:** ${d.summary}`,
    "",
    "## Bullets",
    `Kept ${kept.size} of ${base.experienceFactIds.length + base.projectFactIds.length}.`,
    ...(dropped.length > 0 ? ["Dropped:", ...dropped.map((id) => `- ${id}: ${short(facts.get(id)?.text ?? "")}`)] : ["Nothing dropped."]),
    "",
    "## Projects (in order)",
    ...d.selection.projectIds.map((id, i) => `${i + 1}. ${projectName(id)}`),
    "",
    "## Skills moved to the front",
    d.selection.prioritySkills.length > 0 ? d.selection.prioritySkills.join(", ") : "(none)",
    "",
    "## Cover letter",
    d.coverNote,
    "",
    "## Checks",
    ...(d.trims.length > 0 ? d.trims.map((t) => `- page fit: ${t}`) : ["- page fit: no trimming needed"]),
    ...d.notes.map((n) => `- note: ${n}`),
    ...(d.warnings.length > 0 ? d.warnings.map((w) => `- ⚠ ${w}`) : ["- validator: all claims evidenced"]),
    "",
  ];
  return lines.join("\n");
}
