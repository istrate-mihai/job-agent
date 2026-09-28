// tests/hardFilter.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import type { SearchConfig } from "../src/config/searchConfig.js";
import { hardFilter } from "../src/filter/hardFilter.js";
import { loadFixtureConfig, normalizedPosting } from "./helpers.js";

const DAY_MS = 86_400_000;
let config: SearchConfig;
beforeAll(async () => {
  config = await loadFixtureConfig();
});

describe("hardFilter: location tiers", () => {
  it("home city is tier A", () => {
    const r = hardFilter(normalizedPosting({ locationText: "Brașov, Romania" }), config);
    expect(r).toMatchObject({ pass: true, tier: "tierA" });
  });

  it("relocation city is tier B and flagged, matching aliases without diacritics", () => {
    const r = hardFilter(normalizedPosting({ locationText: "Bucharest Metropolitan Area" }), config);
    expect(r.tier).toBe("tierB");
    expect(r.flags).toContain("relocation");
  });

  it("accepts remote roles open to Europe and rejects US-only ones", () => {
    expect(hardFilter(normalizedPosting({ workMode: "remote", locationText: "Europe", remoteScope: "Europe" }), config).tier).toBe("remote");
    const us = hardFilter(normalizedPosting({ workMode: "remote", locationText: "USA Only", remoteScope: "USA Only" }), config);
    expect(us.pass).toBe(false);
    expect(us.reasons[0]).toMatch(/^remote-scope-excluded/);
  });

  it("rejects cities outside the targets", () => {
    const r = hardFilter(normalizedPosting({ locationText: "Munich, Germany", workMode: "onsite" }), config);
    expect(r.reasons[0]).toMatch(/^location-outside-targets/);
  });
});

describe("hardFilter: titles", () => {
  it("excludes interns but not 'internal' tools roles", () => {
    expect(hardFilter(normalizedPosting({ title: "Frontend Intern" }), config).reasons).toContain("title-excluded:intern");
    expect(hardFilter(normalizedPosting({ title: "Internal Tools Web Developer" }), config).pass).toBe(true);
  });

  it("flags senior titles instead of rejecting them", () => {
    const r = hardFilter(normalizedPosting({ title: "Senior Full Stack Developer" }), config);
    expect(r.pass).toBe(true);
    expect(r.flags).toContain("title-senior");
  });

  it("matches Romanian titles", () => {
    expect(hardFilter(normalizedPosting({ title: "Dezvoltator PHP" }), config).pass).toBe(true);
  });
});

describe("hardFilter: age", () => {
  const old = new Date(Date.now() - 60 * DAY_MS);

  it("rejects stale job-board postings", () => {
    expect(hardFilter(normalizedPosting({ source: "jobicy", postedAt: old }), config).reasons).toContain("too-old");
  });

  it("keeps long-open career-page postings with a flag", () => {
    const r = hardFilter(normalizedPosting({ source: "smartrecruiters", postedAt: old }), config);
    expect(r.pass).toBe(true);
    expect(r.flags.some((f) => f.startsWith("long-open:"))).toBe(true);
  });
});

describe("hardFilter: language requirements", () => {
  it("detects a required language in English and Romanian", () => {
    expect(hardFilter(normalizedPosting({ description: "Fluent German is required." }), config).flags).toContain("lang-required:german");
    expect(hardFilter(normalizedPosting({ description: "Limba germană obligatoriu, nivel B2." }), config).flags).toContain("lang-required:german");
  });

  it("treats 'nice to have' languages as mentioned only", () => {
    expect(hardFilter(normalizedPosting({ description: "German is a plus." }), config).flags).toContain("lang-mentioned:german");
  });
});
