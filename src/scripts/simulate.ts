// src/scripts/simulate.ts
// Inserts 3 fictional postings so the full flow (score → decide → tailor → track) can be tried
// without real job alerts. Companies are invented and marked "(simulation)".
// Usage: npm run simulate            → insert the demo postings
//        npm run simulate -- --clean → delete them (scores, decisions and tailorings cascade)
import { eq } from "drizzle-orm";
import { loadSearchConfig } from "../config/searchConfig.js";
import { db, pool } from "../db/client.js";
import { postings, type NewPostingRow } from "../db/schema.js";
import { hardFilter } from "../filter/hardFilter.js";
import { dedupeHash } from "../ingest/text.js";
import type { NormalizedPosting } from "../ingest/types.js";

const SOURCE = "simulation";

const DEMO: Omit<NormalizedPosting, "source" | "postedAt" | "raw">[] = [
  {
    sourceId: "demo-1",
    company: "DemoTech Brașov (simulation)",
    title: "Full Stack Developer (PHP/Laravel + Vue)",
    url: "https://example.com/simulation/demo-1",
    locationText: "Brașov, Romania",
    workMode: "hybrid",
    remoteScope: null,
    description: `We build a B2B logistics platform used by 300+ warehouses in Romania.
Responsibilities:
- Develop features across a Laravel REST API and a Vue 3 single-page app
- Design MySQL schemas and optimize slow queries for reporting dashboards
- Containerize services with Docker and ship through a CI pipeline
- Work with product managers and operations stakeholders in two-week sprints
Requirements:
- 3+ years of professional PHP experience, ideally Laravel
- Vue 3 or React with TypeScript
- Strong SQL (MySQL or PostgreSQL)
- Git, Docker, REST API design
Nice to have: Kubernetes, AWS, experience with manufacturing or quality data.
Hybrid: 2 days per week in our Brașov office.`,
  },
  {
    sourceId: "demo-2",
    company: "Nordlicht Digital (simulation)",
    title: "Backend Engineer Node.js/TypeScript",
    url: "https://example.com/simulation/demo-2",
    locationText: "Remote (Europe)",
    workMode: "remote",
    remoteScope: "Europe",
    description: `Remote-first team building an automation SaaS for SMEs across the EU.
You will:
- Build Node.js/Express services in TypeScript with PostgreSQL
- Integrate third-party APIs (payments with Stripe, email, webhooks)
- Add LLM-powered features (tool calling, structured outputs) to our workflow engine
- Own CI/CD with GitHub Actions and Docker
We look for:
- 3+ years building backend services
- TypeScript, Node.js, PostgreSQL, REST APIs
- Pragmatic testing habits
Bonus: Python/FastAPI, experience shipping AI agents to production.
Fully remote within European time zones.`,
  },
  {
    sourceId: "demo-3",
    company: "Pixel Forge (simulation)",
    title: "Dezvoltator PHP Laravel",
    url: "https://example.com/simulation/demo-3",
    locationText: "București, Romania",
    workMode: "onsite",
    remoteScope: null,
    description: `Căutăm un dezvoltator PHP pentru echipa noastră din București.
Responsabilități:
- dezvoltarea și întreținerea aplicațiilor web în Laravel
- optimizarea interogărilor MySQL pentru rapoarte
- colaborarea cu echipa de frontend (Vue.js)
Cerințe:
- minimum 2 ani de experiență cu PHP și Laravel
- cunoștințe solide MySQL și REST API
- experiență cu Git și Docker
Oferim: pachet de beneficii, program flexibil și abonament medical pentru candidatul potrivit.`,
  },
];

async function clean(): Promise<void> {
  const removed = await db.delete(postings).where(eq(postings.source, SOURCE)).returning({ id: postings.id });
  console.log(`Removed ${removed.length} simulation posting(s) with their scores, decisions and tailorings.`);
  console.log("Generated files stay in output/applications/ (folders containing 'simulation'); delete them by hand if you like.");
}

async function insert(): Promise<void> {
  const config = await loadSearchConfig();
  const now = new Date();
  const rows: NewPostingRow[] = DEMO.map((d) => {
    const posting: NormalizedPosting = { ...d, source: SOURCE, postedAt: now, raw: { simulation: true } };
    const filter = hardFilter(posting, config, now);
    const { remoteScope: _scope, ...columns } = posting; // remoteScope is filter input only, not a column
    return {
      ...columns,
      dedupeHash: dedupeHash(posting),
      locationTier: filter.tier,
      status: filter.pass ? "new" : "filtered_out",
      filterReasons: filter.reasons,
      flags: [...filter.flags, "simulation"],
    };
  });

  const inserted = await db.insert(postings).values(rows).onConflictDoNothing().returning({ id: postings.id, company: postings.company, title: postings.title, status: postings.status });
  if (inserted.length === 0) {
    console.log("Simulation postings already exist. Reset with: npm run simulate -- --clean");
    return;
  }
  for (const r of inserted) console.log(`+ [${r.id.slice(0, 8)}] ${r.company} — ${r.title} (${r.status})`);
  console.log("\nNext: npm run score && npm run digest, then approve one and run npm run tailor");
}

(process.argv.includes("--clean") ? clean() : insert())
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
