// src/scripts/validateCv.ts
import { readFile } from "node:fs/promises";
import { MasterCvSchema, type Fact } from "../schemas/masterCv.js";

const path = process.argv[2] ?? "data/master-cv.json";

const raw: unknown = JSON.parse(await readFile(path, "utf8"));
const result = MasterCvSchema.safeParse(raw);

if (!result.success) {
  console.error(`Invalid master CV (${path}):`);
  for (const issue of result.error.issues) {
    console.error(`  - ${issue.path.map(String).join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const cv = result.data;
const allFacts: Fact[] = [...cv.experience.flatMap((e) => e.facts), ...cv.projects.flatMap((p) => p.facts)];
let errors = 0;

// Fact ids must be globally unique, or provenance checks in Phase 3 become ambiguous
const seen = new Set<string>();
const duplicates = allFacts.filter((f) => (seen.has(f.id) ? true : (seen.add(f.id), false))).map((f) => f.id);
if (duplicates.length > 0) {
  console.error(`Duplicate fact ids: ${[...new Set(duplicates)].join(", ")}`);
  errors += 1;
}

const skillStatus = new Map(cv.skills.map((s) => [s.name.toLowerCase(), s.status]));
const undeclared = new Set<string>();
const trainingClaims: string[] = [];
for (const fact of allFacts) {
  for (const skill of fact.skills) {
    const status = skillStatus.get(skill.toLowerCase());
    if (status === undefined) undeclared.add(skill);
    if (status === "training") trainingClaims.push(`${fact.id} → ${skill}`);
  }
}
if (undeclared.size > 0) {
  console.error(`Skills used in facts but missing from skills[]: ${[...undeclared].join(", ")}`);
  errors += 1;
}
if (trainingClaims.length > 0) {
  // a fact claims hands-on use of a skill marked as still in training
  console.error(`Facts claiming training-only skills: ${trainingClaims.join("; ")}`);
  errors += 1;
}

if (errors > 0) process.exit(1);
console.log(`OK: ${allFacts.length} facts, ${cv.experience.length} roles, ${cv.projects.length} projects, ${cv.skills.length} skills`);
