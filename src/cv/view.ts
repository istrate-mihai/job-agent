// src/cv/view.ts
// A CvView is exactly what gets printed. Base CV and tailored CVs are both views of master-cv.json,
// so every bullet on paper traces back to a fact id.
import type { TailoringSelection } from "../db/schema.js";
import type { Fact, MasterCv } from "../schemas/masterCv.js";

type Experience = MasterCv["experience"][number];
type Project = MasterCv["projects"][number];
type SkillCategory = MasterCv["skills"][number]["category"];

export interface SkillLine {
  label: string;
  used: string[];
  training: string[];
}

export interface CvView {
  basics: MasterCv["basics"];
  availability: string | null;
  summary: string;
  skillLines: SkillLine[];
  experience: { entry: Experience; facts: Fact[] }[]; // software + independent
  industrial: { entry: Experience; facts: Fact[] }[];
  projects: { project: Project; facts: Fact[] }[];
  certifications: MasterCv["certifications"];
  education: MasterCv["education"];
  languages: MasterCv["languages"];
}

const CATEGORY_LABELS: ReadonlyArray<[SkillCategory, string]> = [
  ["languages", "Languages"],
  ["backend", "Backend"],
  ["frontend", "Frontend"],
  ["databases", "Databases"],
  ["devops", "DevOps & Cloud"],
  ["integrations", "Integrations"],
  ["testing", "Testing"],
  ["practices", "Practices"],
];

export function baseSelection(cv: MasterCv): TailoringSelection {
  return {
    roleFocus: "fullstack",
    experienceFactIds: cv.experience.flatMap((e) => e.facts.map((f) => f.id)),
    projectIds: cv.projects.map((p) => p.id),
    projectFactIds: cv.projects.flatMap((p) => p.facts.map((f) => f.id)),
    prioritySkills: [],
  };
}

/** Selected facts in the selection's order; entries themselves stay in master (chronological) order. */
function pickFacts(facts: Fact[], orderedIds: readonly string[]): Fact[] {
  const byId = new Map(facts.map((f) => [f.id, f]));
  return orderedIds.map((id) => byId.get(id)).filter((f): f is Fact => f !== undefined);
}

function buildSkillLines(cv: MasterCv, prioritySkills: readonly string[]): SkillLine[] {
  const priority = prioritySkills.map((s) => s.toLowerCase());
  const rank = (name: string): number => {
    const i = priority.indexOf(name.toLowerCase());
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };

  // Category order stays fixed (consistent look); inside each line the posting's key skills come first
  return CATEGORY_LABELS.map(([category, label]) => {
    const inCategory = cv.skills.filter((s) => s.category === category);
    const used = inCategory
      .filter((s) => s.status === "used")
      .map((s, i) => ({ name: s.name, key: rank(s.name), i }))
      .sort((a, b) => a.key - b.key || a.i - b.i) // stable: priority first, then master order
      .map((s) => s.name);
    const training = inCategory.filter((s) => s.status === "training").map((s) => s.name);
    return { label, used, training };
  }).filter((line) => line.used.length > 0 || line.training.length > 0);
}

export function buildView(cv: MasterCv, selection: TailoringSelection, summary: string, availability: string | null): CvView {
  const entries = cv.experience.map((entry) => ({ entry, facts: pickFacts(entry.facts, selection.experienceFactIds) }));
  const projects = selection.projectIds
    .map((id) => cv.projects.find((p) => p.id === id))
    .filter((p): p is Project => p !== undefined)
    .map((project) => ({ project, facts: pickFacts(project.facts, selection.projectFactIds) }))
    .filter((p) => p.facts.length > 0);

  return {
    basics: cv.basics,
    availability,
    summary,
    skillLines: buildSkillLines(cv, selection.prioritySkills),
    experience: entries.filter((e) => e.entry.type !== "industrial" && e.facts.length > 0),
    industrial: entries.filter((e) => e.entry.type === "industrial" && e.facts.length > 0),
    projects,
    certifications: cv.certifications,
    education: cv.education,
    languages: cv.languages,
  };
}
