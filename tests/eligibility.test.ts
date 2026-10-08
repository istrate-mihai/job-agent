// tests/eligibility.test.ts
import { describe, expect, it } from "vitest";
import { checkEligibility, requiredYears } from "../src/filter/eligibility.js";
import { hardFilter } from "../src/filter/hardFilter.js";
import { loadFixtureConfig, normalizedPosting } from "./helpers.js";

describe("checkEligibility", () => {
  it.each([
    "This position is open to residents of USA & Canada only.",
    "Candidates must be located in the United States.",
    "You must reside in the US to be considered.",
    "Must be US-based. Remote.",
    "US citizens only due to contract requirements.",
    "Requires an active security clearance.",
  ])("blocks: %s", (text) => {
    expect(checkEligibility(text).blocked).not.toBeNull();
  });

  it.each([
    "Remote within EMEA. We hire in Romania, Poland and Portugal.",
    "Locație: Brașov, program hibrid.",
    "Our customers are in the US and Canada; the team is fully remote in Europe.",
  ])("allows: %s", (text) => {
    expect(checkEligibility(text).blocked).toBeNull();
  });

  it("flags US work-authorization boilerplate without blocking", () => {
    const r = checkEligibility("Applicants must be authorized to work in the United States. Remote OK.");
    expect(r.blocked).toBeNull();
    expect(r.flags[0]).toMatch(/^eligibility-check:/);
  });
});

describe("requiredYears", () => {
  it.each([
    ["Requirements: 5+ years of professional experience with PHP.", 5],
    ["At least 6 years experience in backend development", 6],
    ["Minim 3 ani experienta in dezvoltare web", 3],
    ["4-6 years of experience with React; 2 years with Node.js", 4],
  ])("%s → %d", (text, years) => {
    expect(requiredYears(text)).toBe(years);
  });

  it("ignores nice-to-haves and company boilerplate", () => {
    expect(requiredYears("Nice to have: 8+ years of experience with Kafka.")).toBeNull();
    expect(requiredYears("We have 20 years of experience in the automotive market.")).toBeNull();
    expect(requiredYears("Founded in 2005, the company has over 15 years of experience.")).toBeNull();
  });
});

describe("hardFilter eligibility", () => {
  it("rejects a USA/Canada-only remote posting and records required years", async () => {
    const config = await loadFixtureConfig();
    const r = hardFilter(
      normalizedPosting({
        workMode: "remote",
        locationText: "Remote",
        description: "Open to residents of USA & Canada only. 7+ years of experience with React.",
      }),
      config,
    );
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith("eligibility-excluded:"))).toBe(true);
    expect(r.flags).toContain("years-required:7");
  });
});
