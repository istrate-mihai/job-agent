// tests/joburiit.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { joburiItSource, parseVacancyPage, toPosting, type Vacancy } from "../src/ingest/sources/joburiit.js";

const signal = (): AbortSignal => AbortSignal.timeout(10_000);
const CFG = { enabled: true, categories: [], maxNewPerRun: 40 };

const page = (title: string, company: string, body: string): string => `<!doctype html><html><head>
<title>${title} &#8211; ${company} | JoburiIT.ro</title><script>window.x = "Remote"</script></head>
<body><header><nav>Joburi IT Feed Login</nav></header>
<main><div class="elementor">Acasă / Joburi</div><h1>${title}</h1><p>${company}</p>${body}</main>
<footer>© JoburiIT.ro</footer></body></html>`;

const vacancy = (over: Partial<Vacancy> = {}): Vacancy => ({
  id: 18711,
  link: "https://joburiit.ro/jobs-vacancies/backend-data-infrastructure-team-lead/",
  date_gmt: "2026-10-18T12:59:53",
  title: { rendered: "Backend &amp; Data Infrastructure Team Lead" },
  "vacancy-location": [75],
  "vacancy-category": [2],
  ...over,
});

const json = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

afterEach(() => vi.unstubAllGlobals());

describe("parseVacancyPage", () => {
  it("takes the employer after the last dash and the description from the heading on", () => {
    const html = page("Senior Engineer – Team Lead (Linux, C/C++)", "hrevolution", "<h2>Cerințe</h2><ul><li>Go</li><li>Kafka</li></ul>");
    const parsed = parseVacancyPage(html, "Senior Engineer – Team Lead (Linux, C/C++)");
    expect(parsed.company).toBe("hrevolution");
    expect(parsed.description.startsWith("Senior Engineer – Team Lead")).toBe(true);
    expect(parsed.description).toContain("- Go");
    expect(parsed.description).not.toMatch(/Login|©|window\.x|Acasă/);
  });

  it("returns no company when the title has no separator", () => {
    expect(parseVacancyPage("<title>JoburiIT.ro</title><body>x</body>", "x").company).toBe("");
  });
});

describe("toPosting", () => {
  it("maps a Remote term to remote work scoped to Romania and parses date_gmt as UTC", () => {
    const p = toPosting(vacancy(), new Map([[75, "Remote"]]), { company: "hrevolution", description: "Build data platforms." });
    expect(p).toMatchObject({
      source: "joburiit",
      sourceId: "18711",
      company: "hrevolution",
      title: "Backend & Data Infrastructure Team Lead",
      locationText: "Remote",
      workMode: "remote",
      remoteScope: "Romania",
    });
    expect(p.postedAt?.toISOString()).toBe("2026-10-18T12:59:53.000Z");
  });

  it("keeps hybrid from the description over a city tag", () => {
    const p = toPosting(vacancy({ "vacancy-location": [70] }), new Map([[70, "Brașov"]]), { company: "Acme", description: "Program hybrid, 2 zile la birou." });
    expect(p).toMatchObject({ locationText: "Brașov", workMode: "hybrid", remoteScope: null });
  });
});

describe("joburiItSource", () => {
  it("lists via REST, skips known ids, fetches only new posting pages", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /wp-admin/\n");
        if (url.includes("/vacancy-location")) return json([{ id: 75, name: "Remote", slug: "joburi-remote" }]);
        if (url.includes("/jobs-vacancies?")) {
          return json([vacancy(), vacancy({ id: 1, link: "https://joburiit.ro/jobs-vacancies/old/", title: { rendered: "Old" } })], { "x-wp-totalpages": "1" });
        }
        if (url.includes("/jobs-vacancies/backend")) return new Response(page("Backend &amp; Data Infrastructure Team Lead", "hrevolution", "<p>Go, Kafka</p>"));
        throw new Error(`unexpected ${url}`);
      }),
    );
    const rows = await joburiItSource(CFG, { knownIds: async () => new Set(["1"]) }).fetch(signal());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceId: "18711", company: "hrevolution", workMode: "remote" });
    expect(urls.some((u) => u.includes("/jobs-vacancies/old/"))).toBe(false); // known: no page fetch
    expect(urls.some((u) => u.includes("/vacancy-category?") || u.includes("&vacancy-category="))).toBe(false); // no categories configured
  });

  it("resolves category slugs to ids and caps new pages per run", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
        if (url.includes("/vacancy-location")) return json([]);
        if (url.includes("/vacancy-category?")) return json([{ id: 2, name: "Backend", slug: "joburi-backend" }, { id: 4, name: "Fullstack", slug: "full-stack" }]);
        if (url.includes("/jobs-vacancies?")) return json([vacancy({ id: 10 }), vacancy({ id: 11 })]);
        return new Response(page("Backend &amp; Data Infrastructure Team Lead", "Acme", "<p>x</p>"));
      }),
    );
    const rows = await joburiItSource({ enabled: true, categories: ["full-stack"], maxNewPerRun: 1 }, { knownIds: async () => new Set() }).fetch(signal());
    expect(rows.map((r) => r.sourceId)).toEqual(["10"]);
    expect(urls.find((u) => u.includes("/jobs-vacancies?"))).toContain("vacancy-category=4");
  });

  it("returns nothing when robots.txt disallows the API", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("User-agent: *\nDisallow: /wp-json/\n")));
    expect(await joburiItSource(CFG, { knownIds: async () => new Set() }).fetch(signal())).toEqual([]);
  });
});
