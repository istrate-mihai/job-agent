// tests/outreach.test.ts
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SearchConfig } from "../src/config/searchConfig.js";
import { validateLetterStyle } from "../src/tailoring/validate.js";
import { loadFixtureConfig, loadFixtureCv, postingRow, scriptedFetch, toolCallResponse } from "./helpers.js";

const usage = vi.hoisted(() => ({ tokensUsedToday: vi.fn(async () => 0), recordUsage: vi.fn(async () => undefined) }));
vi.mock("../src/llm/usage.js", () => usage);

const { composeOutreach, followUpMessage, recruiterSearchLinks, validateOutreach, CONNECT_MAX_CHARS } = await import("../src/outreach/compose.js");
const { buildMime } = await import("../src/outreach/gmailDraft.js");

const cv = loadFixtureCv();
const DESCRIPTION = "We are hiring a full stack developer. Requirements: PHP, Laravel, Vue 3, MySQL, Docker. 3+ years of experience. ".repeat(4);
let config: SearchConfig;
beforeAll(async () => {
  config = await loadFixtureConfig();
});
afterEach(() => vi.unstubAllGlobals());

const good = {
  connectionNote: "Hello, I am applying for the Full Stack Developer role at Test Co. I built Laravel and Vue 3 apps and improved MySQL query performance by 30%.",
  linkedinMessage:
    "Hello, I applied for the Full Stack Developer role at Test Co. At Acme Web SRL I optimized MySQL queries for analytics dashboards, improving performance by 30%, and I shipped a production SaaS with Laravel and Vue 3. Would a short call this week work to see if my profile fits the team?",
  emailSubject: "Full Stack Developer application — Laravel/Vue 3",
  emailBody:
    "Hello,\n\nI am applying for the Full Stack Developer role at Test Co. At Acme Web SRL I optimized MySQL queries for analytics dashboards, improving performance by 30%, and on my Recipe Platform I shipped a production SaaS with Laravel and Vue 3.\n\nMy CV is attached. I would welcome a short call.\n\nBest regards,\nTest Candidate",
};

describe("validateLetterStyle", () => {
  it("rejects third person, gap confessions and clichés", () => {
    const problems = validateLetterStyle([
      "The candidate designed and scaled RESTful APIs in PHP.",
      "The posting requires a bachelor's degree, which is not present in the CV.",
      "I am excited to apply because this is a perfect fit.",
    ]);
    expect(problems.some((p) => p.includes("third person"))).toBe(true);
    expect(problems.some((p) => p.includes("unmet requirement"))).toBe(true);
    expect(problems.some((p) => p.includes("cliché"))).toBe(true);
  });

  it("accepts a factual first-person letter", () => {
    expect(validateLetterStyle(["At Acme Web SRL I optimized MySQL queries, improving performance by 30%.", "I would welcome a conversation."])).toEqual([]);
  });
});

describe("outreach", () => {
  it("validates claims and LinkedIn limits", () => {
    const posting = postingRow({ description: DESCRIPTION });
    expect(validateOutreach(good, cv, posting)).toEqual([]);
    const bad = validateOutreach({ ...good, connectionNote: `${"x".repeat(CONNECT_MAX_CHARS)} Kubernetes expert with 9 years.` }, cv, posting);
    expect(bad.some((p) => p.includes("LinkedIn max"))).toBe(true);
    expect(bad.some((p) => p.includes('"9"'))).toBe(true);
  });

  it("repairs a draft that invents a technology", async () => {
    const { fetchMock, calls } = scriptedFetch([
      () => toolCallResponse("record_outreach", { ...good, linkedinMessage: `${good.linkedinMessage} I also run Kafka clusters in production.` }),
      () => toolCallResponse("record_outreach", good),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const d = await composeOutreach(postingRow({ description: DESCRIPTION, status: "applied" }), null, null, cv, config, { name: "Ana Pop", role: "recruiter" }, null, AbortSignal.timeout(10_000));
    expect(calls.length).toBe(2);
    expect(d.linkedinMessage).not.toContain("Kafka");
    expect(d.warnings).toEqual([]);
    expect(String((calls[0]?.messages as { content: string }[] | undefined)?.[0]?.content ?? "")).toContain("ALREADY applied");
  });

  it("builds search links and follow-ups without inventing anything", () => {
    const links = recruiterSearchLinks('Test "Co"', "Senior DevOps Engineer");
    expect(links.every((l) => l.url.startsWith("https://"))).toBe(true);
    expect(links.some((l) => decodeURIComponent(l.url).includes("DevOps engineering manager"))).toBe(true);
    const ro = followUpMessage(postingRow({ title: "Dezvoltator PHP", description: "Căutăm un dezvoltator cu experiență în PHP și cunoștințe de MySQL pentru echipa noastră." }), cv, 8, "Ana Pop");
    expect(ro.body).toContain("Bună ziua, Ana");
    expect(ro.body).toContain("8 zile");
  });

  it("builds a safe MIME draft and refuses header injection", async () => {
    const mime = await buildMime({ to: "ana@firma.ro", subject: "Candidatură — Dezvoltator\r\nBcc: evil@x.com", body: "Bună ziua", attachments: [] });
    expect(mime).toContain("To: ana@firma.ro");
    expect(mime).not.toMatch(/^Bcc:/m);
    expect(mime).toContain("=?UTF-8?B?");
    await expect(buildMime({ to: "ana@firma.ro\r\nBcc: x@y.z", subject: "s", body: "b", attachments: [] })).rejects.toThrow(/Invalid recipient/);
  });
});
