// tests/rss.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRssFeed, rssSource } from "../src/ingest/sources/rss.js";

const signal = (): AbortSignal => AbortSignal.timeout(5_000);

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>We Work Remotely</title>
  <item>
    <title><![CDATA[Acme Corp: Senior Full-Stack Engineer]]></title>
    <link>https://weworkremotely.com/remote-jobs/acme-senior-full-stack-engineer</link>
    <guid>https://weworkremotely.com/remote-jobs/acme-senior-full-stack-engineer</guid>
    <pubDate>Mon, 06 Oct 2026 08:00:00 +0000</pubDate>
    <description><![CDATA[<p>Build <b>React</b> and Node.js apps.</p>]]></description>
  </item>
  <item>
    <title>No colon title</title>
    <link>https://weworkremotely.com/remote-jobs/no-colon</link>
    <guid></guid>
    <pubDate></pubDate>
    <description></description>
  </item>
  <item>
    <title>Missing link</title>
  </item>
</channel>
</rss>`;

afterEach(() => vi.unstubAllGlobals());

describe("parseRssFeed", () => {
  it("parses items and drops ones without a title or link", () => {
    const items = parseRssFeed(FEED);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: "Acme Corp: Senior Full-Stack Engineer", link: "https://weworkremotely.com/remote-jobs/acme-senior-full-stack-engineer" });
  });
});

describe("rssSource", () => {
  it("splits 'Company: Title', decodes HTML description, falls back guid→link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(FEED, { status: 200 })));
    const rows = await rssSource("weworkremotely-fullstack", "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss").fetch(signal());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      source: "rss:weworkremotely-fullstack",
      company: "Acme Corp",
      title: "Senior Full-Stack Engineer",
      sourceId: "https://weworkremotely.com/remote-jobs/acme-senior-full-stack-engineer",
      workMode: "remote",
      remoteScope: "worldwide",
    });
    expect(rows[0]?.description).toContain("Build");
    // no colon in title → whole thing is the title, company falls back to feed name; empty guid falls back to link
    expect(rows[1]).toMatchObject({ company: "weworkremotely-fullstack", title: "No colon title", sourceId: "https://weworkremotely.com/remote-jobs/no-colon" });
  });

  it("throws on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404, statusText: "Not Found" })));
    await expect(rssSource("x", "https://example.com/x.rss").fetch(signal())).rejects.toThrow(/404/);
  });
});
