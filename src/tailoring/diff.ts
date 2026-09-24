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
  const coverage = d.postingKeywords.map((k) => {
    const hits = [...kept].filter((id) => {
      const f = facts.get(id);
      return f !== undefined && hasTerm(normalizeText(`${f.text} ${f.skills.join(" ")}`), k);
    });
    if (hits.length > 0) return `- ✔ ${k} — ${hits.slice(0, 3).join(", ")}`;
    return hasTerm(evidence, k) ? `- ✔ ${k} — skills section` : `- ✖ ${k} — not found verbatim in the CV (prepare an honest answer)`;
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
    "## Cover note",
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
