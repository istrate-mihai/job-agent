// src/ui/commands.ts
// The GUI never re-implements business logic: every button runs the same script you run in the terminal,
// with arguments validated here against a whitelist. No shell is involved (spawn with an argv array).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = process.cwd();
const TSX_CLI = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const ID_RE = /^[0-9a-f-]{4,36}$/i;
const MAX_LOG_LINES = 4_000;

export type CommandName =
  | "daily"
  | "db-up"
  | "gmail-check"
  | "pipeline"
  | "ingest"
  | "enrich"
  | "score"
  | "refilter"
  | "tailor"
  | "decide"
  | "track"
  | "describe"
  | "add"
  | "outreach"
  | "outreach-mark"
  | "followup-sent"
  | "cv-base"
  | "cv-import"
  | "validate-cv"
  | "gmail-setup";

interface Step {
  label: string;
  cmd: string;
  args: string[];
}

export interface Job {
  id: string;
  name: CommandName;
  title: string;
  status: "queued" | "running" | "done" | "failed";
  log: string[];
  startedAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
}

// Shown in the output panel, so it reads like the command you'd type yourself
const NPM_NAME: Record<string, string> = {
  gmailCheck: "gmail:check", gmailSetup: "gmail:setup", importCv: "cv:import", validateCv: "validate:cv", renderBaseCv: "cv:base", db: "db:up",
};
const script = (file: string, args: string[] = [], envFile = true): Step => ({
  label: `npm run ${file === "db" ? `db:${args[0] ?? "up"}` : (NPM_NAME[file] ?? file)}${args.length && file !== "db" ? ` -- ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}` : ""}`,
  cmd: process.execPath,
  args: [TSX_CLI, ...(envFile ? ["--env-file=.env"] : []), `src/scripts/${file}.ts`, ...args],
});
const PIPELINE: Step[] = [script("ingest"), script("enrich"), script("score"), script("digest")];
const DB_UP: Step = script("db", ["up"]); // Docker or the built-in database, per DB_MODE in .env

// Strings typed in the GUI go to argv as single elements; still cap length and strip control chars
const text = (v: unknown, max = 300): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T => {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new Error(`must be one of ${allowed.join(", ")}`);
  return v as T;
};
function id(v: unknown): string {
  if (typeof v !== "string" || !ID_RE.test(v)) throw new Error("invalid posting id");
  return v.toLowerCase();
}

async function saveDescription(name: string, body: unknown): Promise<string> {
  const content = typeof body === "string" ? body.slice(0, 60_000) : "";
  if (content.trim().length < 300) throw new Error("paste the full job description (at least 300 characters)");
  await mkdir(join(ROOT, "jobs"), { recursive: true });
  const file = join("jobs", `${name}.txt`);
  await writeFile(join(ROOT, file), content, "utf8");
  return file;
}

