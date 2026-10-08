// src/scripts/outreach.ts
// Reach a human instead of only the ATS. Drafts messages; YOU send them (LinkedIn has no API for this and
// automated messaging gets accounts restricted).
// Usage: npm run outreach                                   → who to contact next (tailored/applied, no outreach yet)
//        npm run outreach -- <id> [--to "Ana Pop"] [--role recruiter|hiring-manager|engineer] [--email ana@firma.ro]
//                                   → drafts connection note + LinkedIn message + email, prints recruiter search links;
//                                     with --email also creates a Gmail DRAFT with the tailored CV attached
//        npm run outreach -- sent <id> [connect|message|email]   → you sent it (default: message)
//        npm run outreach -- replied <id>                        → they answered (also moves the posting to "responded")
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { loadSearchConfig } from "../config/searchConfig.js";
import { db, pool } from "../db/client.js";
import { outreach, postingScores, postings, statusEvents, tailorings } from "../db/schema.js";
import { normalizeText } from "../ingest/text.js";
import { composeOutreach, RECIPIENT_ROLES, recruiterSearchLinks, type RecipientRole } from "../outreach/compose.js";
import { createGmailDraft } from "../outreach/gmailDraft.js";
import { loadMasterCv } from "../profile/candidateProfile.js";
import { LlmBlockedError } from "../runtime/guard.js";
import { availabilityFor } from "../tailoring/tailorPosting.js";

const USAGE = `Usage:
  npm run outreach
  npm run outreach -- <id> [--to "Name"] [--role ${RECIPIENT_ROLES.join("|")}] [--email someone@company.com]
  npm run outreach -- sent <id> [connect|message|email]
  npm run outreach -- replied <id>`;

function option(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  const value = i >= 0 ? args[i + 1] : undefined;
  return value !== undefined && !value.startsWith("--") ? value : null;
}

async function findPosting(idPrefix: string) {
  if (!/^[0-9a-f-]{4,36}$/i.test(idPrefix)) throw new Error(`Invalid id prefix "${idPrefix}"`);
  const rows = await db
    .select({ p: postings, s: postingScores, t: tailorings })
    .from(postings)
    .leftJoin(postingScores, eq(postingScores.postingId, postings.id))
    .leftJoin(tailorings, eq(tailorings.postingId, postings.id))
    .where(sql`${postings.id}::text like ${`${idPrefix.toLowerCase()}%`}`)
    .limit(2);
  const row = rows[0];
  if (!row || rows.length > 1) throw new Error(rows.length > 1 ? `Id prefix "${idPrefix}" is ambiguous` : `No posting with id starting "${idPrefix}"`);
  return row;
}

async function cvPdf(outputDir: string | null | undefined): Promise<string | null> {
  if (!outputDir) return null;
  try {
    const file = (await readdir(outputDir)).find((f) => f.endsWith("_CV.pdf"));
    return file ? join(outputDir, file) : null;
  } catch {
    return null;
  }
}

async function suggestions(): Promise<number> {
  const rows = await db
    .select({ id: postings.id, company: postings.company, title: postings.title, status: postings.status, total: postingScores.total })
    .from(postings)
    .leftJoin(postingScores, eq(postingScores.postingId, postings.id))
    .where(
      and(
        inArray(postings.status, ["tailored", "applied"]),
        sql`not exists (select 1 from ${outreach} where ${outreach.postingId} = ${sql.raw(`"postings"."id"`)} and ${outreach.kind} <> 'followup' and ${outreach.status} <> 'drafted')`,
      ),
    )
    .orderBy(desc(postingScores.total));
  if (rows.length === 0) {
    console.log("Every tailored/applied posting already has outreach sent.");
    return 0;
  }
  console.log("No recruiter contacted yet (highest score first). A message to a real person gets read; an ATS submission often does not:\n");
  for (const r of rows) {
    console.log(`  ${String(r.total ?? "--").padStart(3)}  ${r.status.padEnd(8)} [${r.id.slice(0, 8)}] ${r.company} — ${r.title}`);
  }
  console.log(`\nDraft one: npm run outreach -- <id> --role recruiter   (add --to "Name" once you found the person)`);
  return 0;
}

