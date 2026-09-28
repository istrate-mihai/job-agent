// src/cv/fileNames.ts
// Application files: <Surname>_<Given names>_<Job_Title>_<Company>_CV.pdf / _Cover_Letter.pdf / _Cover_Letter.txt
import type { MasterCv } from "../schemas/masterCv.js";

/** Filesystem-safe, keeps capitals: "Senior AI Full Stack Developer (Python & React)" → "Senior_AI_Full_Stack_Developer_Python_React" */
export function fileSafe(value: string, max = 70): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max)
    .replace(/_+$/, "");
}

/** "Mihai Septimius Istrate" → "Istrate_Mihai_Septimius" (surname first), unless overridden in config. */
export function namePrefix(cv: MasterCv, override: string | null): string {
  if (override) return fileSafe(override);
  const parts = cv.basics.fullName.trim().split(/\s+/);
  const surname = parts.pop() ?? "";
  return fileSafe([surname, ...parts].join(" "));
}

export function applicationFileBase(prefix: string, jobTitle: string, company: string): string {
  return `${prefix}_${fileSafe(jobTitle) || "Role"}_${fileSafe(company, 40) || "Company"}`;
}

const WORK_MODE_OR_PLACE =
  /\b(hybrid|remote|on-?site|office|romania|bucharest|bucuresti|cluj|cluj-napoca|timisoara|iasi|brasov|sibiu|oradea|craiova|europe|emea|eu)\b/i;

/**
 * Job-board titles carry noise: "Software Engineer (Full Stack) - Flutter Studios, Hybrid & Remote",
 * "Full Stack Developer (m/f/d) Webshop Team, Bucharest (Romania)". Keeps the role, drops company,
 * location, work mode and gender markers. Used for file names and the letter's subject line.
 */
export function cleanJobTitle(title: string, company: string): string {
  const companyWord = company.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().split(/\s+/)[0] ?? "";
  const plain = (v: string): string => v.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const segments = title
    .replace(/\((?:[mfwdx]\s*\/\s*)+[mfwdx]\)/gi, " ") // (m/f/d), (f/m/d)
    .split(/\s+[-–|@]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const [first = title, ...rest] = segments;
  const kept = rest.filter((s) => !(companyWord && plain(s).includes(companyWord)) && !WORK_MODE_OR_PLACE.test(plain(s)));
  const withoutPlaces = [first, ...kept]
    .join(" - ")
    .split(",")
    .filter((part, i) => i === 0 || !WORK_MODE_OR_PLACE.test(plain(part)))
    .join(",");
  return withoutPlaces.replace(/\s{2,}/g, " ").replace(/\s+([,)])/g, "$1").trim() || title.trim();
}
