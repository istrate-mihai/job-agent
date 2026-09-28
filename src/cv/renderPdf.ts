// src/cv/renderPdf.ts
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { PDFDocument } from "pdf-lib";
import { chromium, type Browser } from "playwright";
import type { TailoringSelection } from "../db/schema.js";
import type { MasterCv } from "../schemas/masterCv.js";
import { renderCvHtml } from "./renderHtml.js";
import { buildView } from "./view.js";

export interface RenderedCv {
  pdf: Uint8Array;
  pages: number;
  selection: TailoringSelection; // after trimming
  trims: string[];
}

export interface RenderOptions {
  maxPages: number;
  photoPath: string | null;
  title: string; // PDF metadata title
}

type Trim = { label: string; apply: (s: TailoringSelection, cv: MasterCv) => TailoringSelection | null };

const factsOf = (cv: MasterCv, type: "industrial" | "software"): Map<string, string[]> =>
  new Map(
    cv.experience
      .filter((e) => (type === "industrial" ? e.type === "industrial" : e.type !== "industrial"))
      .map((e) => [e.id, e.facts.map((f) => f.id)]),
  );

/** Keep at most `max` selected facts per group (selection order decides which survive). */
function capPerGroup(ids: readonly string[], groups: Map<string, string[]>, max: number): string[] {
  const kept: string[] = [];
  const counts = new Map<string, number>();
  for (const id of ids) {
    const group = [...groups.entries()].find(([, members]) => members.includes(id))?.[0];
    if (group === undefined) {
      kept.push(id); // fact outside these groups: untouched
      continue;
    }
    const n = counts.get(group) ?? 0;
    if (n < max) kept.push(id);
    counts.set(group, n + 1);
  }
  return kept;
}

// Least relevant content goes first; each step returns null when it would change nothing
const TRIMS: Trim[] = [
  {
    label: "industrial roles cut to 1 bullet each",
    apply: (s, cv) => {
      const next = capPerGroup(s.experienceFactIds, factsOf(cv, "industrial"), 1);
      return next.length < s.experienceFactIds.length ? { ...s, experienceFactIds: next } : null;
    },
  },
  {
    label: "projects cut to 3",
    apply: (s) => (s.projectIds.length > 3 ? { ...s, projectIds: s.projectIds.slice(0, 3) } : null),
  },
  {
    label: "project bullets cut to 2 each",
    apply: (s, cv) => {
      const groups = new Map(cv.projects.map((p) => [p.id, p.facts.map((f) => f.id)]));
      const next = capPerGroup(s.projectFactIds, groups, 2);
      return next.length < s.projectFactIds.length ? { ...s, projectFactIds: next } : null;
    },
  },
  {
    label: "software roles cut to 3 bullets each",
    apply: (s, cv) => {
      const next = capPerGroup(s.experienceFactIds, factsOf(cv, "software"), 3);
      return next.length < s.experienceFactIds.length ? { ...s, experienceFactIds: next } : null;
    },
  },
  {
    label: "projects cut to 2",
    apply: (s) => (s.projectIds.length > 2 ? { ...s, projectIds: s.projectIds.slice(0, 2) } : null),
  },
];

async function photoDataUri(path: string | null): Promise<string | null> {
  if (path === null) return null;
  try {
    const bytes = await readFile(path);
    const mime = extname(path).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return null; // missing photo is not an error: the CV renders without it
  }
}

export async function htmlToPdf(browser: Browser, html: string, meta: { title: string; author: string }): Promise<{ pdf: Uint8Array; pages: number }> {
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    const raw = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
    const doc = await PDFDocument.load(raw);
    doc.setTitle(meta.title);
    doc.setAuthor(meta.author);
    doc.setCreator("job-agent");
    return { pdf: await doc.save(), pages: doc.getPageCount() };
  } finally {
    await page.close();
  }
}

/**
 * Browser choice, first match wins:
 * 1. CHROMIUM_EXECUTABLE_PATH (.env) → that executable
 * 2. CV_BROWSER_CHANNEL (.env: msedge | chrome) → the installed Edge/Chrome, no download needed
 * 3. Playwright's own Chromium (npx playwright install chromium)
 * 4. Windows only: fall back to Microsoft Edge, which ships with Windows 10/11
 */
export async function launchBrowser(): Promise<Browser> {
  const executablePath = process.env["CHROMIUM_EXECUTABLE_PATH"];
  if (executablePath) return chromium.launch({ executablePath });
  const channel = process.env["CV_BROWSER_CHANNEL"];
  if (channel) return chromium.launch({ channel });

  try {
    return await chromium.launch();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (process.platform !== "win32" || !/Executable doesn't exist/i.test(message)) throw err;
    try {
      return await chromium.launch({ channel: "msedge" });
    } catch (edgeErr: unknown) {
      const edgeMessage = edgeErr instanceof Error ? edgeErr.message.split("\n")[0] : String(edgeErr);
      throw new Error(
        `No browser for PDF rendering. Playwright's Chromium is not installed and Edge failed (${edgeMessage}). ` +
          "Set CV_BROWSER_CHANNEL=chrome in .env if Google Chrome is installed, or run: npx playwright install chromium",
      );
    }
  }
}

/** Renders the CV and trims the least relevant content until it fits `maxPages`. */
export async function renderFittedCv(
  cv: MasterCv,
  selection: TailoringSelection,
  summary: string,
  availability: string | null,
  opts: RenderOptions,
): Promise<RenderedCv> {
  const photo = await photoDataUri(opts.photoPath);
  const browser = await launchBrowser();
  const meta = { title: opts.title, author: cv.basics.fullName };

  try {
    let current = selection;
    const trims: string[] = [];
    let rendered = await htmlToPdf(browser, renderCvHtml(buildView(cv, current, summary, availability), photo), meta);

    for (const trim of TRIMS) {
      if (rendered.pages <= opts.maxPages) break;
      const next = trim.apply(current, cv);
      if (next === null) continue;
      current = next;
      trims.push(trim.label);
      rendered = await htmlToPdf(browser, renderCvHtml(buildView(cv, current, summary, availability), photo), meta);
    }
    return { ...rendered, selection: current, trims };
  } finally {
    await browser.close();
  }
}
