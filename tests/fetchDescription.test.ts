// tests/fetchDescription.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDescription } from "../src/ingest/enrich/fetchDescription.js";

const LONG = "We build microservices for our eCommerce platform with TypeScript and Node.js. ".repeat(8);
const signal = (): AbortSignal => AbortSignal.timeout(5_000);

function stubPage(status: number, html = ""): void {
  // Plain object: the Response constructor refuses LinkedIn's non-standard 999 status
  vi.stubGlobal("fetch", vi.fn(async () => ({ status, text: async () => html })));
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchDescription: LinkedIn", () => {
  const url = "https://www.linkedin.com/jobs/view/4432775485/";

  it("extracts the description block and ignores the similar-jobs rail", async () => {
    stubPage(200, `<button>Sign in</button><div class="show-more-less-html__markup"><p>${LONG}</p></div><aside>Other job: no longer accepting applications</aside>`);
    const r = await fetchDescription(url, { linkedin: true, signal: signal() });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.description).toContain("microservices");
      expect(r.description).not.toContain("Other job");
    }
  });

  it("detects closed and removed postings", async () => {
    stubPage(200, `<figure class="closed-job">No longer accepting applications</figure><div class="show-more-less-html__markup">${LONG}</div>`);
    expect((await fetchDescription(url, { linkedin: true, signal: signal() })).status).toBe("closed");
    stubPage(404);
    expect((await fetchDescription(url, { linkedin: true, signal: signal() })).status).toBe("closed");
  });

  it("stops on throttling (HTTP 999)", async () => {
    stubPage(999);
    expect((await fetchDescription(url, { linkedin: true, signal: signal() })).status).toBe("rate-limited");
  });

  it("does not call LinkedIn when disabled", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect((await fetchDescription(url, { linkedin: false, signal: signal() })).status).toBe("unavailable");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("fetchDescription: JSON-LD job pages", () => {
  const url = "https://www.ejobs.ro/user/locuri-de-munca/dezvoltator-php/123";

  it("reads a JobPosting nested in @graph", async () => {
    const ld = JSON.stringify({ "@graph": [{ "@type": "Organization" }, { "@type": "JobPosting", description: `<p>${LONG}</p>`, validThrough: "2999-01-01" }] });
    stubPage(200, `<script type="application/ld+json">${ld}</script>`);
    const r = await fetchDescription(url, { linkedin: true, signal: signal() });
    expect(r).toMatchObject({ status: "ok", via: "json-ld" });
  });

  it("treats a past validThrough as closed", async () => {
    const ld = JSON.stringify({ "@type": "JobPosting", description: LONG, validThrough: "2020-01-01" });
    stubPage(200, `<script type="application/ld+json">${ld}</script>`);
    expect((await fetchDescription(url, { linkedin: true, signal: signal() })).status).toBe("closed");
  });

  it("reports pages without job data as unavailable", async () => {
    stubPage(200, "<html><body>Just a landing page</body></html>");
    expect((await fetchDescription(url, { linkedin: true, signal: signal() })).status).toBe("unavailable");
  });
});
