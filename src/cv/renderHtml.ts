// src/cv/renderHtml.ts
// ATS-safe single-column layout: real text, no tables for content, links kept as <a>.
import type { CvView } from "./view.js";

const esc = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const bare = (url: string): string => url.replace(/^https?:\/\//, "").replace(/\/$/, "");
const link = (url: string, label?: string): string => `<a href="${esc(url)}">${esc(label ?? bare(url))}</a>`;
const ym = (v: string | null): string => (v === null ? "Present" : `${v.slice(5, 7)}/${v.slice(0, 4)}`);

const CEFR_LABELS: Readonly<Record<string, string>> = {
  native: "Native",
  C2: "C2, proficient",
  C1: "C1, advanced",
  B2: "B2, professional working proficiency",
  B1: "B1, intermediate",
  A2: "A2, elementary",
  A1: "A1",
};

const CSS = `
@page { size: A4; margin: 13mm 16mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Calibri, Carlito, "Segoe UI", Arial, sans-serif; font-size: 10.3pt; line-height: 1.27; color: #1a1a1a; }
a { color: #1a56b0; }
.header { display: flex; gap: 5mm; align-items: center; }
.header img { width: 26mm; height: auto; }
.name { font-size: 22pt; font-weight: 700; margin: 0; line-height: 1.1; letter-spacing: 0.2pt; }
.headline { font-size: 12pt; font-weight: 700; margin: 1pt 0 3pt; }
.contact { margin: 0; }
h2 { font-size: 12.5pt; text-transform: uppercase; margin: 8pt 0 4pt; padding-bottom: 1pt; border-bottom: 0.8pt solid #1a1a1a; break-after: avoid; }
.entry, .keep { break-inside: avoid; }
.entry { margin-top: 4pt; }
.row { display: flex; justify-content: space-between; gap: 4mm; font-weight: 700; }
.row .date { white-space: nowrap; }
.sub { font-style: italic; color: #555; }
ul { margin: 1pt 0 0; padding-left: 12pt; }
li { margin-top: 1pt; }
.skills p, .small { margin: 0; font-size: 10pt; line-height: 1.24; }
`;

/** Heading travels with its first block, so a page never ends on an orphaned heading. */
function section(title: string, blocks: string[]): string {
  if (blocks.length === 0) return "";
  const [first, ...rest] = blocks;
  return `<div class="keep"><h2>${title}</h2>${first ?? ""}</div>${rest.join("")}`;
}

function entryBlocks(items: CvView["experience"]): string[] {
  return items.map(
    ({ entry, facts }) => `
  <div class="entry">
    <div class="row"><span>${esc(entry.title)}, ${esc(entry.company)}, ${esc(entry.location)}</span><span class="date">${ym(entry.start)} – ${ym(entry.end)}</span></div>
    ${entry.subtitle ? `<div class="sub">${esc(entry.subtitle)}</div>` : ""}
    <ul>${facts.map((f) => `<li>${esc(f.text)}</li>`).join("")}</ul>
  </div>`,
  );
}

export function renderCvHtml(view: CvView, photoDataUri: string | null): string {
  const b = view.basics;
  const links = [
    b.links.linkedin ? link(b.links.linkedin) : null,
    link(b.links.github),
    b.links.portfolio ? link(b.links.portfolio, "Portfolio") : null,
  ].filter((l): l is string => l !== null);

  const skills = view.skillLines
    .map((l) => {
      const training = l.training.length > 0 ? `${l.used.length > 0 ? "; " : ""}in training: ${esc(l.training.join(", "))}` : "";
      return `<p><b>${esc(l.label)}:</b> ${esc(l.used.join(", "))}${training}</p>`;
    })
    .join("");

  const projects = view.projects.map(({ project, facts }) => {
    const urls = [project.liveUrl, project.repoUrl].filter((u): u is string => u !== undefined).map((u) => link(u));
    return `
  <div class="entry">
    <div><b>${esc(project.name)}</b> | ${esc(project.stack.join(", "))}</div>
    ${urls.length > 0 ? `<div class="small">${urls.join(" | ")}</div>` : ""}
    <ul>${facts.map((f) => `<li>${esc(f.text)}</li>`).join("")}</ul>
  </div>`;
  });

  const certifications = view.certifications.map((c) => {
    const id = c.credentialId ? ` | ID: ${esc(c.credentialId)}` : "";
    const url = c.url ? ` | ${link(c.url, "View certificate")}` : "";
    return `<div class="entry"><b>${esc(c.name)}</b>, ${esc(c.issuer)}${id}${url}</div>`;
  });

  const education = view.education.map((e) => {
    const loc = e.location ? `, ${esc(e.location)}` : "";
    const url = e.url ? ` | ${link(e.url, "View certificate")}` : "";
    return `
  <div class="entry">
    <div class="row"><span>${esc(e.program)}, ${esc(e.institution)}${loc}</span><span class="date">${ym(e.start)} – ${ym(e.end)}</span></div>
    ${e.details || url ? `<div class="small">${esc(e.details ?? "")}${url}</div>` : ""}
  </div>`;
  });

  const languages = view.languages.map((l) => `<b>${esc(l.name)}:</b> ${esc(CEFR_LABELS[l.cefr] ?? l.cefr)}`).join(" | ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(b.fullName)} — ${esc(b.headline.split("|")[0]?.trim() ?? "CV")}</title>
<style>${CSS}</style>
</head>
<body>
  <div class="header">
    ${photoDataUri ? `<img src="${photoDataUri}" alt="">` : ""}
    <div>
      <p class="name">${esc(b.fullName.toUpperCase())}</p>
      <p class="headline">${esc(b.headline)}</p>
      <p class="contact">${esc(b.location)} | ${esc(b.phone)} | <a href="mailto:${esc(b.email)}">${esc(b.email)}</a></p>
      <p class="contact">${links.join(" | ")}</p>
      ${view.availability ? `<p class="contact">${esc(view.availability)}</p>` : ""}
    </div>
  </div>

  ${section("Professional Summary", [`<p class="contact">${esc(view.summary)}</p>`])}
  ${section("Technical Skills", [`<div class="skills">${skills}</div>`])}
  ${section("Software Experience", entryBlocks(view.experience))}
  ${section("Projects", projects)}
  ${section("Industrial Experience", entryBlocks(view.industrial))}
  ${section("Certifications &amp; Education", [...certifications, ...education])}
  ${section("Languages", [`<p class="contact">${languages}</p>`])}
</body>
</html>`;
}