async function compose(idPrefix: string, args: string[]): Promise<number> {
  const roleArg = option(args, "--role") ?? "recruiter";
  if (!(RECIPIENT_ROLES as readonly string[]).includes(roleArg)) {
    console.error(`--role must be one of: ${RECIPIENT_ROLES.join(", ")}`);
    return 1;
  }
  const role = roleArg as RecipientRole;
  const name = option(args, "--to");
  const email = option(args, "--email");

  const { p, s, t } = await findPosting(idPrefix);
  const config = await loadSearchConfig();
  const cv = await loadMasterCv();
  if (p.description.trim().length < 300) console.warn("⚠ No job description stored: messages will be generic. Run: npm run describe -- <id> <file.txt>");

  const draft = await composeOutreach(p, s, t?.selection ?? null, cv, config, { name, role }, availabilityFor(p, config), AbortSignal.timeout(180_000));
  const links = recruiterSearchLinks(p.company, p.title);

  const date = new Date().toISOString().slice(0, 10);
  const dir = t?.outputDir ?? join(config.tailoring.outputDir, "outreach");
  await mkdir(dir, { recursive: true });
  const slug = normalizeText(`${p.company} ${role} ${name ?? ""}`).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  const file = join(dir, `outreach_${date}_${slug}.md`);

  const pdf = await cvPdf(t?.outputDir);
  let gmailDraftId: string | null = null;
  if (email) {
    if (!pdf) console.warn("⚠ No tailored CV found to attach (run npm run tailor first); the draft will have no attachment.");
    try {
      gmailDraftId = await createGmailDraft({ to: email, subject: draft.emailSubject, body: draft.emailBody, attachments: pdf ? [pdf] : [] });
    } catch (err: unknown) {
      console.error(`Gmail draft not created: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const md = [
    `# Outreach — ${p.company} · ${p.title}`,
    "",
    `- To: ${name ?? "(find the person with the links below)"} · ${role}${email ? ` · ${email}` : ""}`,
    `- Posting: ${p.url}`,
    `- Language: ${draft.language} · drafted by ${draft.route}${gmailDraftId ? ` · Gmail draft created (${gmailDraftId})` : ""}`,
    ...draft.warnings.map((w) => `- ⚠ ${w}`),
    "",
    "## Find the right person",
    ...links.map((l) => `- [${l.label}](${l.url})`),
    "",
    "Pick someone whose title says Recruiter / Talent Acquisition / HR at this company (Romania first), or the team's engineering manager.",
    "",
    `## 1. LinkedIn connection note (${draft.connectionNote.length}/200 chars)`,
    "",
    draft.connectionNote,
    "",
    "## 2. LinkedIn message (after they accept, or as InMail)",
    "",
    draft.linkedinMessage,
    "",
    "## 3. Email",
    "",
    `**Subject:** ${draft.emailSubject}`,
    "",
    draft.emailBody,
    "",
    "## After sending",
    "",
    `npm run outreach -- sent ${p.id.slice(0, 8)} connect|message|email`,
    "",
  ].join("\n");
  await writeFile(file, md, "utf8");

  const base = { postingId: p.id, recipientName: name, recipientRole: role, recipientEmail: email };
  await db.insert(outreach).values([
    { ...base, kind: "connect", body: draft.connectionNote },
    { ...base, kind: "message", body: draft.linkedinMessage },
    { ...base, kind: "email", subject: draft.emailSubject, body: draft.emailBody, gmailDraftId },
  ]);

  console.log(`${p.company} — ${p.title} (${role}${name ? `: ${name}` : ""})\n`);
  console.log("Find the person:");
  for (const l of links.slice(0, 4)) console.log(`  ${l.label}: ${l.url}`);
  console.log(`\n── Connection note (${draft.connectionNote.length}/200) ──\n${draft.connectionNote}`);
  console.log(`\n── LinkedIn message ──\n${draft.linkedinMessage}`);
  console.log(`\n── Email ──\nSubject: ${draft.emailSubject}\n\n${draft.emailBody}`);
  if (gmailDraftId) console.log(`\n✉ Gmail draft created${pdf ? " with the CV attached" : ""}: review it in Gmail → Drafts, then Send.`);
  if (draft.warnings.length > 0) console.log(`\n⚠ ${draft.warnings.length} item(s) to review before sending (see file).`);
  console.log(`\nSaved: ${file}\nAfter sending: npm run outreach -- sent ${p.id.slice(0, 8)} message`);
  return 0;
}

async function mark(action: "sent" | "replied", idPrefix: string, kindArg: string | undefined): Promise<number> {
  const { p } = await findPosting(idPrefix);
  if (action === "sent") {
    const kind = kindArg ?? "message";
    if (!["connect", "message", "email", "followup"].includes(kind)) {
      console.error("Kind must be connect | message | email | followup");
      return 1;
    }
    const [latest] = await db
      .select({ id: outreach.id })
      .from(outreach)
      .where(and(eq(outreach.postingId, p.id), eq(outreach.kind, kind as "connect"), eq(outreach.status, "drafted")))
      .orderBy(desc(outreach.createdAt))
      .limit(1);
    if (latest) {
      await db.update(outreach).set({ status: "sent", sentAt: new Date() }).where(eq(outreach.id, latest.id));
    } else {
      // Sent something written by hand: still log it so follow-ups and stats see it
      await db.insert(outreach).values({ postingId: p.id, kind: kind as "connect", status: "sent", body: "(written manually)", sentAt: new Date() });
    }
    console.log(`✔ ${kind} sent: ${p.company} — ${p.title}`);
    return 0;
  }

  await db.transaction(async (tx) => {
    await tx.update(outreach).set({ status: "replied" }).where(and(eq(outreach.postingId, p.id), eq(outreach.status, "sent")));
    if (p.status === "applied") {
      await tx.update(postings).set({ status: "responded" }).where(eq(postings.id, p.id));
      await tx.insert(statusEvents).values({ postingId: p.id, fromStatus: "applied", toStatus: "responded", note: "replied to outreach" });
    }
  });
  console.log(`✔ Reply logged: ${p.company} — ${p.title}${p.status === "applied" ? " (applied → responded)" : ""}`);
  return 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const [first, second, third] = args;
  if (first === undefined) return suggestions();
  if (first === "sent" || first === "replied") {
    if (!second) {
      console.error(USAGE);
      return 1;
    }
    return mark(first, second, third);
  }
  if (first === "--help" || first.startsWith("--")) {
    console.log(USAGE);
    return first === "--help" ? 0 : 1;
  }
  return compose(first, args.slice(1));
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof LlmBlockedError) console.warn(`Stopped: ${err.message}`);
    else console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
