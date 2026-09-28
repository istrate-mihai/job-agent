// src/scripts/enrich.ts
// Fills in descriptions for title-only postings (job-alert emails), drops closed ones, and queues re-scoring.
// Runs automatically in `npm run pipeline`. Usage: npm run enrich [-- --retry]  (--retry: also postings that failed before)
import { setTimeout as sleep } from "node:timers/promises";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { loadSearchConfig } from "../config/searchConfig.js";
import { db, pool } from "../db/client.js";
import { postings, statusEvents } from "../db/schema.js";
import { hardFilter } from "../filter/hardFilter.js";
import { fetchDescription } from "../ingest/enrich/fetchDescription.js";

const TITLE_ONLY_CHARS = 300;
const NO_DESCRIPTION_FLAG = "no-description";

async function main(): Promise<void> {
  const config = await loadSearchConfig();
  const { enabled, linkedin, maxPerRun, delaySeconds } = config.enrich;
  if (!config.agent.enabled || !enabled) {
    console.log("Enrichment disabled (agent.enabled or enrich.enabled is false).");
    return;
  }
  const retry = process.argv.includes("--retry");

  const candidates = await db
    .select()
    .from(postings)
    .where(
      and(
        inArray(postings.status, ["new", "scored", "approved"]),
        ne(postings.source, "simulation"),
        sql`length(${postings.description}) < ${TITLE_ONLY_CHARS}`,
        retry ? sql`true` : sql`not (${postings.flags} ? ${NO_DESCRIPTION_FLAG})`,
      ),
    )
    .orderBy(sql`${postings.postedAt} desc nulls last`)
    .limit(maxPerRun);

  if (candidates.length === 0) {
    console.log("No title-only postings to enrich.");
    return;
  }

  const counts = { enriched: 0, closed: 0, unavailable: 0 };
  for (const [i, p] of candidates.entries()) {
    if (i > 0) await sleep(delaySeconds * 1000); // polite, low-volume access
    let result;
    try {
      result = await fetchDescription(p.url, { linkedin, signal: AbortSignal.timeout(20_000) });
    } catch (err: unknown) {
      result = { status: "unavailable" as const, reason: err instanceof Error ? err.message : String(err) };
    }

    if (result.status === "rate-limited") {
      console.warn(`Stopped: ${result.reason}. The remaining ${candidates.length - i} posting(s) are retried next run.`);
      break;
    }

    if (result.status === "closed") {
      counts.closed += 1;
      await db.transaction(async (tx) => {
        await tx.update(postings).set({ status: "filtered_out", filterReasons: ["closed"] }).where(eq(postings.id, p.id));
        if (p.status === "approved") await tx.insert(statusEvents).values({ postingId: p.id, fromStatus: "approved", toStatus: "filtered_out", note: `closed: ${result.reason}` });
      });
      console.log(`✖ closed  ${p.company} — ${p.title} (${result.reason})${p.status === "approved" ? "  ← was approved" : ""}`);
      continue;
    }

    if (result.status === "unavailable") {
      counts.unavailable += 1;
      await db.update(postings).set({ flags: [...new Set([...p.flags, NO_DESCRIPTION_FLAG])] }).where(eq(postings.id, p.id));
      console.log(`?  no text ${p.company} — ${p.title} (${result.reason})`);
      continue;
    }

    // Description found: re-run the free filter (it may reveal e.g. required German), then queue re-scoring
    const filter = hardFilter({ ...p, description: result.description, remoteScope: p.workMode === "remote" ? p.locationText : null }, config);
    const nextStatus = !filter.pass ? "filtered_out" : p.status === "scored" ? "new" : p.status; // approved stays approved
    await db
      .update(postings)
      .set({ description: result.description, flags: filter.flags.filter((f) => f !== NO_DESCRIPTION_FLAG), filterReasons: filter.reasons, status: nextStatus })
      .where(eq(postings.id, p.id));
    counts.enriched += 1;
    const note = !filter.pass ? `  → now filtered: ${filter.reasons.join(", ")}` : nextStatus === "new" ? "  → will be re-scored" : "";
    console.log(`✔ ${result.via.padEnd(8)} ${p.company} — ${p.title} (${result.description.length} chars)${note}`);
  }

  console.log(`Enrich: ${counts.enriched} described, ${counts.closed} closed, ${counts.unavailable} without text (of ${candidates.length})`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
