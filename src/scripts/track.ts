// src/scripts/track.ts
// Usage: npm run track                                   → application board + follow-up reminders
//        npm run track -- <id-prefix> <status> ["note"] [--force]
//        status: applied | responded | interview | offer | rejected
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { loadSearchConfig } from "../config/searchConfig.js";
import { db, pool } from "../db/client.js";
import { postings, statusEvents, tailorings } from "../db/schema.js";
import { normalizeText } from "../ingest/text.js";

type Status = (typeof postings.$inferSelect)["status"];

const TRANSITIONS: Readonly<Record<string, readonly Status[]>> = {
  applied: ["approved", "tailored"], // never "applied" without your approval
  responded: ["applied"],
  interview: ["applied", "responded"],
  offer: ["interview"],
  rejected: ["applied", "responded", "interview"],
};
const ACTIVE: Status[] = ["applied", "responded", "interview", "offer"];
const FOLLOW_UP_DAYS = 7;
const DAY_MS = 86_400_000;

async function board(): Promise<void> {
  const rows = await db
    .select({
      id: postings.id,
      company: postings.company,
      title: postings.title,
      status: postings.status,
      url: postings.url,
      outputDir: tailorings.outputDir,
      since: sql<Date>`(select max(${statusEvents.createdAt}) from ${statusEvents} where ${statusEvents.postingId} = ${postings.id} and ${statusEvents.toStatus} = ${postings.status})`,
    })
    .from(postings)
    .leftJoin(tailorings, eq(tailorings.postingId, postings.id))
    .where(inArray(postings.status, ["approved", "tailored", ...ACTIVE]))
    .orderBy(postings.status, postings.updatedAt);

  if (rows.length === 0) {
    console.log("No applications in progress.");
    return;
  }
  const now = Date.now();
  for (const r of rows) {
    const days = r.since ? Math.floor((now - new Date(r.since).getTime()) / DAY_MS) : null;
    const age = days === null ? "" : ` · ${days}d`;
    const nudge = r.status === "applied" && days !== null && days >= FOLLOW_UP_DAYS ? "  ← follow up" : "";
    const next = r.status === "approved" ? "  ← npm run tailor" : r.status === "tailored" ? "  ← review + apply" : "";
    console.log(`${r.status.padEnd(10)} [${r.id.slice(0, 8)}] ${r.company} — ${r.title}${age}${nudge}${next}`);
    if (r.status === "tailored" && r.outputDir) console.log(`           ${r.outputDir}`);
  }
}

async function transition(idPrefix: string, target: string, note: string | null, force: boolean): Promise<number> {
  const allowedFrom = TRANSITIONS[target];
  if (!allowedFrom || !/^[0-9a-f-]{4,36}$/i.test(idPrefix)) {
    console.error(`Usage: npm run track -- <id-prefix> ${Object.keys(TRANSITIONS).join("|")} ["note"] [--force]`);
    return 1;
  }
  const matches = await db
    .select({ id: postings.id, company: postings.company, title: postings.title, status: postings.status })
    .from(postings)
    .where(sql`${postings.id}::text like ${`${idPrefix.toLowerCase()}%`}`)
    .limit(2);
  const p = matches[0];
  if (!p || matches.length > 1) {
    console.error(matches.length > 1 ? `Id prefix "${idPrefix}" is ambiguous.` : `No posting with id starting "${idPrefix}".`);
    return 1;
  }
  if (!allowedFrom.includes(p.status)) {
    console.error(`Cannot go from "${p.status}" to "${target}" (allowed from: ${allowedFrom.join(", ")}).`);
    return 1;
  }

  if (target === "applied" && !force) {
    // One strong application per company per cooldown window
    const config = await loadSearchConfig();
    const cutoff = new Date(Date.now() - config.limits.perCompanyCooldownDays * DAY_MS);
    const recent = await db
      .select({ company: postings.company, title: postings.title, at: statusEvents.createdAt })
      .from(statusEvents)
      .innerJoin(postings, eq(postings.id, statusEvents.postingId))
      .where(and(eq(statusEvents.toStatus, "applied"), gte(statusEvents.createdAt, cutoff), ne(postings.id, p.id)));
    const clash = recent.find((r) => normalizeText(r.company) === normalizeText(p.company));
    if (clash) {
      console.error(
        `Already applied to ${clash.company} (${clash.title}) on ${clash.at.toISOString().slice(0, 10)}; cooldown is ${config.limits.perCompanyCooldownDays} days. Use --force to override.`,
      );
      return 1;
    }
  }

  const to = target as Status;
  await db.transaction(async (tx) => {
    await tx.update(postings).set({ status: to }).where(eq(postings.id, p.id));
    await tx.insert(statusEvents).values({ postingId: p.id, fromStatus: p.status, toStatus: to, note });
  });
  console.log(`${p.company} — ${p.title}: ${p.status} → ${to}${note ? ` (${note})` : ""}`);
  return 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const [idPrefix, target, ...noteParts] = args.filter((a) => a !== "--force");
  if (idPrefix === undefined) {
    await board();
    return 0;
  }
  return transition(idPrefix, target ?? "", noteParts.join(" ").trim() || null, force);
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
