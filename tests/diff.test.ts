// tests/diff.test.ts
import { describe, expect, it } from "vitest";
import { softwareYearsClaimed } from "../src/tailoring/diff.js";
import { loadFixtureCv } from "./helpers.js";

describe("softwareYearsClaimed", () => {
  const cv = loadFixtureCv();

  it("ignores CNC/quality years from the industrial seed", () => {
    const seeds = {
      ...cv.summarySeeds,
      fullstack: "Full-stack software engineer with 3 years of professional full-stack development experience.",
      backend: "Backend-focused engineer with 3 years in a professional full-stack role.",
      ai: "Builds LLM-powered systems, combined with 3 years of professional full-stack experience.",
      industrial: "Software engineer bridging manufacturing and software, with 4+ years of CNC and quality experience.",
    };
    expect(softwareYearsClaimed(seeds)).toBe(3);
  });

  it("reads both 'N years' and 'N+ years'", () => {
    expect(softwareYearsClaimed({ ...cv.summarySeeds, fullstack: "Engineer with 5+ years of software development." })).toBe(5);
  });

  it("returns 0 when no software seed states years", () => {
    const noYears = Object.fromEntries(Object.keys(cv.summarySeeds).map((r) => [r, "Software engineer."])) as typeof cv.summarySeeds;
    expect(softwareYearsClaimed({ ...noYears, industrial: "With 4+ years of CNC experience." })).toBe(0);
  });
});
