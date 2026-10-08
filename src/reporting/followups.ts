// src/reporting/followups.ts
// Applications due a follow-up; shared by `npm run followup` and the GUI.
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { outreach, postings, statusEvents } from "../db/schema.js";

export const FOLLOW_UP_AFTER_DAYS = 7;
export const MAX_FOLLOW_UPS = 2; // a third nudge hurts more than it helps
const DAY_MS = 86_400_000;
// Fully qualified on purpose: in a single-table select drizzle renders ${postings.id} as a bare "id", which inside
// these subqueries would resolve to status_events.id / outreach.id and silently match nothing
const POSTING_ID = sql.raw(`"postings"."id"`);

export async function dueFollowUps() {
  const rows = await db
    .select({
      p: postings,
      appliedAt: sql<Date>`(select max(${statusEvents.createdAt}) from ${statusEvents} where ${statusEvents.postingId} = ${POSTING_ID} and ${statusEvents.toStatus} = 'applied')`,
      lastFollowUp: sql<Date | null>`(select max(${outreach.sentAt}) from ${outreach} where ${outreach.postingId} = ${POSTING_ID} and ${outreach.kind} = 'followup' and ${outreach.status} <> 'drafted')`,
      followUps: sql<number>`(select count(*)::int from ${outreach} where ${outreach.postingId} = ${POSTING_ID} and ${outreach.kind} = 'followup' and ${outreach.status} <> 'drafted')`,
      contact: sql<string | null>`(select ${outreach.recipientName} from ${outreach} where ${outreach.postingId} = ${POSTING_ID} and ${outreach.recipientName} is not null order by ${outreach.createdAt} desc limit 1)`,
      contactEmail: sql<string | null>`(select ${outreach.recipientEmail} from ${outreach} where ${outreach.postingId} = ${POSTING_ID} and ${outreach.recipientEmail} is not null order by ${outreach.createdAt} desc limit 1)`,
    })
    .from(postings)
    .where(eq(postings.status, "applied"));

  const now = Date.now();
  return rows
    .map((r) => ({ ...r, days: r.appliedAt ? Math.floor((now - new Date(r.appliedAt).getTime()) / DAY_MS) : 0 }))
    .filter((r) => r.days >= FOLLOW_UP_AFTER_DAYS && r.followUps < MAX_FOLLOW_UPS)
    .filter((r) => r.lastFollowUp === null || now - new Date(r.lastFollowUp).getTime() >= FOLLOW_UP_AFTER_DAYS * DAY_MS)
    .sort((a, b) => b.days - a.days);

}
