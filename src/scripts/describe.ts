// src/scripts/describe.ts
// Adds the real job description to a title-only posting (copied by you from the job page),
// then re-scores it, so scoring and tailoring work from actual requirements instead of a guess.
// Usage: npm run describe -- <id-prefix> <file.txt>
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { loadSearchConfig } from "../config/searchConfig.js";
import { db, pool } from "../db/client.js";
import { postingScores, postings } from "../db/schema.js";
import { hardFilter } from "../filter/hardFilter.js";
import { htmlToText } from "../ingest/text.js";
import { buildCandidateProfile, loadMasterCv } from "../profile/candidateProfile.js";
import { scorePosting } from "../scoring/scorePosting.js";

const MIN_CHARS = 300;

async function main(): Promise<number> {
  const [idPrefix, file] = process.argv.slice(2);
  if (!idPrefix || !file || !/^[0-9a-f-]{4,36}$/i.test(idPrefix)) {
    console.error("Usage: npm run describe -- <id-prefix> <file.txt>");
    return 1;
  }
  const description = htmlToText(await readFile(file, "utf8")); // also accepts pasted HTML
  if (description.length < MIN_CHARS) {
    console.error(`Description is only ${description.length} characters; paste the full posting (min ${MIN_CHARS}).`);
    return 1;
  }

  const rows = await db.select().from(postings).where(sql`${postings.id}::text like ${`${idPrefix.toLowerCase()}%`}`).limit(2);
  const posting = rows[0];
  if (!posting || rows.length > 1) {
    console.error(rows.length > 1 ? `Id prefix "${idPrefix}" is ambiguous.` : `No posting with id starting "${idPrefix}".`);
    return 1;
  }

  const config = await loadSearchConfig();
  const cv = await loadMasterCv();
  const profile = buildCandidateProfile(cv);
  const [old] = await db.select({ total: postingScores.total }).from(postingScores).where(eq(postingScores.postingId, posting.id));

  // Re-run the free filter too: the description can reveal a required language (e.g. German)
  const filter = hardFilter({ ...posting, description, remoteScope: posting.workMode === "remote" ? posting.locationText : null }, config);
  const updated = { ...posting, description, flags: filter.flags };
  const s = await scorePosting(updated, profile, cv, config, AbortSignal.timeout(180_000));

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
    const status = posting.status === "new" ? "scored" : posting.status; // an approval stays an approval
    await tx.update(postings).set({ description, flags: filter.flags, status }).where(eq(postings.id, posting.id));
    await tx.insert(postingScores).values(values).onConflictDoUpdate({ target: postingScores.postingId, set: values });
  });

  console.log(`${posting.company} — ${posting.title}`);
  console.log(`Score: ${old?.total ?? "n/a"} (title-only guess) → ${s.total} ${s.recommendation.toUpperCase()} (from the real description)`);
  console.log(`Stack: ${s.primaryStack}`);
  console.log(`Matched: ${s.matchedSkills.join(", ") || "—"}`);
  console.log(`Gaps: ${s.mustHaveGaps.join(", ") || "none"}`);
  if (s.components.penalties.length > 0) console.log(`Penalty: ${s.components.penalties.join("; ")}`);
  console.log(
    posting.status === "approved"
      ? `Still approved. If the gaps change your mind: npm run decide -- ${idPrefix} skip "reason"; otherwise: npm run tailor -- ${idPrefix}`
      : `Decide: npm run decide -- ${idPrefix} approve|skip "reason"`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
