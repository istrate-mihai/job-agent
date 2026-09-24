// src/scripts/refilter.ts
// Re-runs the hard filter on stored postings (no network, no LLM). Use after changing titles,
// locations, blocklist or age rules: postings rejected under the old rules get a second chance.
// Usage: npm run refilter            → re-check filtered_out postings
//        npm run refilter -- --all   → also re-check "new" postings (not yet scored)
import { eq, inArray } from "drizzle-orm";
import { loadSearchConfig } from "../config/searchConfig.js";
import { db, pool } from "../db/client.js";
import { postings } from "../db/schema.js";
import { hardFilter } from "../filter/hardFilter.js";
import type { NormalizedPosting } from "../ingest/types.js";

async function main(): Promise<void> {
  const config = await loadSearchConfig();
  const statuses: ("filtered_out" | "new")[] = process.argv.includes("--all") ? ["filtered_out", "new"] : ["filtered_out"];
  const rows = await db.select().from(postings).where(inArray(postings.status, statuses));

  const now = new Date();
  let revived = 0;
  let dropped = 0;
  for (const row of rows) {
    const posting: NormalizedPosting = {
      source: row.source,
      sourceId: row.sourceId,
      company: row.company,
      title: row.title,
      url: row.url,
      locationText: row.locationText,
      workMode: row.workMode,
      remoteScope: row.workMode === "remote" ? row.locationText : null, // how every source stores remote scope
      description: row.description,
      postedAt: row.postedAt,
      raw: row.raw,
    };
    const result = hardFilter(posting, config, now);
    const status = result.pass ? "new" : "filtered_out";
    if (status !== row.status) {
      if (status === "new") revived += 1;
      else dropped += 1;
      console.log(`${status === "new" ? "↑ now passes" : "↓ now filtered"}: ${row.company} — ${row.title}${result.reasons.length > 0 ? ` (${result.reasons.join(", ")})` : ""}`);
    }
    await db
      .update(postings)
      .set({ status, locationTier: result.tier, filterReasons: result.reasons, flags: result.flags })
      .where(eq(postings.id, row.id));
  }
  console.log(`Summary: checked=${rows.length} nowPassing=${revived} nowFiltered=${dropped}${revived > 0 ? ". Next: npm run score && npm run digest" : ""}`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
