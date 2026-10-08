// src/scripts/digest.ts
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { loadSearchConfig } from "../config/searchConfig.js";
import { db, pool } from "../db/client.js";
import { decisions, postingScores, postings } from "../db/schema.js";
import { normalizeText } from "../ingest/text.js";

const DAY_MS = 86_400_000;
const showAll = process.argv.includes("--all"); // include "skip" recommendations

function freshnessBonus(postedAt: Date | null, now: Date): number {
  if (postedAt === null) return 0;
  const days = (now.getTime() - postedAt.getTime()) / DAY_MS;
  return days <= 2 ? 5 : days <= 5 ? 2 : 0; // early applications get read first
}

// Same job reposted on another board (or with "Bucharest" vs "Bucharest, Romania") gets a new dedupe hash
const canon = (v: string): string => normalizeText(v).replace(/[^a-z0-9+#]+/g, " ").trim(); // "–" vs "-", "PHP / Full-Stack"
const jobKey = (company: string, title: string): string => `${canon(company)}|${canon(title)}`;
const HANDLED = ["approved", "tailored", "applied", "responded", "interview", "offer", "rejected", "skipped"] as const;

function age(postedAt: Date | null, now: Date): string {
  if (postedAt === null) return "date unknown";
  const days = Math.floor((now.getTime() - postedAt.getTime()) / DAY_MS);
  return days <= 0 ? "today" : `${days}d ago`;
}

async function main(): Promise<void> {
  const config = await loadSearchConfig();
  const now = new Date();

  const rows = await db
    .select({ p: postings, s: postingScores })
    .from(postings)
    .innerJoin(postingScores, eq(postingScores.postingId, postings.id))
    .where(showAll ? eq(postings.status, "scored") : and(eq(postings.status, "scored"), ne(postingScores.recommendation, "skip")));

  // Auto-skip postings you already handled under another id; keep only the best-scored copy of the rest
  const handled = await db
    .select({ id: postings.id, company: postings.company, title: postings.title, status: postings.status })
    .from(postings)
    .where(inArray(postings.status, [...HANDLED]));
  const handledByKey = new Map(handled.map((h) => [jobKey(h.company, h.title), h]));
  const autoSkipped: string[] = [];
  const fresh: typeof rows = [];
  for (const r of rows) {
    const twin = handledByKey.get(jobKey(r.p.company, r.p.title));
    if (twin === undefined) {
      fresh.push(r);
      continue;
    }
    const reason = `duplicate of ${twin.id.slice(0, 8)} (${twin.status})`;
    await db.transaction(async (tx) => {
      await tx.insert(decisions).values({ postingId: r.p.id, decision: "skip", reason, scoreAtDecision: r.s.total });
      await tx.update(postings).set({ status: "skipped" }).where(eq(postings.id, r.p.id));
    });
    autoSkipped.push(`${r.p.company} — ${r.p.title}: ${reason}`);
  }
  const bestByKey = new Map<string, (typeof rows)[number]>();
  for (const r of fresh) {
    const key = jobKey(r.p.company, r.p.title);
    const prev = bestByKey.get(key);
    if (prev === undefined || r.s.total > prev.s.total) bestByKey.set(key, r);
  }
  const hiddenDuplicates = fresh.length - bestByKey.size;

  const ranked = [...bestByKey.values()]
    .map((r) => ({
      ...r,
      rank: r.s.total + freshnessBonus(r.p.postedAt, now) + (r.p.flags.includes("allowlist-company") ? 5 : 0),
    }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, config.digest.limit);

  if (autoSkipped.length > 0) console.log(`Auto-skipped ${autoSkipped.length} duplicate(s):\n  ${autoSkipped.join("\n  ")}`);

  if (ranked.length === 0) {
    console.log("Nothing to review. Run: npm run ingest && npm run score");
  }

  ranked.forEach(({ p, s }, i) => {
    const tag = s.confidence === "low" ? " · title-only" : "";
    const tier = p.locationTier === "tierB" ? "relocation" : (p.locationTier ?? "?");
    console.log(`\n#${i + 1}  ${String(s.total).padStart(3)}  ${s.recommendation.toUpperCase().padEnd(5)}  [${p.id.slice(0, 8)}]  ${p.company} — ${p.title}`);
    console.log(`     ${tier} · ${p.locationText || "location n/a"} · ${p.workMode} · ${age(p.postedAt, now)} · ${s.primaryStack}${tag}`);
    if (s.matchedSkills.length > 0) console.log(`     matched: ${s.matchedSkills.slice(0, 8).join(", ")}`);
    if (s.mustHaveGaps.length > 0) console.log(`     gaps:    ${s.mustHaveGaps.slice(0, 6).join(", ")}`);
    if (s.components.penalties.length > 0) console.log(`     penalty: ${s.components.penalties.join("; ")}`);
    console.log(`     ${p.url}`);
  });

  const [counts] = await db
    .select({
      apply: sql<number>`count(*) filter (where ${postingScores.recommendation} = 'apply')::int`,
      maybe: sql<number>`count(*) filter (where ${postingScores.recommendation} = 'maybe')::int`,
      skip: sql<number>`count(*) filter (where ${postingScores.recommendation} = 'skip')::int`,
    })
    .from(postingScores)
    .innerJoin(postings, eq(postings.id, postingScores.postingId))
    .where(eq(postings.status, "scored"));

  const calibration = await db
    .select({
      decision: decisions.decision,
      n: sql<number>`count(*)::int`,
      avgScore: sql<number>`round(avg(${decisions.scoreAtDecision}))::int`,
    })
    .from(decisions)
    .groupBy(decisions.decision);

  console.log(`\nAwaiting review: apply=${counts?.apply ?? 0} maybe=${counts?.maybe ?? 0} skip=${counts?.skip ?? 0}${showAll ? "" : " (skips hidden, use --all)"}${hiddenDuplicates > 0 ? `, ${hiddenDuplicates} duplicate repost(s) hidden` : ""}`);
  if (calibration.length > 0) {
    // if approved and skipped averages are close, the scoring isn't separating good from bad yet
    console.log(`Your decisions: ${calibration.map((c) => `${c.decision}=${c.n} (avg score ${c.avgScore ?? "n/a"})`).join(", ")}`);
  }
  console.log(`Decide with: npm run decide -- <id> approve|skip "optional reason"`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
