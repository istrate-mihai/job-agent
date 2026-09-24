// src/scripts/tailor.ts
// Usage: npm run tailor               → tailor approved postings (freshest high scores first)
//        npm run tailor -- <id-prefix> → (re-)tailor one approved or tailored posting
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desc, eq, sql } from "drizzle-orm";
import { loadSearchConfig } from "../config/searchConfig.js";
import { renderFittedCv } from "../cv/renderPdf.js";
import { db, pool } from "../db/client.js";
import { postingScores, postings, statusEvents, tailorings, type PostingRow, type PostingScoreRow } from "../db/schema.js";
import { normalizeText } from "../ingest/text.js";
import { buildCandidateProfile, loadMasterCv } from "../profile/candidateProfile.js";
import { LlmBlockedError } from "../runtime/guard.js";
import { renderDiff } from "../tailoring/diff.js";
import { tailorPosting } from "../tailoring/tailorPosting.js";

const PER_POSTING_TIMEOUT_MS = 240_000; // two LLM calls worst case, plus free-tier 429 waits

const slug = (value: string, max = 40): string =>
  normalizeText(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");

async function selectTargets(idPrefix: string | undefined, limit: number): Promise<{ p: PostingRow; s: PostingScoreRow | null }[]> {
  const base = db.select({ p: postings, s: postingScores }).from(postings).leftJoin(postingScores, eq(postingScores.postingId, postings.id));

  if (idPrefix !== undefined) {
    if (!/^[0-9a-f-]{4,36}$/i.test(idPrefix)) throw new Error(`Invalid id prefix "${idPrefix}"`);
    const rows = await base.where(sql`${postings.id}::text like ${`${idPrefix.toLowerCase()}%`}`).limit(2);
    const row = rows[0];
    if (!row || rows.length > 1) throw new Error(rows.length > 1 ? `Id prefix "${idPrefix}" is ambiguous` : `No posting with id starting "${idPrefix}"`);
    if (row.p.status !== "approved" && row.p.status !== "tailored") {
      throw new Error(`Posting is "${row.p.status}". Approve it first: npm run decide -- ${idPrefix} approve`);
    }
    return [row];
  }

  return base
    .where(eq(postings.status, "approved"))
    .orderBy(desc(postingScores.total), sql`${postings.postedAt} desc nulls last`)
    .limit(limit);
}

async function main(): Promise<number> {
  const config = await loadSearchConfig();
  if (!config.agent.enabled) {
    console.log("Agent paused (agent.enabled=false). Nothing to do.");
    return 0;
  }
  const idPrefix = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const cv = await loadMasterCv();
  const profileHash = buildCandidateProfile(cv).hash;

  const targets = await selectTargets(idPrefix, config.tailoring.batchSize);
  if (targets.length === 0) {
    console.log("No approved postings to tailor. Approve one: npm run decide -- <id> approve");
    return 0;
  }

  let done = 0;
  let failed = 0;
  for (const { p, s } of targets) {
    try {
      const t = await tailorPosting(p, s, cv, config, AbortSignal.timeout(PER_POSTING_TIMEOUT_MS));
      const rendered = await renderFittedCv(cv, t.selection, t.summary, t.availability, {
        maxPages: config.tailoring.maxPages,
        photoPath: config.tailoring.photoPath,
        title: `${cv.basics.fullName} — CV — ${p.title} at ${p.company}`,
      });

      const date = new Date().toISOString().slice(0, 10);
      const outDir = join(config.tailoring.outputDir, `${date}_${slug(p.company, 30)}_${slug(p.title)}_${p.id.slice(0, 8)}`);
      const pdfName = `${cv.basics.fullName.replace(/\s+/g, "_")}_CV_${slug(p.company, 30) || "company"}.pdf`;
      const warnings = [...t.warnings];
      if (rendered.pages > config.tailoring.maxPages) warnings.push(`still ${rendered.pages} pages after all trims`);

      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, pdfName), rendered.pdf);
      await writeFile(join(outDir, "cover-note.txt"), `${t.coverNote}\n\n${cv.basics.fullName}\n${cv.basics.email} | ${cv.basics.phone}\n`, "utf8");
      await writeFile(
        join(outDir, "diff.md"),
        renderDiff({
          posting: p,
          score: s,
          cv,
          selection: rendered.selection,
          summary: t.summary,
          coverNote: t.coverNote,
          postingKeywords: t.postingKeywords,
          availability: t.availability,
          route: t.route,
          pages: rendered.pages,
          trims: rendered.trims,
          notes: t.notes,
          warnings,
        }),
        "utf8",
      );
      await writeFile(
        join(outDir, "tailoring.json"),
        JSON.stringify({ postingId: p.id, url: p.url, ...t, selection: rendered.selection, trims: rendered.trims, warnings }, null, 2),
        "utf8",
      );

      const row = {
        postingId: p.id,
        selection: rendered.selection,
        summary: t.summary,
        coverNote: t.coverNote,
        language: t.language,
        warnings,
        route: t.route,
        profileHash,
        outputDir: outDir,
        pdfPages: rendered.pages,
        createdAt: new Date(),
      };
      await db.transaction(async (tx) => {
        await tx.insert(tailorings).values(row).onConflictDoUpdate({ target: tailorings.postingId, set: row });
        if (p.status === "approved") {
          await tx.update(postings).set({ status: "tailored" }).where(eq(postings.id, p.id));
          await tx.insert(statusEvents).values({ postingId: p.id, fromStatus: "approved", toStatus: "tailored" });
        }
      });

      done += 1;
      const warn = warnings.length > 0 ? ` · ⚠ ${warnings.length} warning(s), see diff.md` : "";
      console.log(`[${s?.total ?? "--"}] ${p.company} — ${p.title} → ${join(outDir, pdfName)} (${rendered.pages}p, ${t.route})${warn}`);
    } catch (err: unknown) {
      if (err instanceof LlmBlockedError) {
        console.warn(`Stopped: ${err.message}`);
        break;
      }
      failed += 1;
      console.error(`Failed to tailor ${p.company} — ${p.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`Summary: tailored=${done} failed=${failed}. Review diff.md, then after applying: npm run track -- <id> applied`);
  return failed > 0 && done === 0 ? 1 : 0;
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
