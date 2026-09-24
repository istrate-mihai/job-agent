// src/profile/candidateProfile.ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { MasterCvSchema, type MasterCv } from "../schemas/masterCv.js";

export interface CandidateProfile {
  text: string; // compact, contact-free profile sent to the LLM
  hash: string; // changes whenever the CV content changes → stale scores are detectable
}

export async function loadMasterCv(path = "data/master-cv.json"): Promise<MasterCv> {
  return MasterCvSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

function monthsBetween(start: string, end: string | null, now: Date): number {
  const [sy, sm] = start.split("-").map(Number);
  const endDate = end === null ? { y: now.getFullYear(), m: now.getMonth() + 1 } : { y: Number(end.slice(0, 4)), m: Number(end.slice(5, 7)) };
  return Math.max(0, (endDate.y - (sy ?? 0)) * 12 + (endDate.m - (sm ?? 0)));
}

const ym = (v: string | null): string => (v === null ? "present" : `${v.slice(5, 7)}/${v.slice(0, 4)}`);

// ⚠ Security: no name, email, phone or links here; free-tier providers never receive contact data
export function buildCandidateProfile(cv: MasterCv, now: Date = new Date()): CandidateProfile {
  const softwareMonths = cv.experience
    .filter((e) => e.type === "software")
    .reduce((sum, e) => sum + monthsBetween(e.start, e.end, now), 0);

  const lines: string[] = [
    `Headline: ${cv.basics.headline}`,
    `Based in: ${cv.basics.location}. Open to remote; relocation: ${cv.basics.relocation.available ? cv.basics.relocation.cities.join(", ") : "no"}.`,
    `Professional software experience: ~${(softwareMonths / 12).toFixed(1)} years (plus independent projects since 05/2025 and 4+ years in manufacturing/quality).`,
    `Summary: ${cv.summarySeeds.fullstack}`,
    "",
    "Experience:",
    ...cv.experience.map(
      (e) =>
        `- ${e.title}, ${e.company} (${ym(e.start)}–${ym(e.end)}, ${e.type})${e.subtitle ? ` [${e.subtitle}]` : ""}: ${e.facts.map((f) => f.text).join(" ")}`,
    ),
    "",
    "Projects:",
    ...cv.projects.map((p) => `- ${p.name} [${p.stack.join(", ")}]: ${p.facts.map((f) => f.text).join(" ")}`),
    "",
    `Skills used in practice: ${cv.skills.filter((s) => s.status === "used").map((s) => s.name).join(", ")}`,
    `In training only (NOT professional experience): ${cv.skills.filter((s) => s.status === "training").map((s) => s.name).join(", ")}`,
    `Languages: ${cv.languages.map((l) => `${l.name} ${l.cefr}`).join(", ")}`,
    `Certifications: ${cv.certifications.map((c) => c.name).join(", ")}`,
  ];
  const text = lines.join("\n");
  return { text, hash: createHash("sha256").update(text).digest("hex") };
}
