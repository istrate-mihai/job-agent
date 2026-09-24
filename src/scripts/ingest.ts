// src/scripts/ingest.ts
import { loadSearchConfig } from "../config/searchConfig.js";
import { db, pool } from "../db/client.js";
import { postings, type NewPostingRow } from "../db/schema.js";
import { hardFilter } from "../filter/hardFilter.js";
import { buildSources } from "../ingest/sources/index.js";
import { dedupeHash } from "../ingest/text.js";
import type { NormalizedPosting } from "../ingest/types.js";

const SOURCE_TIMEOUT_MS = 30_000;
const INSERT_CHUNK = 500; // ⚡ Perf: stays well under Postgres' 65k bind-parameter limit

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function main(): Promise<number> {
  const config = await loadSearchConfig();
  if (!config.agent.enabled) {
    console.log("Agent paused (agent.enabled=false). Nothing to do.");
    return 0;
  }

  const sources = buildSources(config);
  if (sources.length === 0) {
    console.warn("No sources enabled in config/search-config.yaml");
    return 0;
  }

  const settled = await Promise.allSettled(
    sources.map(async (s) => ({ name: s.name, postings: await s.fetch(AbortSignal.timeout(SOURCE_TIMEOUT_MS)) })),
  );

  const fetched: NormalizedPosting[] = [];
  let failedSources = 0;
  settled.forEach((result, i) => {
    const name = sources[i]?.name ?? `source#${i}`;
    if (result.status === "fulfilled") {
      console.log(`[${name}] fetched ${result.value.postings.length}`);
      fetched.push(...result.value.postings);
    } else {
      failedSources += 1;
      console.error(`[${name}] failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  });

  const now = new Date();
  const rows = new Map<string, NewPostingRow>();
  const reasonCounts = new Map<string, number>();

  for (const p of fetched) {
    const hash = dedupeHash(p);
    if (rows.has(hash)) continue; // same job from two sources in this run
    const result = hardFilter(p, config, now);
    for (const reason of result.reasons) {
      const key = reason.split(":")[0] ?? reason;
      reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
    }
    rows.set(hash, {
      source: p.source,
      sourceId: p.sourceId,
      dedupeHash: hash,
      company: p.company,
      title: p.title,
      url: p.url,
      locationText: p.locationText,
      workMode: p.workMode,
      locationTier: result.tier,
      description: p.description,
      postedAt: p.postedAt,
      status: result.pass ? "new" : "filtered_out", // filtered rows are kept for calibration + to skip re-processing
      filterReasons: result.reasons,
      flags: result.flags,
      raw: p.raw,
    });
  }

  let inserted = 0;
  let insertedPassing = 0;
  for (const batch of chunk([...rows.values()], INSERT_CHUNK)) {
    const res = await db
      .insert(postings)
      .values(batch)
      .onConflictDoNothing() // already seen (dedupe hash or source id) → skip
      .returning({ status: postings.status });
    inserted += res.length;
    insertedPassing += res.filter((r) => r.status === "new").length;
  }

  const passing = [...rows.values()].filter((r) => r.status === "new").length;
  console.log(
    `Summary: fetched=${fetched.length} unique=${rows.size} passedFilter=${passing} ` +
      `newRows=${inserted} newPassing=${insertedPassing} failedSources=${failedSources}/${sources.length}`,
  );
  if (reasonCounts.size > 0) {
    const top = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`Filter reasons: ${top.map(([r, n]) => `${r}=${n}`).join(", ")}`);
  }

  return failedSources === sources.length ? 1 : 0;
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
