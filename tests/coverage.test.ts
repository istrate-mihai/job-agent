// tests/coverage.test.ts
import { describe, expect, it } from "vitest";
import { baseSelection } from "../src/cv/view.js";
import { renderDiff } from "../src/tailoring/diff.js";
import { loadFixtureCv, postingRow } from "./helpers.js";

const cv = loadFixtureCv();

function coverage(keywords: string[]): Record<string, string> {
  const md = renderDiff({
    posting: postingRow(),
    score: null,
    cv,
    selection: baseSelection(cv),
    summary: "s",
    coverNote: "c",
    postingKeywords: keywords,
    availability: null,
    route: "test",
    pages: 2,
    trims: [],
    notes: [],
    warnings: [],
  });
  const lines = md.split("\n").filter((l) => l.startsWith("- ✔") || l.startsWith("- ✖"));
  return Object.fromEntries(lines.map((l) => [l.slice(4).split(" — ")[0] ?? "", l.startsWith("- ✔") ? "yes" : "no"]));
}

describe("requirements coverage in diff.md", () => {
  it("matches versioned requirements against versioned CV skills", () => {
    expect(coverage(["PHP 8+", "Vue.js 3+"])).toEqual({ "PHP 8+": "yes", "Vue.js 3+": "yes" });
  });

  it("understands common synonyms", () => {
    expect(coverage(["unit testing", "Front-End Development", "Back-End Development", "Database Management", "security"])).toEqual({
      "unit testing": "yes",
      "Front-End Development": "yes",
      "Back-End Development": "yes",
      "Database Management": "yes",
      security: "yes",
    });
  });

  it("compares years against what the CV claims", () => {
    expect(coverage(["3+ years experience", "6-9 years"])).toEqual({ "3+ years experience": "yes", "6-9 years": "no" });
  });

  it("still reports real gaps", () => {
    expect(coverage(["Nest.js", "Kubernetes", "Bachelor Degree"])).toEqual({ "Nest.js": "no", Kubernetes: "no", "Bachelor Degree": "no" });
  });
});
