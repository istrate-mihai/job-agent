// tests/text.test.ts
import { describe, expect, it } from "vitest";
import { canonicalUrl } from "../src/ingest/gmail/canonicalUrl.js";
import { dedupeHash, hasTerm, htmlToText, normalizeText } from "../src/ingest/text.js";

describe("text utilities", () => {
  it("converts entity-escaped HTML to readable text", () => {
    expect(htmlToText("&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Vue&lt;/li&gt;&lt;/ul&gt;")).toBe("Hello & welcome\n\n- Vue");
  });

  it("normalizes diacritics and matches whole terms only", () => {
    expect(normalizeText("Brașov, Timișoara")).toBe("brasov timisoara");
    expect(hasTerm(normalizeText("Internal tools"), "intern")).toBe(false);
    expect(hasTerm(normalizeText("Frontend Intern"), "intern")).toBe(true);
  });

  it("deduplicates the same job across sources", () => {
    const a = dedupeHash({ company: "Endava", title: "Full Stack Developer", locationText: "Brașov" });
    const b = dedupeHash({ company: "ENDAVA", title: "Full-Stack Developer", locationText: "Brasov" });
    expect(a).toBe(b);
  });
});

describe("canonicalUrl", () => {
  it("reduces LinkedIn tracking links to the job id", () => {
    expect(canonicalUrl("https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=abc&refId=xyz")).toBe("https://www.linkedin.com/jobs/view/4012345678/");
  });

  it("strips tracking parameters from other job sites", () => {
    expect(canonicalUrl("https://www.ejobs.ro/job/123?utm_source=alert&x=1#top")).toBe("https://www.ejobs.ro/job/123?x=1");
  });
});
