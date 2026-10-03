// tests/webBoard.test.ts
import { describe, expect, it } from "vitest";
import { extractLinks } from "../src/ingest/html/links.js";
import { isAllowed, parseRobots } from "../src/ingest/html/robots.js";
import { parseListingPage, postingsFromJsonLd } from "../src/ingest/sources/webBoard.js";

const NOW = new Date("2026-10-03T00:00:00Z");

describe("robots.txt", () => {
  it("allows everything for an empty Disallow", () => {
    expect(isAllowed(parseRobots("User-agent: *\nDisallow:\n"), "/jobs")).toBe(true);
  });

  it("applies the * group, longest match wins, ignores other bots", () => {
    const rules = parseRobots(
      ["User-agent: AhrefsBot", "Disallow: /", "", "User-agent: *", "Disallow: /angajator/", "Allow: /angajator/public", "Disallow: /*?sort=", "Disallow: /tmp$"].join("\n"),
    );
    expect(isAllowed(rules, "/locuri-de-munca/cautajob/IT-Software/Brasov")).toBe(true);
    expect(isAllowed(rules, "/angajator/123")).toBe(false);
    expect(isAllowed(rules, "/angajator/public/1")).toBe(true);
    expect(isAllowed(rules, "/jobs?sort=date")).toBe(false);
    expect(isAllowed(rules, "/tmp")).toBe(false);
    expect(isAllowed(rules, "/tmp/x")).toBe(true);
  });

  it("prefers a group naming our agent over *", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: job-agent\nDisallow: /private\n");
    expect(isAllowed(rules, "/jobs")).toBe(true);
    expect(isAllowed(rules, "/private/x")).toBe(false);
  });
});

describe("extractLinks", () => {
  it("resolves relative hrefs against the page and filters by pattern", () => {
    const html = `<a href="/jobs/14137/link">Junior SRE</a><a href="/jobs/web-development">Category</a><a href="https://facebook.com/x">FB</a>`;
    const links = extractLinks(html, { baseUrl: "https://www.juniors.ro/jobs", include: /juniors\.ro\/jobs\/\d+/ });
    expect(links).toEqual([{ href: "https://www.juniors.ro/jobs/14137/link", text: "Junior SRE" }]);
  });

  it("drops relative hrefs when there is no base (emails)", () => {
    expect(extractLinks(`<a href="/relative">Job title</a>`)).toEqual([]);
  });
});

describe("listing pages", () => {
  const pageUrl = "https://www.hipo.ro/locuri-de-munca/cautajob/IT-Software/Brasov";
  const pattern = /hipo\.ro\/locuri-de-munca\/locuri_de_munca\/\d+\//;

  it("finds posting links and strips navigation", () => {
    const html = `<html><head><title>IT Brasov</title></head><body>
      <nav><a href="/locuri-de-munca/locuri_de_munca/1/Nav/Menu">Menu job</a></nav>
      <ul><li><a href="/locuri-de-munca/locuri_de_munca/271596/ACME/Full-Stack-Developer">Full Stack Developer</a> ACME · Brașov</li></ul>
      <footer>© Hipo</footer></body></html>`;
    const page = parseListingPage(html, pageUrl, pattern);
    expect(page.title).toBe("IT Brasov");
    expect(page.links.map((l) => l.href)).toEqual(["https://www.hipo.ro/locuri-de-munca/locuri_de_munca/271596/ACME/Full-Stack-Developer"]);
    expect(page.text).toContain("ACME · Brașov");
    expect(page.text).not.toContain("Hipo");
  });

  it("maps JSON-LD JobPostings (ItemList and @graph), skipping expired or incomplete ones", () => {
    const ld = {
      "@type": "ItemList",
      itemListElement: [
        {
          "@type": "ListItem",
          item: {
            "@type": "JobPosting",
            title: "PHP Developer",
            url: "/locuri-de-munca/locuri_de_munca/5/ACME/PHP-Developer",
            hiringOrganization: { name: "ACME" },
            jobLocation: { address: { addressLocality: "Brașov", addressRegion: "BV" } },
            datePosted: "2026-10-01",
            validThrough: "2026-12-01",
          },
        },
        { "@type": "ListItem", item: { "@type": "JobPosting", title: "Old Job", url: "/x/6", hiringOrganization: "ACME", validThrough: "2026-01-01" } },
        { "@type": "ListItem", item: { "@type": "JobPosting", title: "No company", url: "/x/7" } },
        { "@type": "ListItem", item: { "@type": "JobPosting", title: "Remote Node Dev", url: "/x/8", hiringOrganization: "Beta", jobLocationType: "TELECOMMUTE" } },
      ],
    };
    const html = `<script type="application/ld+json">${JSON.stringify({ "@graph": [ld] })}</script>`;
    const page = parseListingPage(html, pageUrl, pattern);
    const rows = postingsFromJsonLd("hipo", pageUrl, page.jsonLd, NOW);

    expect(rows.map((r) => r.title)).toEqual(["PHP Developer", "Remote Node Dev"]);
    expect(rows[0]).toMatchObject({
      source: "board:hipo",
      sourceId: "https://www.hipo.ro/locuri-de-munca/locuri_de_munca/5/ACME/PHP-Developer",
      company: "ACME",
      locationText: "Brașov, BV",
    });
    expect(rows[0]?.postedAt?.toISOString().slice(0, 10)).toBe("2026-10-01");
    expect(rows[1]?.workMode).toBe("remote");
  });
});
