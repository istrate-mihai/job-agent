// tests/atsSources.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
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
