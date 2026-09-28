// tests/tailorPosting.test.ts
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SearchConfig } from "../src/config/searchConfig.js";
import { loadFixtureConfig, loadFixtureCv, postingRow, scriptedFetch, toolCallResponse } from "./helpers.js";

const usage = vi.hoisted(() => ({ tokensUsedToday: vi.fn(async () => 0), recordUsage: vi.fn(async () => undefined) }));
vi.mock("../src/llm/usage.js", () => usage);

const { availabilityFor, detectLanguage, tailorPosting } = await import("../src/tailoring/tailorPosting.js");

const cv = loadFixtureCv();
const DESCRIPTION = "We are hiring a full stack developer. Requirements: PHP, Laravel, Vue 3, MySQL, Docker. 3+ years of experience. ".repeat(4);
let config: SearchConfig;
beforeAll(async () => {
  config = await loadFixtureConfig();
});
afterEach(() => vi.unstubAllGlobals());

const goodLetter = [
  "I am applying for the Full Stack Developer position at Test Co, where the team builds its web platform with Laravel and Vue 3.",
  "At Acme Web SRL I optimized MySQL schemas and queries for analytics dashboards, improving query performance by 30%. On my Recipe Platform I shipped a production SaaS with Stripe subscriptions and PHPUnit feature tests.",
  "I would welcome a conversation about the role.",
];
const goodSummary =
  "Full-stack engineer building Laravel, Vue 3 and Node.js/Express applications, with 3 years in a professional full-stack role. Improved MySQL analytics query performance by 30% and ships containerized apps with Docker.";

function answer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    postingKeywords: ["PHP", "Laravel", "Vue 3"],
    roleFocus: "fullstack",
    experienceFactIds: ["acme-mysql", "acme-rest-apis"],
    projectIds: ["recipes", "agents"],
    projectFactIds: ["recipes-saas"],
    prioritySkills: ["Laravel", "Vue 3"],
    summary: goodSummary,
    coverLetter: goodLetter,
    ...overrides,
  };
}

describe("tailorPosting", () => {
  it("keeps only real CV ids, moves misplaced ones and normalizes skill names", async () => {
    const { fetchMock } = scriptedFetch([
      () =>
        toolCallResponse(
          "record_tailoring",
          answer({
            experienceFactIds: ["acme-mysql", "recipes-node", "made-up-fact"],
            projectIds: ["recipes", "fake-project"],
            prioritySkills: ["laravel", "AWS", "Vue 3"],
          }),
        ),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const r = await tailorPosting(postingRow({ description: DESCRIPTION }), null, cv, config, AbortSignal.timeout(10_000));

    const allIds = new Set([...cv.experience, ...cv.projects].flatMap((e) => e.facts.map((f) => f.id)));
    expect([...r.selection.experienceFactIds, ...r.selection.projectFactIds].every((id) => allIds.has(id))).toBe(true);
    expect(r.selection.projectFactIds).toContain("recipes-node"); // moved from the experience list
    expect(r.selection.projectIds).not.toContain("fake-project");
    expect(r.selection.prioritySkills).toEqual(["Laravel", "Vue 3"]); // AWS is training-only, "laravel" re-cased
    expect(r.notes.join(" ")).toMatch(/made-up-fact/);
    expect(r.warnings).toEqual([]);
  });

  it("rejects an invented claim and uses the corrected retry", async () => {
    const { fetchMock, calls } = scriptedFetch([
      () => toolCallResponse("record_tailoring", answer({ coverLetter: ["I built microservices with Java and Spring Boot for five years.", ...goodLetter.slice(1)] })),
      () => toolCallResponse("record_tailoring", answer()),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const r = await tailorPosting(postingRow({ description: DESCRIPTION }), null, cv, config, AbortSignal.timeout(10_000));
    const retryPrompt = (calls[1]?.["messages"] as { content: string }[])[1]?.content ?? "";
    expect(retryPrompt).toContain("was rejected");
    expect(r.coverLetter).toEqual(goodLetter);
    expect(r.warnings).toEqual([]);
  });

  it("falls back to the base summary and a safe letter when the model keeps inventing", async () => {
    const bad = answer({ summary: "Java expert with 12 years of microservices experience and deep expertise.", coverLetter: ["I have 12 years of Java experience.", "I am a Kubernetes expert on AWS."] });
    const { fetchMock } = scriptedFetch([() => toolCallResponse("record_tailoring", bad)]);
    vi.stubGlobal("fetch", fetchMock);
    const r = await tailorPosting(postingRow({ description: DESCRIPTION }), null, cv, config, AbortSignal.timeout(10_000));
    expect(r.summary).toBe(cv.summarySeeds.fullstack);
    expect(r.coverLetter.join(" ")).not.toMatch(/Java|Kubernetes/);
    expect(r.warnings.some((w) => w.includes("safe template"))).toBe(true);
  });

  it("tells the model not to assume anything for title-only postings", async () => {
    const { fetchMock, calls } = scriptedFetch([() => toolCallResponse("record_tailoring", answer())]);
    vi.stubGlobal("fetch", fetchMock);
    await tailorPosting(postingRow({ description: "" }), null, cv, config, AbortSignal.timeout(10_000));
    const system = (calls[0]?.["messages"] as { content: string }[])[0]?.content ?? "";
    expect(system).toContain("There is NO job description");
  });
});

describe("deterministic tailoring inputs", () => {
  it("decides the availability line from the location tier, not the model", () => {
    expect(availabilityFor(postingRow({ locationTier: "tierB", locationText: "Bucharest Metropolitan Area" }), config)).toBe("Available for relocation to București");
    expect(availabilityFor(postingRow({ locationTier: "remote", locationText: "Europe" }), config)).toBe("Available for remote work from Romania (EET)");
    expect(availabilityFor(postingRow({ locationTier: "tierA" }), config)).toBeNull();
  });

  it("detects Romanian postings", () => {
    expect(detectLanguage(postingRow({ description: "Căutăm un dezvoltator PHP. Cerințe: experiență cu Laravel și MySQL. Oferim beneficii." }))).toBe("ro");
    expect(detectLanguage(postingRow({ description: DESCRIPTION }))).toBe("en");
  });
});
