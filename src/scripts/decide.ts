// src/scripts/decide.ts
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { decisions, postingScores, postings } from "../db/schema.js";

const USAGE = 'Usage: npm run decide -- <id-prefix> approve|skip "optional reason"';

async function main(): Promise<number> {
  const [idPrefix, decisionArg, ...reasonParts] = process.argv.slice(2);
  if (!idPrefix || !/^[0-9a-f-]{4,36}$/i.test(idPrefix) || (decisionArg !== "approve" && decisionArg !== "skip")) {
    console.error(USAGE);
    return 1;
  }
  const decision: "approve" | "skip" = decisionArg;
  const reason = reasonParts.join(" ").trim() || null;

  const matches = await db
    .select({ id: postings.id, company: postings.company, title: postings.title, total: postingScores.total })
    .from(postings)
    .leftJoin(postingScores, eq(postingScores.postingId, postings.id))
    .where(sql`${postings.id}::text like ${`${idPrefix.toLowerCase()}%`}`) // parameterized: prefix is never interpolated into SQL
    .limit(2);

  const match = matches[0];
  if (!match || matches.length > 1) {
    console.error(matches.length > 1 ? `Id prefix "${idPrefix}" is ambiguous; use more characters.` : `No posting with id starting "${idPrefix}".`);
    return 1;
  }

  await db.transaction(async (tx) => {
    await tx.insert(decisions).values({ postingId: match.id, decision, reason, scoreAtDecision: match.total ?? null });
    await tx
      .update(postings)
      .set({ status: decision === "approve" ? "approved" : "skipped" })
      .where(eq(postings.id, match.id));
  });

  console.log(`${decision === "approve" ? "✔ Approved" : "✖ Skipped"}: ${match.company} — ${match.title}${reason ? ` (${reason})` : ""}`);
  return 0;
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
