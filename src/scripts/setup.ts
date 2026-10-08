// src/scripts/setup.ts
// First-run wizard: `npm run setup` (install.cmd / install.sh call it after installing Node and packages).
// Safe to re-run: every step checks what already exists and only asks about what's missing.
// Flags: --yes  accept defaults without questions (CI / quick demo)
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseDocument } from "yaml";

const ROOT = process.cwd();
const ENV_FILE = resolve(ROOT, ".env");
const CONFIG_FILE = resolve(ROOT, "config/search-config.yaml");
const CV_FILE = resolve(ROOT, "data/master-cv.json");
const CV_TEMPLATE = resolve(ROOT, "tests/fixtures/sample-cv.json");
const auto = process.argv.includes("--yes");

const rl = createInterface({ input: process.stdin, output: process.stdout });
// No interactive input (piped / closed stdin): continue with defaults instead of exiting silently mid-setup
let inputClosed = false;
const closed = new Promise<string>((done) => rl.once("close", () => ((inputClosed = true), done(""))));
async function ask(question: string, fallback = ""): Promise<string> {
  if (auto || inputClosed) return fallback;
  const answer = (await Promise.race([rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `), closed])).trim();
  if (inputClosed) console.log("(no input: using the default)");
  return answer || fallback;
}
async function yes(question: string, fallback = true): Promise<boolean> {
  const a = (await ask(`${question} (${fallback ? "Y/n" : "y/N"})`, "")).toLowerCase();
  return a === "" ? fallback : a.startsWith("y") || a.startsWith("d");
}

const step = (n: number, title: string): void => console.log(`\n── ${n}. ${title} ──`);
const ok = (msg: string): void => console.log(`  ✔ ${msg}`);
const warn = (msg: string): void => console.log(`  ⚠ ${msg}`);

/** Runs a project script with the current Node (no shell, works without npm on PATH). */
function run(args: string[], env: NodeJS.ProcessEnv = {}): number {
  const res = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
  return res.status ?? 1;
}
const tsx = (script: string, ...args: string[]): string[] => [resolve(ROOT, "node_modules/tsx/dist/cli.mjs"), "--env-file=.env", script, ...args];

function readEnv(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(ENV_FILE)) return map;
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m?.[1]) map.set(m[1], m[2] ?? "");
  }
  return map;
}

function writeEnv(values: Map<string, string>): void {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (m?.[1] && values.has(m[1])) {
      seen.add(m[1]);
      return `${m[1]}=${values.get(m[1])}`;
    }
    return line;
  });
  for (const [k, v] of values) if (!seen.has(k)) out.push(`${k}=${v}`);
  writeFileSync(ENV_FILE, `${out.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600 }); // ⚠ Security: keys inside, owner-only
}

function dockerRunning(): boolean {
  return spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", windowsHide: true }).status === 0;
}

async function stepEnv(): Promise<void> {
  step(1, "Settings file (.env)");
  const env = readEnv();
  if (env.size === 0 && existsSync(resolve(ROOT, ".env.example"))) {
    copyFileSync(resolve(ROOT, ".env.example"), ENV_FILE);
    for (const [k, v] of readEnv()) env.set(k, v);
  }
  const updates = new Map<string, string>();

  const existingUrl = env.get("DATABASE_URL") ?? "";
  if (!env.get("DB_MODE") && existingUrl && !existingUrl.includes("change-me")) {
    // Install from before DB_MODE existed: it already runs on Docker; never replace a working DATABASE_URL
    updates.set("DB_MODE", "docker");
    ok("Existing Docker database kept (DB_MODE=docker)");
  } else if (!env.get("DB_MODE")) {
    const hasDocker = dockerRunning();
    console.log(hasDocker ? "  Docker is running on this machine." : "  Docker not found or not running.");
    const useDocker = hasDocker && (await yes("  Use Docker for the database? (No = built-in database, nothing else to install)", false));
    const mode = useDocker ? "docker" : "embedded";
    const password = randomBytes(18).toString("base64url");
    const port = mode === "embedded" ? "5433" : "5432"; // 5433: never collides with a Postgres you already run
    updates.set("DB_MODE", mode);
    updates.set("POSTGRES_USER", "jobagent");
    updates.set("POSTGRES_PASSWORD", password);
    updates.set("POSTGRES_DB", "jobagent");
    updates.set("DATABASE_URL", `postgres://jobagent:${password}@127.0.0.1:${port}/jobagent`);
    ok(`Database: ${mode === "docker" ? "Docker" : "built-in PostgreSQL (data in .pgdata/)"}`);
  } else {
    ok(`Database mode already set: ${env.get("DB_MODE")}`);
  }

  const keys = ["GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"];
  if (!keys.some((k) => (env.get(k) ?? "").length > 0)) {
    console.log("  The AI scoring and tailoring needs at least one free API key:");
    console.log("    Groq (free, no card):   https://console.groq.com/keys");
    console.log("    Gemini (free tier):     https://aistudio.google.com/apikey");
    const groq = await ask("  Groq API key (Enter to skip)");
    const gemini = await ask("  Gemini API key (Enter to skip)");
    if (groq) updates.set("GROQ_API_KEY", groq);
    if (gemini) updates.set("GEMINI_API_KEY", gemini);
    if (!groq && !gemini) warn("No API key yet: browsing works, scoring and tailoring don't. Add one to .env later and re-run npm run setup.");
  } else {
    ok("LLM API key found");
  }
  writeEnv(updates);
  for (const [k, v] of updates) process.env[k] = v;
  for (const [k, v] of readEnv()) process.env[k] ??= v;
  ok(".env saved");
}

async function stepSearch(): Promise<void> {
  step(2, "Where you want to work");
  const doc = parseDocument(readFileSync(CONFIG_FILE, "utf8"));
  const tierA = (doc.getIn(["locations", "tierA"]) as { toJSON(): { name: string }[] } | undefined)?.toJSON() ?? [];
  const tierB = (doc.getIn(["locations", "tierB"]) as { toJSON(): { name: string }[] } | undefined)?.toJSON() ?? [];
  console.log(`  Home city now: ${tierA.map((c) => c.name).join(", ") || "none"}; relocation: ${tierB.map((c) => c.name).join(", ") || "none"}`);
  if (!(await yes("  Change cities?", false))) {
    ok("Kept the current search settings (edit config/search-config.yaml any time)");
    return;
  }
  const city = (name: string): { name: string; aliases: string[] } => {
    const plain = name.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
    return { name, aliases: plain !== name.toLowerCase() ? [plain] : [] };
  };
  const home = await ask("  Your city (no relocation needed)", tierA[0]?.name ?? "");
  const reloc = await ask("  Cities you would move to, comma-separated (Enter for none)", tierB.map((c) => c.name).join(", "));
  const goals = await ask("  One line about the roles you want (used by the AI scoring)", String(doc.getIn(["scoring", "careerGoals"]) ?? ""));
  if (home) doc.setIn(["locations", "tierA"], doc.createNode([city(home)]));
  doc.setIn(["locations", "tierB"], doc.createNode(reloc.split(",").map((c) => c.trim()).filter(Boolean).map(city)));
  if (goals.length >= 10) doc.setIn(["scoring", "careerGoals"], goals.slice(0, 500));
  writeFileSync(CONFIG_FILE, doc.toString(), "utf8");
  ok("Search settings saved");
}

async function stepCv(): Promise<void> {
  step(4, "Your CV data");
  const isExample = existsSync(CV_FILE) && readFileSync(CV_FILE, "utf8").includes("Alex Ion Popescu");
  if (existsSync(CV_FILE) && !isExample) {
    ok("data/master-cv.json found");
    return;
  }
  const hasKey = ["GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"].some((k) => (process.env[k] ?? "").length > 0);
  if (hasKey) {
    console.log("  Import your existing CV: the AI turns it into data/master-cv.json (it restructures, it doesn't invent).");
    const file = (await ask("  Path to your CV (.pdf, .docx, .txt) — drag the file here, or Enter to skip")).replace(/^["']|["']$/g, "");
    if (file) {
      if (run(tsx("src/scripts/importCv.ts", file)) === 0) return;
      warn("Import failed (see above). Using the example for now; retry later: npm run cv:import -- <file>");
    }
  } else {
    warn("No API key, so the CV import is skipped. Later: npm run cv:import -- <your CV file>");
  }
  if (!existsSync(CV_FILE)) {
    mkdirSync(resolve(ROOT, "data"), { recursive: true });
    copyFileSync(CV_TEMPLATE, CV_FILE);
  }
  warn("data/master-cv.json is the fictional example (Alex Popescu). Import yours: npm run cv:import -- <file>,");
  console.log("     or the Setup page in the app. Every CV line and cover-letter claim comes only from this file.");
}

async function stepGmail(): Promise<void> {
  step(7, "Gmail job alerts (optional)");
  if (existsSync(resolve(ROOT, "secrets/gmail-token.json"))) {
    ok("Gmail already connected");
    return;
  }
  console.log("  Reads LinkedIn / eJobs / BestJobs alert emails from your Gmail. Needs a 5-minute Google Cloud setup.");
  if (!(await yes("  Connect Gmail now?", false))) {
    console.log("     Later: npm run gmail:setup, or the Setup page in the app.");
    return;
  }
  rl.pause(); // the Gmail wizard reads stdin itself
  run(tsx("src/scripts/gmailSetup.ts"));
  rl.resume();
}

function stepDatabase(): boolean {
  step(3, "Database");
  if (run(tsx("src/scripts/db.ts", "up")) !== 0) {
    warn("Database did not start; fix the message above, then run: npm run setup");
    return false;
  }
  const migrate = spawnSync(process.execPath, [resolve(ROOT, "node_modules/drizzle-kit/bin.cjs"), "migrate"], { cwd: ROOT, stdio: "inherit", env: process.env });
  if (migrate.status !== 0) {
    warn("Migrations failed (see above).");
    return false;
  }
  ok("Tables ready");
  return true;
}

async function stepBrowser(): Promise<void> {
  step(5, "PDF rendering");
  if (process.platform === "win32") {
    ok("Uses Microsoft Edge (already on Windows) when Playwright's Chromium is missing");
    return;
  }
  const check = spawnSync(process.execPath, ["-e", "import('playwright').then(p=>p.chromium.launch()).then(b=>b.close()).then(()=>process.exit(0),()=>process.exit(1))"], { cwd: ROOT, stdio: "ignore" });
  if (check.status === 0) {
    ok("Chromium available");
    return;
  }
  if (!auto && !inputClosed && (await yes("  Download Chromium for CV PDFs (~150 MB)?", true))) {
    run([resolve(ROOT, "node_modules/playwright/cli.js"), "install", "chromium"]);
  } else warn("Skipped. Later: npx playwright install chromium (or set CV_BROWSER_CHANNEL=chrome in .env)");
}

async function stepShortcut(): Promise<void> {
  step(6, "Desktop shortcut");
  if (!(await yes("  Create a \"Job Agent\" icon on the desktop?", true))) return;
  try {
    const { createShortcut } = await import("./shortcut.js");
    ok(`Created: ${createShortcut().join(", ")}`);
  } catch (err: unknown) {
    warn(`Shortcut not created: ${err instanceof Error ? err.message : String(err)}. Later: npm run shortcut`);
  }
}

async function main(): Promise<number> {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    console.error(`Node.js 22 or newer is required (you have ${process.versions.node}). Install the LTS from https://nodejs.org`);
    return 1;
  }
  if (!existsSync(resolve(ROOT, "node_modules/tsx"))) {
    console.error("Packages are not installed. Run: npm ci   (or use install.cmd / install.sh)");
    return 1;
  }
  // An update zip extracted on its own (instead of over the app folder) has no config/ or migrations
  const missing = ["config/search-config.yaml", "drizzle/meta/_journal.json", "src/schemas/masterCv.ts", "docker-compose.yml"].filter((f) => !existsSync(resolve(ROOT, f)));
  if (missing.length > 0) {
    console.error(`This folder is not a complete Job Agent install (missing: ${missing.join(", ")}).`);
    console.error("Update zips go OVER an existing job-agent folder. For a new install, use the full release zip or git clone.");
    return 1;
  }
  console.log("Job Agent setup — re-run it any time; it only changes what is missing.");
  await stepEnv();
  await stepSearch();
  const dbOk = stepDatabase();
  await stepCv();
  await stepBrowser();
  await stepShortcut();
  await stepGmail();

  console.log(`\n${dbOk ? "✔ Setup complete." : "⚠ Setup finished with a database problem (see above)."}`);
  console.log("  Start:        double-click \"Job Agent\" on the desktop, or run: npm run ui");
  console.log("  First steps:  check data/master-cv.json → npm run cv:base (compare with your CV) → Run daily pipeline in the app");
  return dbOk ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
