// src/scripts/followup.ts
// Applied ≥7 days ago, no answer, no follow-up in the last 7 days → ready-to-send follow-up text (no LLM, free).
// Usage: npm run followup                    → list + messages, saved to output/followups/<date>.md
//        npm run followup -- <id> sent       → log that you sent it (silences the reminder for 7 days)
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { loadSearchConfig } from "../config/searchConfig.js";
import { db, pool } from "../db/client.js";
import { outreach, postings } from "../db/schema.js";
import { dueFollowUps, FOLLOW_UP_AFTER_DAYS } from "../reporting/followups.js";
import { followUpMessage, recruiterSearchLinks } from "../outreach/compose.js";
import { loadMasterCv } from "../profile/candidateProfile.js";


async function list(): Promise<number> {
  const config = await loadSearchConfig();
  const cv = await loadMasterCv();
  const due = await dueFollowUps();

  if (due.length === 0) {
    console.log("No follow-ups due.");
    return 0;
  }

  const sections: string[] = [`# Follow-ups — ${new Date().toISOString().slice(0, 10)}`, ""];
  for (const r of due) {
    const msg = followUpMessage(r.p, cv, r.days, r.contact);
    const where = r.contactEmail ? `email ${r.contactEmail}` : r.contact ? `LinkedIn: ${r.contact}` : "no contact yet → find one first";
    console.log(`\n[${r.p.id.slice(0, 8)}] ${r.p.company} — ${r.p.title} · applied ${r.days}d ago · ${where}`);
    if (!r.contact) console.log(`  ${recruiterSearchLinks(r.p.company, r.p.title)[0]?.url ?? ""}`);
    sections.push(
      `## ${r.p.company} — ${r.p.title}`,
      `- id: ${r.p.id.slice(0, 8)} · applied ${r.days} days ago · follow-up #${r.followUps + 1} · ${where}`,
      `- Posting: ${r.p.url}`,
      ...(r.contact ? [] : recruiterSearchLinks(r.p.company, r.p.title).slice(0, 2).map((l) => `- [${l.label}](${l.url})`)),
      "",
      `**Subject:** ${msg.subject}`,
      "",
      msg.body,
      "",
      `After sending: \`npm run followup -- ${r.p.id.slice(0, 8)} sent\``,
      "",
    );
  }
  const dir = join(config.tailoring.outputDir, "..", "followups");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().slice(0, 10)}.md`);
  await writeFile(file, sections.join("\n"), "utf8");
  console.log(`\n${due.length} follow-up(s) due. Messages: ${file}`);
  console.log("No reply after 2 follow-ups → let it go: npm run track -- <id> rejected \"no response\"");
  return 0;
}

async function markSent(idPrefix: string): Promise<number> {
  if (!/^[0-9a-f-]{4,36}$/i.test(idPrefix)) {
    console.error("Usage: npm run followup -- <id-prefix> sent");
    return 1;
  }
  const rows = await db
    .select({ id: postings.id, company: postings.company, title: postings.title })
    .from(postings)
    .where(sql`${postings.id}::text like ${`${idPrefix.toLowerCase()}%`}`)
    .limit(2);
  const p = rows[0];
  if (!p || rows.length > 1) {
    console.error(rows.length > 1 ? `Id prefix "${idPrefix}" is ambiguous.` : `No posting with id starting "${idPrefix}".`);
    return 1;
  }
  const [drafted] = await db
    .select({ id: outreach.id })
    .from(outreach)
    .where(and(eq(outreach.postingId, p.id), eq(outreach.kind, "followup"), eq(outreach.status, "drafted")))
    .limit(1);
  if (drafted) await db.update(outreach).set({ status: "sent", sentAt: new Date() }).where(eq(outreach.id, drafted.id));
  else await db.insert(outreach).values({ postingId: p.id, kind: "followup", status: "sent", body: "(follow-up template)", sentAt: new Date() });
  console.log(`✔ Follow-up logged: ${p.company} — ${p.title}. Next reminder in ${FOLLOW_UP_AFTER_DAYS} days if still silent.`);
  return 0;
}

async function main(): Promise<number> {
  const [idPrefix, action] = process.argv.slice(2);
  if (idPrefix === undefined) return list();
  if (action !== "sent") {
    console.error("Usage: npm run followup  |  npm run followup -- <id-prefix> sent");
    return 1;
  }
  return markSent(idPrefix);
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
