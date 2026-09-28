// tests/validate.test.ts
import { describe, expect, it } from "vitest";
import { buildEvidenceIndex, validateClaims, validateSummaryStyle } from "../src/tailoring/validate.js";
import { loadFixtureCv } from "./helpers.js";

const cv = loadFixtureCv();
const index = buildEvidenceIndex(cv);
const rules = { maxChars: 2000, maxSentences: 8 };
const posting = { company: "Oracle", title: "PHP Developer (Team 42)", description: "We need 6-9 years of experience with Nest.js." };
const check = (text: string): string[] => validateClaims("t", text, index, rules, posting);

describe("validateClaims", () => {
  it("accepts claims the CV evidences", () => {
    expect(check("Built REST APIs in PHP and Laravel with MySQL, improving query performance by 30%.")).toEqual([]);
  });

  it("rejects technologies the CV does not evidence", () => {
    expect(check("I built microservices with Java and Spring Boot.")).toEqual(
      expect.arrayContaining([expect.stringContaining('"java"'), expect.stringContaining('"spring boot"'), expect.stringContaining('"microservices"')]),
    );
  });

  it("does not confuse JavaScript with Java", () => {
    expect(check("I build front ends with Vue 3 and React.")).toEqual([]);
  });

  it("rejects numbers that are not in the CV", () => {
    expect(check("I cut API latency by 45%.")).toEqual([expect.stringContaining('number "45"')]);
  });

  it("accepts the integer part of a CV version number (PHP 8.2 → PHP 8)", () => {
    expect(check("I work with PHP 8 and Laravel 11.")).toEqual([]);
  });

  it("allows training-only skills only in a learning context", () => {
    expect(check("I deployed services to Kubernetes on AWS.")).toHaveLength(2);
    expect(check("I am completing a DevOps program that covers Kubernetes and AWS.")).toEqual([]);
  });

  it("allows honest gap statements, including the posting's own numbers", () => {
    expect(check("I have not used Nest.js in production yet.")).toEqual([]);
    expect(check("My experience is shorter than the 6 to 9 years you list.")).toEqual([]);
    expect(check("I have 9 years of experience with Nest.js.")).toEqual(
      expect.arrayContaining([expect.stringContaining('number "9"'), expect.stringContaining('"nest.js"')]),
    );
  });

  it("allows naming the employer and numbers from its title", () => {
    expect(check("Oracle's Team 42 builds the platform I want to work on.")).toEqual([]);
  });

  it("rejects placeholders and enforces length limits", () => {
    expect(check("I would love to join [Company].")).toEqual([expect.stringContaining("placeholder")]);
    expect(validateClaims("t", "A. B. C.", index, { maxChars: 100, maxSentences: 2 }, posting)).toEqual([expect.stringContaining("3 sentences")]);
  });
});

describe("validateSummaryStyle", () => {
  const seeds = Object.values(cv.summarySeeds);
  const description = "3+ years of experience in software development. Strong proficiency with JavaScript and frameworks.";

  it("accepts a rewritten, evidence-based summary", () => {
    const summary = "Full-stack engineer building Laravel, Vue 3 and Node.js/Express applications, with 3 years in a professional role. Improved MySQL analytics query performance by 30%.";
    expect(validateSummaryStyle(summary, seeds, description)).toEqual([]);
  });

  it("rejects self-praise, first person and copying the posting", () => {
    expect(validateSummaryStyle("Laravel expert with strong delivery skills and many shipped products.", seeds, "")).toEqual([expect.stringContaining("self-praise")]);
    expect(validateSummaryStyle("At Acme Web SRL I designed REST APIs and optimized MySQL.", seeds, "")).toEqual([expect.stringContaining("first person")]);
    expect(validateSummaryStyle("3+ years of experience in software development and strong proficiency with JavaScript.", seeds, description)).toEqual([
      expect.stringContaining("copies the posting"),
    ]);
  });

  it("rejects returning a seed unchanged", () => {
    expect(validateSummaryStyle(cv.summarySeeds.fullstack, seeds, "")).toEqual([expect.stringContaining("repeats a summary seed")]);
  });
});
