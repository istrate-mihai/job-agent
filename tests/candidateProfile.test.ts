// tests/candidateProfile.test.ts
import { describe, expect, it } from "vitest";
import { buildCandidateProfile } from "../src/profile/candidateProfile.js";
import { loadFixtureCv } from "./helpers.js";

describe("buildCandidateProfile", () => {
  const cv = loadFixtureCv();
  const profile = buildCandidateProfile(cv, new Date("2026-09-01"));

  it("never includes contact details sent to LLM providers", () => {
    for (const secret of [cv.basics.fullName, cv.basics.email, cv.basics.phone, cv.basics.links.github]) {
      expect(profile.text).not.toContain(secret);
    }
  });

  it("marks training-only skills as not professional experience", () => {
    expect(profile.text).toMatch(/In training only \(NOT professional experience\): Kubernetes, AWS/);
  });

  it("changes its hash when the CV changes", () => {
    const edited = { ...cv, summarySeeds: { ...cv.summarySeeds, fullstack: `${cv.summarySeeds.fullstack} Edited.` } };
    expect(buildCandidateProfile(edited, new Date("2026-09-01")).hash).not.toBe(profile.hash);
  });
});
