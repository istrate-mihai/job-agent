// src/scripts/importCv.ts
// Usage: npm run cv:import -- <cv.pdf|cv.docx|cv.txt>
// Builds data/master-cv.json from your existing CV. An existing master-cv.json is backed up first, never lost.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadSearchConfig } from "../config/searchConfig.js";
import { extractCvText, importCv } from "../cv/import.js";
import { LlmBlockedError } from "../runtime/guard.js";

const CV_FILE = resolve("data/master-cv.json");

async function main(): Promise<number> {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("Usage: npm run cv:import -- <path to your CV: .pdf, .docx or .txt>");
    return 1;
  }
  if (!existsSync(file)) {
    console.error(`File not found: ${file}`);
    return 1;
  }
  console.log(`Reading ${file}…`);
  const text = await extractCvText(file);
  console.log(`Structuring ${text.length.toLocaleString()} characters with AI (about a minute)…`);
  const config = await loadSearchConfig();
  const { cv, warnings, route } = await importCv(text, config, AbortSignal.timeout(300_000));

  mkdirSync("data", { recursive: true });
  if (existsSync(CV_FILE)) {
    const backup = resolve(`data/master-cv.backup-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`);
    copyFileSync(CV_FILE, backup);
    console.log(`Previous CV data backed up to ${backup}`);
  }
  writeFileSync(CV_FILE, `${JSON.stringify(cv, null, 2)}\n`, "utf8");

  const bullets = [...cv.experience, ...cv.projects].reduce((n, e) => n + e.facts.length, 0);
  console.log(`\n✔ Saved data/master-cv.json (${route})`);
  console.log(`  ${cv.basics.fullName} · ${cv.experience.length} jobs · ${cv.projects.length} projects · ${bullets} bullets · ${cv.skills.length} skills`);
  if (warnings.length > 0) {
    console.log(`\n⚠ Check these ${warnings.length} item(s) in data/master-cv.json:`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
  console.log("\nNext: review the file (the AI only restructured your CV, but you are the source of truth), then");
  console.log("  npm run validate:cv && npm run cv:base   → compare output/…_CV.pdf with your original");
  console.log("Tip: summarySeeds start identical; give each role focus (backend, frontend, ai…) its own angle for better tailoring.");
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof LlmBlockedError) console.error(`Stopped: ${err.message}`);
    else console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
