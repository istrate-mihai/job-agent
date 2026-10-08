// src/scripts/stats.ts
// Which applications actually get answers? Response rate by source, score band, location tier and outreach,
// so effort goes where replies come from. Counts only postings you applied to.
import { pool } from "../db/client.js";
import { allBreakdowns } from "../reporting/stats.js";

async function main(): Promise<void> {
  for (const { label, rows } of await allBreakdowns()) {
    console.log(`\n${label}`);
    console.log(`  ${"".padEnd(26)} applied  replied  interview  rejected  silent  reply-rate`);
    for (const r of rows) {
      const rate = r.applied > 0 ? Math.round(((r.responded + r.rejected) / r.applied) * 100) : 0;
      const positive = r.applied > 0 ? Math.round((r.responded / r.applied) * 100) : 0;
      console.log(
        `  ${String(r.bucket ?? "?").slice(0, 26).padEnd(26)} ${String(r.applied).padStart(7)}  ${String(r.responded).padStart(7)}  ${String(r.interview).padStart(9)}  ${String(r.rejected).padStart(8)}  ${String(r.silent).padStart(6)}  ${String(rate).padStart(3)}% (${positive}% positive)`,
      );
    }
  }
  console.log("\nReading it: compare reply-rate between rows; with < 10 applications in a row the difference is noise.");
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
