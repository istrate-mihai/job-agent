// tests/importCv.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SearchConfig } from "../src/config/searchConfig.js";
import { MasterCvSchema } from "../src/schemas/masterCv.js";
import { loadFixtureConfig, scriptedFetch, toolCallResponse } from "./helpers.js";

const usage = vi.hoisted(() => ({ tokensUsedToday: vi.fn(async () => 0), recordUsage: vi.fn(async () => undefined) }));
vi.mock("../src/llm/usage.js", () => usage);
const { ImportSchema, extractCvText, importCv, normalizeYearMonth, toMasterCv } = await import("../src/cv/import.js");

const SOURCE = `Ana Maria Ionescu
Full-Stack Developer · Cluj-Napoca · ana.ionescu@example.com · +40 711 111 111 · linkedin.com/in/ana-ionescu
EXPERIENCE
Web Developer, Pixel SRL, Cluj-Napoca, 03/2021 – present
- Built REST APIs in Laravel for 12 client projects
- Reduced page load time by 40% by optimizing MySQL queries and caching
Junior Developer, Code Shop, 2019 – 2021
- Maintained Vue.js dashboards for internal reporting tools
SKILLS: PHP, Laravel, MySQL, Vue.js, Docker; learning Kubernetes
EDUCATION: Babeș-Bolyai University, Computer Science, 2015 – 2019
LANGUAGES: Romanian (native), English (fluent)`;

const LLM = {
  basics: { fullName: "Ana Maria Ionescu", headline: "Full-Stack Developer", email: "ana.ionescu@example.com", phone: "+40 711 111 111", location: "Cluj-Napoca", linkedin: "linkedin.com/in/ana-ionescu" },
  summary: "Full-stack developer building Laravel APIs and Vue.js dashboards, with MySQL performance work.",
  experience: [
    { company: "Pixel SRL", title: "Web Developer", location: "Cluj-Napoca", start: "03/2021", end: "present", kind: "software", stack: "PHP, Laravel, MySQL", bullets: [
      { text: "Built REST APIs in Laravel for 12 client projects", skills: ["Laravel", "REST API"] },
      { text: "Reduced page load time by 40% by optimizing MySQL queries and caching", skills: ["MySQL"] },
    ] },
    { company: "Code Shop", title: "Junior Developer", start: "2019", end: "2021", kind: "software", bullets: [{ text: "Maintained Vue.js dashboards for internal reporting tools", skills: [] }] },
  ],
  skills: [{ name: "PHP", category: "languages" }, { name: "Laravel", category: "backend" }, { name: "MySQL", category: "databases" }, { name: "Vue.js", category: "frontend" }, { name: "Docker", category: "devops" }, { name: "Kubernetes", category: "devops", inTraining: true }],
  education: [{ institution: "Babeș-Bolyai University", program: "Computer Science", start: "2015", end: "2019" }],
  languages: [{ name: "Romanian", level: "native" }, { name: "English", level: "fluent" }],
};

let config: SearchConfig;
beforeAll(async () => {
  config = await loadFixtureConfig();
});
afterEach(() => vi.unstubAllGlobals());

describe("normalizeYearMonth", () => {
  it.each([
    ["03/2021", "2021-03"],
    ["2022-7", "2022-07"],
    ["Jul 2022", "2022-07"],
    ["2019", "2019-01"],
    ["present", null],
    ["", null],
  ])("%s → %s", (raw, expected) => expect(normalizeYearMonth(raw)).toBe(expected));
});

describe("CV import", () => {
  it("builds a schema-valid master CV and keeps training skills apart", async () => {
    const { fetchMock } = scriptedFetch([() => toolCallResponse("record_cv", LLM)]);
    vi.stubGlobal("fetch", fetchMock);
    const { cv, warnings } = await importCv(SOURCE, config, AbortSignal.timeout(10_000));
    expect(MasterCvSchema.safeParse(cv).success).toBe(true);
    expect(cv.experience[0]?.end).toBeNull();
    expect(cv.experience[0]?.start).toBe("2021-03");
    expect(cv.basics.links.linkedin).toBe("https://linkedin.com/in/ana-ionescu");
    expect(cv.basics.links.github).toBeUndefined();
    expect(cv.skills.find((s) => s.name === "Kubernetes")?.status).toBe("training");
    expect(cv.languages.find((l) => l.name === "English")?.cefr).toBe("C1");
    expect(cv.experience[1]?.facts[0]?.skills).toContain("Vue.js"); // derived from the skills list
    expect(new Set([...cv.experience, ...cv.projects].flatMap((e) => e.facts.map((f) => f.id))).size).toBe(3);
    expect(warnings).toEqual([]);
  });

  it("flags numbers and bullets that are not in the original CV", () => {
    const invented = structuredClone(LLM) as { experience: { bullets: { text: string; skills: string[] }[] }[] } & typeof LLM;
    invented.experience[0]!.bullets.push({ text: "Led a team of 9 engineers delivering a Kubernetes migration across regions", skills: ["Kubernetes"] });
    const { warnings } = toMasterCv(ImportSchema.parse(invented), SOURCE, []);
    expect(warnings.some((w) => w.includes('"9"'))).toBe(true);
  });

  it("extracts text from PDF and TXT and rejects empty files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cv-"));
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage();
    SOURCE.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[–·]/g, "-").split("\n").forEach((line, i) => page.drawText(line, { x: 30, y: 800 - i * 14, size: 9, font }));
    writeFileSync(join(dir, "cv.pdf"), await pdf.save());
    writeFileSync(join(dir, "cv.txt"), SOURCE);
    writeFileSync(join(dir, "empty.txt"), "Ana");
    expect(await extractCvText(join(dir, "cv.pdf"))).toContain("Pixel SRL");
    expect(await extractCvText(join(dir, "cv.txt"))).toContain("Babeș-Bolyai");
    await expect(extractCvText(join(dir, "empty.txt"))).rejects.toThrow(/Almost no text/);
    await expect(extractCvText(join(dir, "cv.odt"))).rejects.toThrow(/Unsupported/);
  });
});
