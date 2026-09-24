// src/scripts/digest.ts
import { and, eq, ne, sql } from "drizzle-orm";
import { loadSearchConfig } from "../config/searchConfig.js";
import { db, pool } from "../db/client.js";
import { decisions, postingScores, postings } from "../db/schema.js";

const DAY_MS = 86_400_000;
const showAll = process.argv.includes("--all"); // include "skip" recommendations

function freshnessBonus(postedAt: Date | null, now: Date): number {
  if (postedAt === null) return 0;
  const days = (now.getTime() - postedAt.getTime()) / DAY_MS;
  return days <= 2 ? 5 : days <= 5 ? 2 : 0; // early applications get read first
}

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

  const ranked = rows
    .map((r) => ({
      ...r,
      rank: r.s.total + freshnessBonus(r.p.postedAt, now) + (r.p.flags.includes("allowlist-company") ? 5 : 0),
    }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, config.digest.limit);

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

  console.log(`\nAwaiting review: apply=${counts?.apply ?? 0} maybe=${counts?.maybe ?? 0} skip=${counts?.skip ?? 0}${showAll ? "" : " (skips hidden, use --all)"}`);
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
