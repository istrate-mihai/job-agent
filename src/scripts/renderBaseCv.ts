// src/scripts/renderBaseCv.ts
// Renders the untailored CV from master-cv.json: the "base" every tailored CV is compared against.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSearchConfig } from "../config/searchConfig.js";
import { renderFittedCv } from "../cv/renderPdf.js";
import { baseSelection } from "../cv/view.js";
import { loadMasterCv } from "../profile/candidateProfile.js";

const BASE_AVAILABILITY = "Open to remote roles and to relocation within Romania";

const config = await loadSearchConfig();
const cv = await loadMasterCv();
const fileName = `${cv.basics.fullName.replace(/\s+/g, "_")}_CV.pdf`;
const outDir = join(config.tailoring.outputDir, "..");
const outPath = join(outDir, fileName);

const rendered = await renderFittedCv(cv, baseSelection(cv), cv.summarySeeds.fullstack, BASE_AVAILABILITY, {
  maxPages: config.tailoring.maxPages,
  photoPath: config.tailoring.photoPath,
  title: `${cv.basics.fullName} — CV`,
});

await mkdir(outDir, { recursive: true });
await writeFile(outPath, rendered.pdf);
console.log(`Base CV: ${outPath} (${rendered.pages} page${rendered.pages === 1 ? "" : "s"})`);
if (rendered.trims.length > 0) console.log(`Trimmed to fit ${config.tailoring.maxPages} pages: ${rendered.trims.join("; ")}`);
