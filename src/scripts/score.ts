// src/scripts/score.ts
import { and, eq, or, sql } from "drizzle-orm";
import { loadSearchConfig } from "../config/searchConfig.js";
import { db, pool } from "../db/client.js";
import { postingScores, postings } from "../db/schema.js";
import { buildCandidateProfile, loadMasterCv } from "../profile/candidateProfile.js";
import { LlmBlockedError } from "../runtime/guard.js";
import { scorePosting } from "../scoring/scorePosting.js";

const PER_POSTING_TIMEOUT_MS = 120_000; // includes possible 429 waits on free tiers

async function main(): Promise<number> {
  const config = await loadSearchConfig();
  if (!config.agent.enabled) {
    console.log("Agent paused (agent.enabled=false). Nothing to do.");
    return 0;
  }

  const cv = await loadMasterCv();
  const profile = buildCandidateProfile(cv);

  const pending = (
    await db
      .select({ p: postings })
      .from(postings)
      .leftJoin(postingScores, eq(postingScores.postingId, postings.id))
      .where(
        or(
          eq(postings.status, "new"),
          // approved on a title-only guess, description fetched since: re-score (status stays approved)
          and(eq(postings.status, "approved"), eq(postingScores.confidence, "low"), sql`length(${postings.description}) >= 300`),
        ),
      )
      .orderBy(sql`${postings.postedAt} desc nulls last`) // freshest first: early applications matter most
      .limit(config.scoring.batchSize)
  ).map((r) => r.p);

  if (pending.length === 0) {
    console.log("No new postings to score.");
    return 0;
  }

  let scored = 0;
  let failed = 0;
  for (const posting of pending) {
    try {
      const s = await scorePosting(posting, profile, cv, config, AbortSignal.timeout(PER_POSTING_TIMEOUT_MS));
      const values = {
        postingId: posting.id,
        total: s.total,
        components: s.components,
        recommendation: s.recommendation,
        confidence: s.confidence,
        seniorityMatch: s.seniorityMatch,
        primaryStack: s.primaryStack,
        matchedSkills: s.matchedSkills,
        mustHaveGaps: s.mustHaveGaps,
        reasoning: s.reasoning,
        route: s.route,
        profileHash: profile.hash,
        scoredAt: new Date(),
      };
      await db.transaction(async (tx) => {
        await tx.insert(postingScores).values(values).onConflictDoUpdate({ target: postingScores.postingId, set: values });
        if (posting.status !== "approved") await tx.update(postings).set({ status: "scored" }).where(eq(postings.id, posting.id));
      });
      scored += 1;
      const conf = s.confidence === "low" ? " (title-only)" : "";
      console.log(`[${String(s.total).padStart(3)}] ${s.recommendation.padEnd(5)} ${posting.company} — ${posting.title}${conf} via ${s.route}`);
    } catch (err: unknown) {
      if (err instanceof LlmBlockedError) {
        console.warn(`Stopped: ${err.message}`); // budget/kill switch: remaining postings stay "new" for the next run
        break;
      }
      failed += 1;
      console.error(`Failed to score ${posting.company} — ${posting.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const [remaining] = await db.select({ n: sql<number>`count(*)::int` }).from(postings).where(eq(postings.status, "new"));
  console.log(`Summary: scored=${scored} failed=${failed} stillNew=${remaining?.n ?? 0}`);
  return failed > 0 && scored === 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
