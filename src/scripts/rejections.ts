// src/scripts/rejections.ts
// Finds rejection emails in Gmail for applications you are tracking. No LLM, so it is free.
// Usage: npm run rejections                  → scan the last 30 days: high-confidence matches are marked rejected
//                                             (undo-able), the rest wait in the GUI (Applications) for you
//        npm run rejections -- --days 60     → scan further back
//        npm run rejections -- confirm <id>  → mark that application rejected
//        npm run rejections -- ignore <id>   → not a rejection; never suggested again
//        npm run rejections -- undo <id>     → revert an automatic rejection
// ⚠ Security: Gmail is read-only here; email text is untrusted and only matched against fixed phrase lists.
import { eq, inArray, sql } from "drizzle-orm";
import { google } from "googleapis";
import { db, pool } from "../db/client.js";
import { postings, rejectionCandidates, statusEvents } from "../db/schema.js";
import { loadGmailAuth } from "../ingest/gmail/auth.js";
import { parseMessage } from "../ingest/gmail/message.js";
import { classifyRejection, rejectionQuery, type ApplicationForMatching } from "../reporting/rejections.js";

type Status = (typeof postings.$inferSelect)["status"];

const REJECTABLE: Status[] = ["applied", "responded", "interview"]; // same as `npm run track -- <id> rejected`
const DEFAULT_DAYS = 30;
const MAX_MESSAGES = 100; // ⚡ Perf: the query pre-filters; a normal month yields far fewer
const ID_RE = /^[0-9a-f-]{4,36}$/i;

async function applications(): Promise<ApplicationForMatching[]> {
  const rows = await db
    .select({
      id: postings.id,
      company: postings.company,
      title: postings.title,
      appliedAt: sql<Date | null>`(select max(${statusEvents.createdAt}) from ${statusEvents} where ${statusEvents.postingId} = ${sql.raw(`"postings"."id"`)} and ${statusEvents.toStatus} = 'applied')`,
    })
    .from(postings)
    .where(inArray(postings.status, REJECTABLE));
  return rows.map((r) => ({ ...r, appliedAt: r.appliedAt ? new Date(r.appliedAt) : null }));
}

/** Marks the posting rejected and records why; returns the status it had, or null if it can no longer be rejected. */
async function reject(postingId: string, note: string): Promise<Status | null> {
  return db.transaction(async (tx) => {
    const [p] = await tx.select({ status: postings.status }).from(postings).where(eq(postings.id, postingId)).for("update");
    if (!p || !REJECTABLE.includes(p.status)) return null;
    await tx.update(postings).set({ status: "rejected" }).where(eq(postings.id, postingId));
    await tx.insert(statusEvents).values({ postingId, fromStatus: p.status, toStatus: "rejected", note });
    return p.status;
  });
}

