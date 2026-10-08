// src/outreach/gmailDraft.ts
// Creates a Gmail DRAFT (never sends) with the tailored CV attached, so outreach email takes one click after review.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { google } from "googleapis";
import { loadGmailAuth } from "../ingest/gmail/auth.js";

export interface DraftInput {
  to: string;
  subject: string;
  body: string;
  attachments: string[]; // file paths (PDF)
}

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i;

// RFC 2047 encoded-word, so Romanian diacritics survive in the subject
const encodeHeader = (v: string): string => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`);
const wrap76 = (b64: string): string => b64.replace(/.{1,76}/g, "$&\r\n");

export async function buildMime(input: DraftInput): Promise<string> {
  // ⚠ Security: header injection guard; recipient and subject come from CLI args / LLM output
  if (!EMAIL_RE.test(input.to)) throw new Error(`Invalid recipient email "${input.to}"`);
  const subject = input.subject.replace(/[\r\n]+/g, " ").trim();
  const boundary = `job-agent-${Date.now().toString(36)}`;
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(input.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64")),
  ];
  for (const path of input.attachments) {
    const name = basename(path).replace(/"/g, "");
    parts.push(
      `--${boundary}`,
      `Content-Type: application/pdf; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap76((await readFile(path)).toString("base64")),
    );
  }
  parts.push(`--${boundary}--`, "");
  return [`To: ${input.to}`, `Subject: ${encodeHeader(subject)}`, "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "", ...parts].join("\r\n");
}

export async function createGmailDraft(input: DraftInput): Promise<string> {
  const auth = await loadGmailAuth();
  const gmail = google.gmail({ version: "v1", auth });
  const raw = Buffer.from(await buildMime(input), "utf8").toString("base64url");
  try {
    const res = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw } } });
    return res.data.id ?? "unknown";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/insufficient|scope|403/i.test(msg)) {
      throw new Error("Gmail token has no compose permission. Re-authorize once: npm run gmail:auth (it now asks for read + drafts).");
    }
    throw err;
  }
}