/** Builds the steps for a command; throws on invalid input (shown to the user, nothing runs). */
export async function buildSteps(name: CommandName, p: Record<string, unknown>): Promise<{ title: string; steps: Step[] }> {
  switch (name) {
    case "daily":
      return { title: "Daily run", steps: [DB_UP, script("gmailCheck"), ...PIPELINE] };
    case "db-up":
      return { title: "Start database", steps: [DB_UP] };
    case "gmail-check":
      return { title: "Gmail check", steps: [script("gmailCheck")] };
    case "pipeline":
      return { title: "Pipeline", steps: PIPELINE };
    case "ingest":
    case "enrich":
    case "score":
    case "refilter":
      return { title: name[0]!.toUpperCase() + name.slice(1), steps: [script(name)] };
    case "cv-base":
      return { title: "Render base CV", steps: [script("renderBaseCv")] };
    case "validate-cv":
      return { title: "Check CV data", steps: [script("validateCv", [], false)] };
    case "cv-import": {
      // Only files the GUI itself saved under data/imports/ (see /api/cv/upload)
      const file = text(p["file"], 200);
      if (!/^data\/imports\/[\w.-]+\.(pdf|docx|txt|md)$/i.test(file)) throw new Error("invalid import file");
      return { title: "Import CV with AI", steps: [script("importCv", [file]), script("validateCv", [], false)] };
    }
    case "gmail-setup":
      return { title: "Connect Gmail", steps: [script("gmailSetup", ["--no-prompt", ...(p["reconnect"] === true ? ["--reconnect"] : [])])] };
    case "tailor": {
      if (p["id"] === undefined) return { title: "Tailor approved", steps: [script("tailor")] };
      const args = [id(p["id"])];
      if (p["allowTitleOnly"] === true) args.push("--allow-title-only");
      return { title: "Tailor", steps: [script("tailor", args)] };
    }
    case "decide": {
      const decision = oneOf(p["decision"], ["approve", "skip"] as const);
      const reason = text(p["reason"]);
      return { title: `${decision === "approve" ? "Approve" : "Skip"}`, steps: [script("decide", [id(p["id"]), decision, ...(reason ? [reason] : [])])] };
    }
    case "track": {
      const status = oneOf(p["status"], ["applied", "responded", "interview", "offer", "rejected"] as const);
      const note = text(p["note"]);
      const args = [id(p["id"]), status, ...(note ? [note] : [])];
      if (p["force"] === true) args.push("--force");
      return { title: `Mark ${status}`, steps: [script("track", args)] };
    }
    case "describe": {
      const postingId = id(p["id"]);
      const file = await saveDescription(postingId.slice(0, 8), p["description"]);
      return { title: "Add description + rescore", steps: [script("describe", [postingId, file])] };
    }
    case "add": {
      const company = text(p["company"], 120);
      const title = text(p["title"], 160);
      if (!company || !title) throw new Error("company and title are required");
      const args = [company, title];
      const description = typeof p["description"] === "string" ? p["description"] : "";
      if (description.trim().length > 0) {
        const slug = `${company}-${title}`.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").slice(0, 50);
        args.push("--file", await saveDescription(`ui-${slug}-${Date.now().toString(36)}`, description));
      }
      const url = text(p["url"], 2000);
      if (url) {
        if (!/^(https?:\/\/|mailto:)/i.test(url)) throw new Error("url must start with http(s):// or mailto:");
        args.push("--url", url);
      }
      const location = text(p["location"], 100);
      if (location) args.push("--location", location);
      args.push("--mode", oneOf(p["mode"] ?? "unknown", ["remote", "hybrid", "onsite", "unknown"] as const));
      const applied = text(p["applied"]);
      if (applied) args.push("--applied", applied);
      return { title: `Add ${company}`, steps: [script("add", args)] };
    }
    case "outreach": {
      const args = [id(p["id"]), "--role", oneOf(p["role"] ?? "recruiter", ["recruiter", "hiring-manager", "engineer"] as const)];
      const to = text(p["to"], 100);
      if (to) args.push("--to", to);
      const email = text(p["email"], 200);
      if (email) {
        if (!/^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i.test(email)) throw new Error("invalid email");
        args.push("--email", email);
      }
      return { title: "Draft outreach", steps: [script("outreach", args)] };
    }
    case "outreach-mark": {
      const action = oneOf(p["action"], ["sent", "replied"] as const);
      const args = [action, id(p["id"])];
      if (action === "sent") args.push(oneOf(p["kind"] ?? "message", ["connect", "message", "email", "followup"] as const));
      return { title: action === "sent" ? "Log sent" : "Log reply", steps: [script("outreach", args)] };
    }
    case "followup-sent":
      return { title: "Log follow-up", steps: [script("followup", [id(p["id"]), "sent"])] };
  }
}

// ── Job queue: one command at a time (free-tier LLM limits and the DB pool are shared) ──
const jobs: Job[] = [];
const queue: { job: Job; steps: Step[] }[] = [];
let running = false;

const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

function push(job: Job, chunk: string): void {
  for (const line of chunk.replace(ANSI_RE, "").replace(/\r(?!\n)/g, "\n").split(/\r?\n/)) {
    if (line.trim().length === 0 && job.log.at(-1) === "") continue;
    job.log.push(line);
  }
  if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
}

function runStep(job: Job, step: Step): Promise<number> {
  return new Promise((done) => {
    push(job, `$ ${step.label}`);
    const child = spawn(step.cmd, step.args, {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      windowsHide: true,
      shell: false, // ⚠ Security: argv array, never a shell string
    });
    child.stdout.setEncoding("utf8").on("data", (d: string) => push(job, d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => push(job, d));
    child.on("error", (err) => {
      push(job, `✖ ${err.message}`);
      done(1);
    });
    child.on("close", (code) => done(code ?? 1));
  });
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const { job, steps } = next;
      job.status = "running";
      job.startedAt = Date.now();
      let code = 0;
      for (const step of steps) {
        code = await runStep(job, step);
        if (code !== 0) break; // same as `&&` in the terminal
      }
      job.exitCode = code;
      job.status = code === 0 ? "done" : "failed";
      job.endedAt = Date.now();
    }
  } finally {
    running = false;
  }
}

export function enqueue(name: CommandName, title: string, steps: Step[]): Job {
  const job: Job = { id: randomUUID(), name, title, status: "queued", log: [], startedAt: null, endedAt: null, exitCode: null };
  jobs.unshift(job);
  if (jobs.length > 50) jobs.length = 50;
  queue.push({ job, steps });
  void drain();
  return job;
}

export const listJobs = (): Omit<Job, "log">[] => jobs.map(({ log: _log, ...rest }) => rest);
export const getJob = (jobId: string): Job | undefined => jobs.find((j) => j.id === jobId);

export const COMMAND_NAMES: readonly CommandName[] = [
  "daily", "db-up", "gmail-check", "pipeline", "ingest", "enrich", "score", "refilter", "tailor", "decide", "track",
  "describe", "add", "outreach", "outreach-mark", "followup-sent", "cv-base", "cv-import", "validate-cv", "gmail-setup",
];