async function scan(days: number): Promise<number> {
  let auth;
  try {
    auth = await loadGmailAuth();
  } catch (err: unknown) {
    // Not fatal: the daily run continues without this step
    console.warn(`Rejection check skipped: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
  const apps = await applications();
  if (apps.length === 0) {
    console.log("No applications waiting for an answer: nothing to check.");
    return 0;
  }

  const gmail = google.gmail({ version: "v1", auth });
  let list;
  try {
    list = await gmail.users.messages.list({ userId: "me", q: rejectionQuery(days), maxResults: MAX_MESSAGES });
  } catch (err: unknown) {
    console.warn(`Rejection check skipped: Gmail unreachable (${err instanceof Error ? err.message : String(err)})`);
    return 0;
  }
  const ids = (list.data.messages ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  const known = ids.length ? await db.select({ id: rejectionCandidates.messageId }).from(rejectionCandidates).where(inArray(rejectionCandidates.messageId, ids)) : [];
  const knownIds = new Set(known.map((k) => k.id));
  const fresh = ids.filter((id) => !knownIds.has(id));
  console.log(`Checked ${ids.length} possible rejection email(s) from the last ${days} days, ${fresh.length} new.`);

  const byId = new Map(apps.map((a) => [a.id, a]));
  let auto = 0;
  let pending = 0;
  for (const messageId of fresh) {
    const { data } = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    const email = parseMessage(data);
    const base = {
      messageId,
      threadId: data.threadId ?? null,
      subject: email.subject.slice(0, 500),
      sender: email.from.slice(0, 300),
      receivedAt: email.receivedAt,
    };
    const matches = classifyRejection(email, apps);
    if (matches.length === 0) {
      await db.insert(rejectionCandidates).values({ ...base, status: "unmatched" }).onConflictDoNothing();
      continue;
    }
    for (const m of matches) {
      const app = byId.get(m.postingId);
      const row = { ...base, postingId: m.postingId, confidence: m.confidence, snippet: m.snippet.slice(0, 600), reason: m.reason.slice(0, 300) };
      if (m.confidence === "high") {
        const previous = await reject(m.postingId, `auto: rejection email "${email.subject.slice(0, 120)}"`);
        if (previous) {
          await db.insert(rejectionCandidates).values({ ...row, status: "auto", previousStatus: previous, resolvedAt: new Date() }).onConflictDoNothing();
          auto += 1;
          console.log(`✔ auto-rejected  ${app?.company} — ${app?.title}  ("${email.subject.slice(0, 60)}")`);
          continue;
        }
      }
      await db.insert(rejectionCandidates).values({ ...row, status: "pending" }).onConflictDoNothing();
      pending += 1;
      console.log(`? to confirm     ${app?.company} — ${app?.title}  ("${email.subject.slice(0, 60)}") · ${m.reason}`);
    }
  }
  console.log(`Summary: auto-rejected=${auto} to-confirm=${pending}${pending ? " → Applications in the GUI, or npm run rejections -- confirm|ignore <id>" : ""}`);
  return 0;
}

async function findCandidate(prefix: string) {
  if (!ID_RE.test(prefix)) throw new Error(`Invalid id "${prefix}"`);
  const rows = await db
    .select()
    .from(rejectionCandidates)
    .where(sql`${rejectionCandidates.id}::text like ${`${prefix.toLowerCase()}%`}`)
    .limit(2);
  const row = rows[0];
  if (!row || rows.length > 1) throw new Error(rows.length > 1 ? `Id "${prefix}" is ambiguous` : `No rejection candidate with id starting "${prefix}"`);
  return row;
}

async function resolve(action: string, prefix: string): Promise<number> {
  const c = await findCandidate(prefix);
  const label = `"${c.subject.slice(0, 60)}"`;

  if (action === "ignore") {
    await db.update(rejectionCandidates).set({ status: "ignored", resolvedAt: new Date() }).where(eq(rejectionCandidates.id, c.id));
    console.log(`Ignored ${label}: it won't be suggested again.`);
    return 0;
  }

  if (!c.postingId) throw new Error("This email matched no application.");

  if (action === "confirm") {
    if (c.status !== "pending") throw new Error(`Already ${c.status}.`);
    const previous = await reject(c.postingId, `rejection email "${c.subject.slice(0, 120)}"`);
    if (!previous) throw new Error("The application is no longer applied/responded/interview: nothing to reject.");
    await db.update(rejectionCandidates).set({ status: "confirmed", previousStatus: previous, resolvedAt: new Date() }).where(eq(rejectionCandidates.id, c.id));
    // The same email may have been suggested for other roles at this company: those stay pending for you
    console.log(`Marked rejected (${label}).`);
    return 0;
  }

  if (action === "undo") {
    if (c.status !== "auto" && c.status !== "confirmed") throw new Error(`Nothing to undo (status: ${c.status}).`);
    const restored = c.previousStatus ?? "applied";
    const done = await db.transaction(async (tx) => {
      const [p] = await tx.select({ status: postings.status }).from(postings).where(eq(postings.id, c.postingId!)).for("update");
      if (p?.status !== "rejected") return false; // moved on since (e.g. you marked an interview): leave it alone
      await tx.update(postings).set({ status: restored }).where(eq(postings.id, c.postingId!));
      await tx.insert(statusEvents).values({ postingId: c.postingId!, fromStatus: "rejected", toStatus: restored, note: `undo: not a rejection (${label})` });
      await tx.update(rejectionCandidates).set({ status: "undone", resolvedAt: new Date() }).where(eq(rejectionCandidates.id, c.id));
      return true;
    });
    if (!done) throw new Error("The application is no longer rejected: nothing to undo.");
    console.log(`Restored to ${restored} (${label}).`);
    return 0;
  }

  console.error("Usage: npm run rejections [-- --days N] | -- confirm|ignore|undo <id>");
  return 1;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const [action, id] = args;
  if (action && ["confirm", "ignore", "undo"].includes(action)) {
    if (!id) {
      console.error(`Usage: npm run rejections -- ${action} <id>`);
      return 1;
    }
    return resolve(action, id);
  }
  const daysAt = args.indexOf("--days");
  const days = daysAt >= 0 ? Number(args[daysAt + 1]) : DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    console.error("--days must be a whole number between 1 and 365");
    return 1;
  }
  return scan(days);
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
