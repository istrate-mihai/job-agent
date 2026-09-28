// src/cv/renderLetter.ts
// Cover letter as PDF (same visual identity as the CV) and as plain text with Windows line endings.
import type { MasterCv } from "../schemas/masterCv.js";
import { htmlToPdf, launchBrowser } from "./renderPdf.js";

export interface LetterInput {
  basics: MasterCv["basics"];
  company: string;
  jobTitle: string;
  paragraphs: string[]; // body only; greeting and sign-off are added here
  language: "en" | "ro";
  date: Date;
}

const esc = (v: string): string => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const bare = (url: string): string => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

function words(language: LetterInput["language"]) {
  return language === "ro"
    ? { greeting: "Stimată echipă de recrutare,", closing: "Cu stimă,", subject: "Candidatură", team: "Echipa de recrutare" }
    : { greeting: "Dear Hiring Team,", closing: "Kind regards,", subject: "Application", team: "Hiring Team" };
}

function formatDate(date: Date, language: LetterInput["language"]): string {
  return date.toLocaleDateString(language === "ro" ? "ro-RO" : "en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/** Plain text with CRLF, so Notepad and web forms keep the paragraphs. */
export function letterText(l: LetterInput): string {
  const w = words(l.language);
  const lines = [
    l.basics.fullName,
    `${l.basics.location} | ${l.basics.phone} | ${l.basics.email}`,
    "",
    formatDate(l.date, l.language),
    `${w.team}, ${l.company}`,
    "",
    `${w.subject}: ${l.jobTitle}`,
    "",
    w.greeting,
    "",
    ...l.paragraphs.flatMap((p) => [p, ""]),
    w.closing,
    l.basics.fullName,
    "",
  ];
  return lines.join("\r\n");
}

export function renderLetterHtml(l: LetterInput): string {
  const w = words(l.language);
  const b = l.basics;
  const links = [b.links.linkedin, b.links.github, b.links.portfolio].filter((u): u is string => Boolean(u));
  return `<!doctype html>
<html lang="${l.language}">
<head>
<meta charset="utf-8">
<title>${esc(b.fullName)} — Cover Letter — ${esc(l.jobTitle)}</title>
<style>
@page { size: A4; margin: 18mm 20mm; }
body { margin: 0; font-family: Calibri, Carlito, "Segoe UI", Arial, sans-serif; font-size: 11pt; line-height: 1.4; color: #1a1a1a; }
a { color: #1a56b0; }
.name { font-size: 20pt; font-weight: 700; margin: 0; letter-spacing: 0.2pt; }
.headline { font-size: 11.5pt; font-weight: 700; margin: 1pt 0 3pt; }
.contact { margin: 0; font-size: 10.3pt; }
hr { border: 0; border-top: 0.8pt solid #1a1a1a; margin: 8pt 0 14pt; }
.meta { margin: 0 0 12pt; }
.subject { font-weight: 700; margin: 0 0 12pt; }
p.body { margin: 0 0 10pt; text-align: left; }
.sign { margin-top: 14pt; }
</style>
</head>
<body>
  <p class="name">${esc(b.fullName.toUpperCase())}</p>
  <p class="headline">${esc(b.headline)}</p>
  <p class="contact">${esc(b.location)} | ${esc(b.phone)} | <a href="mailto:${esc(b.email)}">${esc(b.email)}</a></p>
  <p class="contact">${links.map((u) => `<a href="${esc(u)}">${esc(bare(u))}</a>`).join(" | ")}</p>
  <hr>
  <p class="meta">${esc(formatDate(l.date, l.language))}<br>${esc(w.team)}, ${esc(l.company)}</p>
  <p class="subject">${esc(w.subject)}: ${esc(l.jobTitle)}</p>
  <p class="body">${esc(w.greeting)}</p>
  ${l.paragraphs.map((p) => `<p class="body">${esc(p)}</p>`).join("\n  ")}
  <p class="sign">${esc(w.closing)}<br>${esc(b.fullName)}</p>
</body>
</html>`;
}

export async function renderLetterPdf(l: LetterInput): Promise<{ pdf: Uint8Array; pages: number }> {
  const browser = await launchBrowser();
  try {
    return await htmlToPdf(browser, renderLetterHtml(l), { title: `${l.basics.fullName} — Cover Letter — ${l.jobTitle}`, author: l.basics.fullName });
  } finally {
    await browser.close();
  }
}
