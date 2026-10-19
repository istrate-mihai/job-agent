// tests/atsSources.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { arbeitnowSource } from "../src/ingest/sources/arbeitnow.js";
import { ashbySource } from "../src/ingest/sources/ashby.js";
import { parsePersonioXml, personioSource } from "../src/ingest/sources/personio.js";
import { recruiteeSource } from "../src/ingest/sources/recruitee.js";
import { workableSource } from "../src/ingest/sources/workable.js";

const signal = (): AbortSignal => AbortSignal.timeout(5_000);

function stubJson(body: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

afterEach(() => vi.unstubAllGlobals());

const PERSONIO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
  <position>
    <id>883</id>
    <office>Brasov</office>
    <additionalOffices><office>Bucharest</office><office>Brasov</office></additionalOffices>
    <department>Software</department>
    <name>Full Stack Developer (m/f/d)</name>
    <jobDescriptions>
      <jobDescription><name>Your tasks</name><value><![CDATA[<ul><li>Build Vue &amp; Laravel apps</li></ul>]]></value></jobDescription>
      <jobDescription><name>Your profile</name><value><![CDATA[<p>3+ years PHP</p>]]></value></jobDescription>
    </jobDescriptions>
    <createdAt>2026-09-20T10:00:00+00:00</createdAt>
  </position>
  <position><id></id><name>Broken</name></position>
</workzag-jobs>`;

describe("personio", () => {
  it("parses positions, offices and description sections", () => {
    const [p, ...rest] = parsePersonioXml(PERSONIO_XML);
    expect(rest).toHaveLength(0); // position without id is dropped
    expect(p).toMatchObject({ id: "883", name: "Full Stack Developer (m/f/d)", offices: ["Brasov", "Bucharest"], department: "Software" });
    expect(p?.description).toContain("Your tasks");
    expect(p?.description).toContain("Build Vue & Laravel apps");
    expect(p?.description).toContain("3+ years PHP");
  });

  it("maps to normalized postings with a stable source id and job URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PERSONIO_XML, { status: 200 })));
    const [row] = await personioSource("in-tech", "in-tech", "com").fetch(signal());
    expect(row).toMatchObject({
      source: "personio",
      sourceId: "in-tech:883",
      url: "https://in-tech.jobs.personio.com/job/883",
      locationText: "Brasov; Bucharest",
    });
    expect(row?.postedAt?.toISOString().slice(0, 10)).toBe("2026-09-20");
  });

  it("fails loudly on a wrong slug", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404, statusText: "Not Found" })));
    await expect(personioSource("X", "nope", "de").fetch(signal())).rejects.toThrow(/404/);
  });
});

describe("workable", () => {
  it("reads locations, workplace type and description", async () => {
    stubJson({
      name: "Acme",
      jobs: [
        {
          title: " PHP Developer ",
          shortcode: "ABC123",
          url: "https://apply.workable.com/acme/j/ABC123/",
          locations: [{ city: "Brașov", region: "Brașov", country: "Romania" }],
          workplace_type: "hybrid",
          published_on: "2026-09-30",
          description: "<p>Laravel and Vue</p>",
        },
        { title: "Node Dev", shortcode: "XYZ", city: "Cluj-Napoca", country: "Romania", telecommuting: true },
      ],
    });
    const rows = await workableSource("Acme", "acme").fetch(signal());
    expect(rows[0]).toMatchObject({ sourceId: "acme:ABC123", title: "PHP Developer", locationText: "Brașov, Brașov, Romania", workMode: "hybrid", description: "Laravel and Vue" });
    expect(rows[1]).toMatchObject({ url: "https://apply.workable.com/acme/j/XYZ/", locationText: "Cluj-Napoca, Romania", workMode: "remote", postedAt: null });
  });
});

describe("recruitee", () => {
  it("keeps published offers and joins description + requirements", async () => {
    stubJson({
      offers: [
        { id: 1, title: "Vue Developer", careers_url: "https://acme.recruitee.com/o/vue", location: "Brasov, Romania", hybrid: true, status: "published", published_at: "2026-09-29 10:00:00 UTC", description: "<p>Vue 3</p>", requirements: "<p>TypeScript</p>" },
        { id: 2, title: "Draft", careers_url: "https://acme.recruitee.com/o/draft", status: "draft" },
      ],
    });
    const rows = await recruiteeSource("Acme", "acme").fetch(signal());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceId: "acme:1", workMode: "hybrid", description: "Vue 3\n\nTypeScript" });
  });
});

describe("ashby", () => {
  it("joins primary and secondary locations, maps workplace type and skips unlisted jobs", async () => {
    stubJson({
      apiVersion: "1",
      jobs: [
        {
          id: "a1",
          title: " Software Engineer ",
          location: "Bucharest",
          secondaryLocations: [{ location: "Cluj-Napoca" }, { location: "Bucharest" }],
          isListed: true,
          isRemote: false,
          workplaceType: "Hybrid",
          publishedAt: "2026-10-01T09:00:00.000+00:00",
          jobUrl: "https://jobs.ashbyhq.com/acme/a1",
          descriptionPlain: "TypeScript and Node.js",
        },
        { id: "a2", title: "Platform Engineer", location: "Remote - Europe", isRemote: true, jobUrl: "https://jobs.ashbyhq.com/acme/a2", descriptionHtml: "<p>Kubernetes</p>" },
        { id: "a3", title: "Confidential", location: "Bucharest", isListed: false, jobUrl: "https://jobs.ashbyhq.com/acme/a3" },
      ],
    });
    const rows = await ashbySource("Acme", "acme").fetch(signal());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ source: "ashby", sourceId: "acme:a1", title: "Software Engineer", locationText: "Bucharest; Cluj-Napoca", workMode: "hybrid", remoteScope: null, description: "TypeScript and Node.js" });
    expect(rows[0]?.postedAt?.toISOString().slice(0, 10)).toBe("2026-10-01");
    expect(rows[1]).toMatchObject({ workMode: "remote", remoteScope: "Remote - Europe", description: "Kubernetes", postedAt: null });
  });

  it("fails loudly on a wrong slug", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404, statusText: "Not Found" })));
    await expect(ashbySource("X", "nope").fetch(signal())).rejects.toThrow(/404/);
  });
});

describe("arbeitnow", () => {
  const page = (next: string | null) => ({
    data: [
      { slug: "remote-node-1", company_name: " Acme GmbH ", title: "Node.js Developer", description: "<p>Remote in EU</p>", remote: true, url: "https://www.arbeitnow.com/jobs/acme/remote-node-1", tags: [], location: "Europe", created_at: 1_791_000_000 },
      { slug: "berlin-php-2", company_name: "Beta", title: "PHP Developer", description: "", remote: false, url: "https://www.arbeitnow.com/jobs/beta/berlin-php-2", tags: [], location: "Berlin", created_at: null },
    ],
    links: { next },
  });

  it("keeps remote jobs only by default and converts unix seconds", async () => {
    stubJson(page(null));
    const rows = await arbeitnowSource({ remoteOnly: true, pages: 1 }).fetch(signal());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "arbeitnow", sourceId: "remote-node-1", company: "Acme GmbH", workMode: "remote", remoteScope: "Europe", locationText: "Remote; Europe", description: "Remote in EU" });
    expect(rows[0]?.postedAt?.getTime()).toBe(1_791_000_000 * 1000);
  });

  it("follows pagination up to the page limit and stops when there is no next page", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(page(url.endsWith("page=1") ? "https://www.arbeitnow.com/api/job-board-api?page=2" : null)), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const rows = await arbeitnowSource({ remoteOnly: false, pages: 3 }).fetch(signal());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(4);
  });
});
