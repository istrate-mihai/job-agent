// src/scripts/add.ts
// Adds a posting found outside the pipeline (recruiter email, Facebook group, poster, referral).
// With a description file it is scored immediately, then follows the normal flow: decide → tailor → track.
// Usage:
//   npm run add -- "<Company>" "<Title>" [--file jobs/x.txt] [--url <url>] [--location "Brașov"]
//                  [--mode remote|hybrid|onsite] [--applied "where/how"]
//   --applied records an application you already sent (e.g. no description, rejected later via track).
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { loadSearchConfig } from "../config/searchConfig.js";
import { db, pool } from "../db/client.js";
import { postingScores, postings, statusEvents, type NewPostingRow } from "../db/schema.js";
import { hardFilter } from "../filter/hardFilter.js";
import { dedupeHash, htmlToText } from "../ingest/text.js";
import type { NormalizedPosting, WorkMode } from "../ingest/types.js";
import { buildCandidateProfile, loadMasterCv } from "../profile/candidateProfile.js";
import { scorePosting } from "../scoring/scorePosting.js";

const USAGE =
  'Usage: npm run add -- "<Company>" "<Title>" [--file jobs/x.txt] [--url <url>] [--location "City"] [--mode remote|hybrid|onsite] [--applied "note"]';
const MIN_CHARS = 300;
const MODES: readonly WorkMode[] = ["remote", "hybrid", "onsite", "unknown"];

async function main(): Promise<number> {
  const { values: opts, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      file: { type: "string" },
      url: { type: "string" },
      location: { type: "string", default: "" },
      mode: { type: "string", default: "unknown" },
      applied: { type: "string" },
    },
  });
  const [company, title] = positionals.map((s) => s.trim());
  const mode = opts.mode as WorkMode;
  if (!company || !title || !MODES.includes(mode)) {
    console.error(USAGE);
    return 1;
  }
  if (opts.url !== undefined && !/^(https?:\/\/|mailto:)/i.test(opts.url)) {
    console.error(`--url must start with http(s):// or mailto: (got "${opts.url}")`);
    return 1;
  }

  const description = opts.file !== undefined ? htmlToText(await readFile(opts.file, "utf8")) : "";
  if (opts.file !== undefined && description.length < MIN_CHARS) {
    console.error(`Description is only ${description.length} characters; paste the full posting (min ${MIN_CHARS}).`);
    return 1;
  }

  const config = await loadSearchConfig();
  const normalized: NormalizedPosting = {
    source: "manual",
    sourceId: opts.url ?? `manual:${createHash("sha256").update(`${company}|${title}|${opts.location}`).digest("hex").slice(0, 16)}`,
    company,
    title,
    url: opts.url ?? "",
    locationText: opts.location ?? "",
    workMode: mode,
    remoteScope: mode === "remote" ? (opts.location ?? null) : null,
    description,
    postedAt: new Date(),
    raw: { addedBy: "manual" },
  };
  // You chose this posting yourself: filter reasons become flags for the record, never a rejection
  const filter = hardFilter(normalized, config);
  const row: NewPostingRow = {
    source: normalized.source,
    sourceId: normalized.sourceId,
    dedupeHash: dedupeHash(normalized),
    company,
    title,
    url: normalized.url,
    locationText: normalized.locationText,
    workMode: mode,
    locationTier: filter.tier,
    description,
    postedAt: normalized.postedAt,
    status: "new",
    filterReasons: [],
    flags: ["manual", ...filter.flags, ...filter.reasons.map((r) => `filter:${r}`)],
    raw: normalized.raw,
  };

  const [inserted] = await db.insert(postings).values(row).onConflictDoNothing().returning({ id: postings.id });
  if (!inserted) {
    const [existing] = await db.select({ id: postings.id, status: postings.status }).from(postings).where(eq(postings.dedupeHash, row.dedupeHash));
    console.error(`Already stored as [${existing?.id.slice(0, 8) ?? "?"}] (status: ${existing?.status ?? "?"}).`);
    return 1;
  }
  const id = inserted.id;
  const short = id.slice(0, 8);
  console.log(`Added [${short}] ${company} — ${title}${filter.reasons.length > 0 ? `  (filter would have dropped it: ${filter.reasons.join(", ")})` : ""}`);

  if (description !== "") {
    const cv = await loadMasterCv();
    const profile = buildCandidateProfile(cv);
    const [stored] = await db.select().from(postings).where(eq(postings.id, id));
    if (!stored) throw new Error(`Posting ${short} vanished after insert`);
    const s = await scorePosting(stored, profile, cv, config, AbortSignal.timeout(180_000));
    const values = {
      postingId: id,
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
      await tx.update(postings).set({ status: "scored" }).where(eq(postings.id, id));
    });
    console.log(`Score: ${s.total} ${s.recommendation.toUpperCase()} · ${s.primaryStack}`);
    console.log(`Matched: ${s.matchedSkills.join(", ") || "—"}`);
    console.log(`Gaps: ${s.mustHaveGaps.join(", ") || "none"}`);
  }

  if (opts.applied !== undefined) {
    const from = description !== "" ? "scored" : "new";
    await db.transaction(async (tx) => {
      await tx.update(postings).set({ status: "applied" }).where(eq(postings.id, id));
      await tx.insert(statusEvents).values({ postingId: id, fromStatus: from, toStatus: "applied", note: opts.applied || null });
    });
    console.log(`Recorded as applied. Later: npm run track -- ${short} responded|interview|offer|rejected "note"`);
  } else if (description !== "") {
    console.log(`Next: npm run decide -- ${short} approve "reason" && npm run tailor -- ${short}`);
  } else {
    console.log(`No description: add one with npm run describe -- ${short} jobs/<file>.txt, or record it with --applied.`);
  }
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
