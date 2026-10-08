// src/scripts/gmailSetup.ts
// Guided Gmail connection: `npm run gmail:setup` (also offered by `npm run setup` and the app's Setup page).
// Gmail has no "just log in" API for personal tools: Google requires your own small Cloud project + OAuth client.
// This walks through it, finds the downloaded client file, runs the consent screen, tests the alert query
// and turns the Gmail source on. Flags: --credentials <file>  use this client JSON;  --no-prompt  (used by the app).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { google } from "googleapis";
import { parseDocument } from "yaml";
import { authorizeInteractive, CredentialsSchema, explainGmailError, GMAIL_PATHS, loadGmailAuth } from "../ingest/gmail/auth.js";

const CONFIG_FILE = resolve("config/search-config.yaml");
const args = process.argv.slice(2);
const noPrompt = args.includes("--no-prompt");
const rl = noPrompt ? null : createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q: string): Promise<string> => (rl ? (await rl.question(q)).trim() : "");

const STEPS = `
One-time Google setup (about 5 minutes, free, no card):

  1. Create a project:          https://console.cloud.google.com/projectcreate        (name: job-agent)
  2. Enable the Gmail API:      https://console.cloud.google.com/apis/library/gmail.googleapis.com   → Enable
  3. Consent screen:            https://console.cloud.google.com/auth/overview         → Get started
       App name "job-agent", your email as support + contact, Audience: External → Create
  4. Add yourself as tester:    https://console.cloud.google.com/auth/audience         → Test users → Add users → your Gmail
  5. Create the client:         https://console.cloud.google.com/auth/clients          → Create client
       Application type: Desktop app → Create → Download JSON (client_secret_….json)

The app only READS job-alert emails and creates DRAFTS you send yourself. Nothing leaves your machine except the
Gmail API calls; the token is saved in secrets/ (git-ignored).`;

/** Newest client_secret*.json in Downloads, so most people never type a path */
function findDownloadedClient(): string | null {
  const dirs = [join(homedir(), "Downloads"), join(homedir(), "Descărcări"), join(homedir(), "OneDrive", "Downloads")];
  const found: { path: string; mtime: number }[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (/^client_secret.*\.json$/i.test(name)) found.push({ path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime)[0]?.path ?? null;
}

function installCredentials(file: string): void {
  const parsed = CredentialsSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file} is not an OAuth client file. Download it from step 5 (Desktop app).`);
  if (!("installed" in parsed.data)) console.log("⚠ This is a Web client; a Desktop app client works more reliably. Continuing.");
  mkdirSync("secrets", { recursive: true });
  copyFileSync(file, GMAIL_PATHS.credentials);
  console.log(`✔ Client saved to ${GMAIL_PATHS.credentials}`);
}

async function testConnection(): Promise<void> {
  const gmail = google.gmail({ version: "v1", auth: await loadGmailAuth() });
  const profile = await gmail.users.getProfile({ userId: "me" }).catch((err: unknown) => {
    throw explainGmailError(err);
  });
  console.log(`✔ Connected to ${profile.data.emailAddress}`);
  const doc = parseDocument(readFileSync(CONFIG_FILE, "utf8"));
  const query = String(doc.getIn(["sources", "gmail", "query"]) ?? "");
  const days = Number(doc.getIn(["sources", "gmail", "lookbackDays"]) ?? 7);
  const res = await gmail.users.messages.list({ userId: "me", q: `${query} newer_than:${days}d`, maxResults: 50 });
  const n = res.data.messages?.length ?? 0;
  console.log(n > 0 ? `✔ ${n} job-alert email(s) from the last ${days} days match your query` : `⚠ No job-alert emails in the last ${days} days yet (see tips below)`);
  if (doc.getIn(["sources", "gmail", "enabled"]) !== true) {
    doc.setIn(["sources", "gmail", "enabled"], true);
    writeFileSync(CONFIG_FILE, doc.toString(), "utf8");
    console.log("✔ Gmail source turned on in config/search-config.yaml");
  }
}

async function main(): Promise<number> {
  console.log("Connect Gmail (job-alert emails → postings)");
  if (existsSync(GMAIL_PATHS.token) && !args.includes("--reconnect")) {
    try {
      await testConnection();
      console.log("\nAlready connected. To switch accounts: npm run gmail:setup -- --reconnect");
      return 0;
    } catch (err: unknown) {
      console.log(`⚠ ${err instanceof Error ? err.message : String(err)}\nReconnecting…`);
    }
  }

  const explicit = args[args.indexOf("--credentials") + 1];
  if (args.includes("--credentials") && explicit) installCredentials(explicit);
  if (!existsSync(GMAIL_PATHS.credentials)) {
    const downloaded = findDownloadedClient();
    if (downloaded) {
      console.log(`Found ${downloaded}`);
      installCredentials(downloaded);
    } else {
      console.log(STEPS);
      if (noPrompt) {
        console.log("\nThen click “Connect Gmail” again: the downloaded file is picked up from your Downloads folder automatically.");
        return 1;
      }
      for (;;) {
        const answer = await ask("\nPress Enter after downloading the JSON (or paste its path, or type skip): ");
        if (answer.toLowerCase() === "skip") return 1;
        const file = answer ? answer.replace(/^["']|["']$/g, "") : findDownloadedClient();
        if (file && existsSync(file)) {
          installCredentials(file);
          break;
        }
        console.log("No client_secret….json found yet in Downloads. Download it in step 5, or paste the full path.");
      }
    }
  }

  console.log("\nA browser window opens for Google's consent screen.");
  console.log("Google shows “Google hasn't verified this app”: that's your own app → Continue → allow both permissions.");
  try {
    await authorizeInteractive();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/access_denied|403/i.test(msg)) {
      console.error("✖ Access blocked: add your Gmail address as a Test user (step 4) and try again.");
      return 1;
    }
    throw err;
  }
  console.log(`✔ Token saved to ${GMAIL_PATHS.token}`);
  await testConnection();

  console.log(`
Tips
  • Job alerts to this Gmail: LinkedIn saved search → "Set alert"; eJobs / BestJobs / Hipo → "Alertă job";
    Indeed → "Get new jobs by email". New senders: npm run gmail:check shows which ones the query misses.
  • Keep the inbox clean without losing alerts: Gmail filter (from the alert senders) → Skip Inbox + label "job-alerts".
  • Apps in "Testing" mode get a token that expires after 7 days. To stop weekly reconnects:
    https://console.cloud.google.com/auth/audience → Publish app → Confirm. Google keeps calling it "unverified";
    that's fine for your own account, and the token stops expiring.`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`✖ ${explainGmailError(err).message}`);
    process.exitCode = 1;
  })
  .finally(() => rl?.close());
