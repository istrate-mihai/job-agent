// src/ui/server.ts
// Local GUI for job-agent: `npm run ui` → http://localhost:5174
// ⚠ Security: binds to 127.0.0.1 only, checks the Host header (DNS rebinding), requires a custom header on
// every POST (cross-site forms can't set it), and serves files only from the output/ directory.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { loadSearchConfig } from "../config/searchConfig.js";
import { db, pool } from "../db/client.js";
import { decisions, llmUsage, outreach, postingScores, postings, statusEvents, tailorings } from "../db/schema.js";
import { GMAIL_PATHS } from "../ingest/gmail/auth.js";
import { normalizeText } from "../ingest/text.js";
import { MasterCvSchema } from "../schemas/masterCv.js";
import { followUpMessage, recruiterSearchLinks } from "../outreach/compose.js";
import { loadMasterCv } from "../profile/candidateProfile.js";
import { dueFollowUps } from "../reporting/followups.js";
import { allBreakdowns } from "../reporting/stats.js";
import { dbMode, isUp, startDb } from "../db/local.js";
import { buildSteps, COMMAND_NAMES, enqueue, getJob, listJobs, type CommandName } from "./commands.js";

const PORT = Number(process.env["UI_PORT"] ?? 5174);
const HOST = "127.0.0.1";
const ROOT = process.cwd();
const PUBLIC_DIR = resolve(ROOT, "src/ui/public");
const OUTPUT_DIR = resolve(ROOT, "output");
const DAY_MS = 86_400_000;
const POSTING_ID = sql.raw(`"postings"."id"`); // qualified: see src/reporting/followups.ts
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(json);
}

async function readJson(req: IncomingMessage, limit = 200_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "request too large");
    chunks.push(chunk as Buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "expected a JSON object");
  return parsed as Record<string, unknown>;
}

/** Resolves a path inside output/ or throws: the GUI can open generated files, nothing else on disk. */
function insideOutput(p: string): string {
  const full = resolve(ROOT, p);
  const rel = relative(OUTPUT_DIR, full);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new HttpError(403, "path outside output/"); // also catches other drives on Windows
  return full;
}

async function listFiles(dir: string | null): Promise<{ name: string; path: string }[]> {
  if (!dir) return [];
  try {
    const full = insideOutput(dir);
    const names = await readdir(full);
    return names.filter((n) => !n.startsWith(".")).sort().map((name) => ({ name, path: relative(ROOT, join(full, name)).split(sep).join("/") }));
  } catch {
    return [];
  }
}

const jobKey = (company: string, title: string): string =>
  `${normalizeText(company).replace(/[^a-z0-9+#]+/g, " ").trim()}|${normalizeText(title).replace(/[^a-z0-9+#]+/g, " ").trim()}`;
const daysSince = (d: Date | string | null): number | null => (d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY_MS) : null);

// ── Read API ──

async function review(all: boolean) {
  const rows = await db
    .select({ p: postings, s: postingScores })
    .from(postings)
    .innerJoin(postingScores, eq(postingScores.postingId, postings.id))
    .where(all ? eq(postings.status, "scored") : and(eq(postings.status, "scored"), ne(postingScores.recommendation, "skip")));
  const handled = await db
    .select({ id: postings.id, company: postings.company, title: postings.title, status: postings.status })
    .from(postings)
    .where(inArray(postings.status, ["approved", "tailored", "applied", "responded", "interview", "offer", "rejected", "skipped"]));
  const twins = new Map(handled.map((h) => [jobKey(h.company, h.title), h]));
  const now = Date.now();
  return rows
    .map(({ p, s }) => {
      const ageDays = p.postedAt ? Math.floor((now - p.postedAt.getTime()) / DAY_MS) : null;
      const fresh = ageDays === null ? 0 : ageDays <= 2 ? 5 : ageDays <= 5 ? 2 : 0;
      const twin = twins.get(jobKey(p.company, p.title));
      return {
        id: p.id,
        company: p.company,
        title: p.title,
        url: p.url,
        source: p.source,
        location: p.locationText,
        tier: p.locationTier,
        workMode: p.workMode,
        ageDays,
        titleOnly: p.description.trim().length < 300,
        flags: p.flags,
        score: s.total,
        recommendation: s.recommendation,
        stack: s.primaryStack,
        matched: s.matchedSkills,
        gaps: s.mustHaveGaps,
        penalties: s.components.penalties,
        reasoning: s.reasoning,
        duplicateOf: twin ? { id: twin.id, status: twin.status } : null,
        rank: s.total + fresh + (p.flags.includes("allowlist-company") ? 5 : 0),
      };
    })
    .sort((a, b) => b.rank - a.rank);
}

async function board() {
  const rows = await db
    .select({
      id: postings.id,
      company: postings.company,
      title: postings.title,
      status: postings.status,
      url: postings.url,
      location: postings.locationText,
      tier: postings.locationTier,
      score: postingScores.total,
      outputDir: tailorings.outputDir,
      warnings: tailorings.warnings,
      since: sql<Date | null>`(select max(${statusEvents.createdAt}) from ${statusEvents} where ${statusEvents.postingId} = ${POSTING_ID} and ${statusEvents.toStatus} = ${postings.status})`,
      appliedAt: sql<Date | null>`(select max(${statusEvents.createdAt}) from ${statusEvents} where ${statusEvents.postingId} = ${POSTING_ID} and ${statusEvents.toStatus} = 'applied')`,
      lastTouch: sql<Date | null>`(select max(${outreach.sentAt}) from ${outreach} where ${outreach.postingId} = ${POSTING_ID} and ${outreach.status} <> 'drafted')`,
      contacted: sql<boolean>`exists (select 1 from ${outreach} where ${outreach.postingId} = ${POSTING_ID} and ${outreach.kind} <> 'followup' and ${outreach.status} <> 'drafted')`,
      updatedAt: postings.updatedAt,
    })
    .from(postings)
    .leftJoin(postingScores, eq(postingScores.postingId, postings.id))
    .leftJoin(tailorings, eq(tailorings.postingId, postings.id))
    .where(inArray(postings.status, ["approved", "tailored", "applied", "responded", "interview", "offer", "rejected"]))
    .orderBy(desc(postings.updatedAt));
  return rows.map((r) => {
    const days = daysSince(r.since ?? r.updatedAt);
    const touched = daysSince(r.lastTouch);
    return {
      ...r,
      days,
      appliedDays: daysSince(r.appliedAt),
      warningCount: r.warnings?.length ?? 0,
      followUpDue: r.status === "applied" && days !== null && days >= 7 && (touched === null || touched >= 7),
    };
  });
}

async function postingDetail(postingId: string) {
  if (!ID_RE.test(postingId)) throw new HttpError(400, "invalid id");
  const [row] = await db
    .select({ p: postings, s: postingScores, t: tailorings })
    .from(postings)
    .leftJoin(postingScores, eq(postingScores.postingId, postings.id))
    .leftJoin(tailorings, eq(tailorings.postingId, postings.id))
    .where(eq(postings.id, postingId));
  if (!row) throw new HttpError(404, "posting not found");
  const [events, decisionRows, outreachRows, files] = await Promise.all([
    db.select().from(statusEvents).where(eq(statusEvents.postingId, postingId)).orderBy(statusEvents.createdAt),
    db.select().from(decisions).where(eq(decisions.postingId, postingId)).orderBy(decisions.createdAt),
    db.select().from(outreach).where(eq(outreach.postingId, postingId)).orderBy(desc(outreach.createdAt)),
    listFiles(row.t?.outputDir ?? null),
  ]);
  let diff: string | null = null;
  const diffFile = files.find((f) => f.name === "diff.md");
  if (diffFile) diff = await readFile(resolve(ROOT, diffFile.path), "utf8").catch(() => null);
  const { raw: _raw, ...posting } = row.p;
  return {
    posting,
    score: row.s,
    tailoring: row.t,
    events,
    decisions: decisionRows,
    outreach: outreachRows,
    files,
    diff,
    searchLinks: recruiterSearchLinks(row.p.company, row.p.title),
  };
}

async function followUps() {
  const cv = await loadMasterCv();
  const due = await dueFollowUps();
  return due.map((r) => ({
    id: r.p.id,
    company: r.p.company,
    title: r.p.title,
    url: r.p.url,
    days: r.days,
    followUps: r.followUps,
    contact: r.contact,
    contactEmail: r.contactEmail,
    message: followUpMessage(r.p, cv, r.days, r.contact),
    searchLinks: r.contact ? [] : recruiterSearchLinks(r.p.company, r.p.title).slice(0, 2),
  }));
}

async function outreachQueue() {
  const rows = await db
    .select({ id: postings.id, company: postings.company, title: postings.title, status: postings.status, score: postingScores.total })
    .from(postings)
    .leftJoin(postingScores, eq(postingScores.postingId, postings.id))
    .where(
      and(
        inArray(postings.status, ["tailored", "applied"]),
        sql`not exists (select 1 from ${outreach} where ${outreach.postingId} = ${POSTING_ID} and ${outreach.kind} <> 'followup' and ${outreach.status} <> 'drafted')`,
      ),
    )
    .orderBy(desc(postingScores.total));
  const drafts = await db
    .select({ o: outreach, company: postings.company, title: postings.title })
    .from(outreach)
    .innerJoin(postings, eq(postings.id, outreach.postingId))
    .orderBy(desc(outreach.createdAt))
    .limit(60);
  return { queue: rows, recent: drafts.map((d) => ({ ...d.o, company: d.company, title: d.title })) };
}

async function overview() {
  const config = await loadSearchConfig();
  const [counts] = await db
    .select({
      toReview: sql<number>`count(*) filter (where ${postings.status} = 'scored' and ${postingScores.recommendation} <> 'skip')::int`,
      approved: sql<number>`count(*) filter (where ${postings.status} = 'approved')::int`,
      tailored: sql<number>`count(*) filter (where ${postings.status} = 'tailored')::int`,
      applied: sql<number>`count(*) filter (where ${postings.status} = 'applied')::int`,
      responded: sql<number>`count(*) filter (where ${postings.status} in ('responded', 'interview', 'offer'))::int`,
      rejected: sql<number>`count(*) filter (where ${postings.status} = 'rejected')::int`,
    })
    .from(postings)
    .leftJoin(postingScores, eq(postingScores.postingId, postings.id));
  const [tokens] = await db
    .select({ used: sql<number>`coalesce(sum(${llmUsage.inputTokens} + ${llmUsage.outputTokens}), 0)::int` })
    .from(llmUsage)
    .where(sql`${llmUsage.createdAt} >= date_trunc('day', now())`);
  const due = await dueFollowUps();
  return {
    counts: { ...counts, followUpsDue: due.length },
    tokens: { used: tokens?.used ?? 0, budget: config.agent.dailyTokenBudget },
    agentEnabled: config.agent.enabled,
    thresholds: { tailor: config.scoring.tailorThreshold, review: config.scoring.reviewThreshold },
    cv: await loadMasterCv()
      .then((cv) => (cv.basics.fullName === "Alex Ion Popescu" ? "example" : "ok"))
      .catch(() => "missing"),
  };
}

// ── Setup page ──

async function setupStatus() {
  const env = (k: string): boolean => (process.env[k] ?? "").trim().length > 0;
  let cv: { state: "missing" | "example" | "invalid" | "ok"; name?: string; counts?: Record<string, number>; problems?: string[] } = { state: "missing" };
  const raw = await readFile(resolve(ROOT, "data/master-cv.json"), "utf8").catch(() => null);
  if (raw !== null) {
    try {
      const parsed = MasterCvSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        cv = { state: "invalid", problems: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".")}: ${i.message}`) };
      } else {
        const c = parsed.data;
        cv = {
          state: c.basics.fullName === "Alex Ion Popescu" ? "example" : "ok",
          name: c.basics.fullName,
          counts: {
            jobs: c.experience.length,
            projects: c.projects.length,
            bullets: [...c.experience, ...c.projects].reduce((n, e) => n + e.facts.length, 0),
            skills: c.skills.length,
          },
        };
      }
    } catch (err: unknown) {
      cv = { state: "invalid", problems: [err instanceof Error ? err.message : String(err)] };
    }
  }
  const baseCv = (await readdir(OUTPUT_DIR).catch(() => [] as string[])).find((n) => n.endsWith("_CV.pdf"));
  const config = await loadSearchConfig();
  return {
    cv,
    baseCvPath: baseCv ? `output/${baseCv}` : null,
    gmail: {
      credentials: existsSync(resolve(ROOT, GMAIL_PATHS.credentials)),
      token: existsSync(resolve(ROOT, GMAIL_PATHS.token)),
      enabled: config.sources.gmail.enabled,
    },
    database: { mode: dbMode(), up: await isUp() },
    llm: ["GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"].map((k) => ({ name: k.replace("_API_KEY", "").toLowerCase(), set: env(k) })),
    home: config.locations.tierA.map((c) => c.name),
    relocation: config.locations.tierB.map((c) => c.name),
  };
}

async function uploadCv(body: Record<string, unknown>): Promise<{ jobId: string }> {
  const name = typeof body["name"] === "string" ? body["name"] : "";
  const data = typeof body["data"] === "string" ? body["data"] : "";
  const ext = extname(name).toLowerCase();
  if (![".pdf", ".docx", ".txt", ".md"].includes(ext)) throw new HttpError(400, "Upload a .pdf, .docx or .txt file");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length < 100 || bytes.length > 10_000_000) throw new HttpError(400, "File is empty or larger than 10 MB");
  await mkdir(resolve(ROOT, "data/imports"), { recursive: true });
  const file = `data/imports/cv-${Date.now()}${ext}`; // ⚠ Security: server-chosen name, never the uploaded path
  await writeFile(resolve(ROOT, file), bytes);
  const built = await buildSteps("cv-import", { file });
  return { jobId: enqueue("cv-import", built.title, built.steps).id };
}

// ── HTTP ──

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const name = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const full = resolve(PUBLIC_DIR, name);
  if (!full.startsWith(PUBLIC_DIR + sep)) throw new HttpError(404, "not found");
  const body = await readFile(full).catch(() => null);
  if (!body) throw new HttpError(404, "not found");
  res.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(body);
}

async function serveOutputFile(res: ServerResponse, p: string): Promise<void> {
  const full = insideOutput(p);
  const info = await stat(full).catch(() => null);
  if (!info?.isFile()) throw new HttpError(404, "file not found");
  res.writeHead(200, {
    "content-type": MIME[extname(full).toLowerCase()] ?? "application/octet-stream",
    "content-length": info.size,
    "content-disposition": "inline",
    "cache-control": "no-store",
  });
  res.end(await readFile(full));
}

function openInExplorer(p: string): void {
  const full = insideOutput(p);
  const [cmd, args] =
    process.platform === "win32" ? ["explorer.exe", [full]] : process.platform === "darwin" ? ["open", [full]] : ["xdg-open", [full]];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", shell: false });
  child.on("error", () => undefined);
  child.unref();
}

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) throw new HttpError(403, "forbidden host");
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === "POST") {
    if (req.headers["x-job-agent"] !== "1") throw new HttpError(403, "missing x-job-agent header");
    if (path === "/api/cv/upload") {
      const body = await readJson(req, 14_000_000); // base64 of a ≤10 MB CV
      return send(res, 202, await uploadCv(body));
    }
    const body = await readJson(req);
    if (path === "/api/run") {
      const name = body["command"];
      if (typeof name !== "string" || !(COMMAND_NAMES as readonly string[]).includes(name)) throw new HttpError(400, "unknown command");
      const params = (body["params"] ?? {}) as Record<string, unknown>;
      let built;
      try {
        built = await buildSteps(name as CommandName, params);
      } catch (err: unknown) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
      const job = enqueue(name as CommandName, built.title, built.steps);
      return send(res, 202, { jobId: job.id });
    }
    if (path === "/api/open") {
      openInExplorer(String(body["path"] ?? ""));
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, "not found");
  }

  if (req.method !== "GET") throw new HttpError(405, "method not allowed");
  if (path === "/api/overview") return send(res, 200, await overview());
  if (path === "/api/review") return send(res, 200, await review(url.searchParams.get("all") === "1"));
  if (path === "/api/board") return send(res, 200, await board());
  if (path === "/api/followups") return send(res, 200, await followUps());
  if (path === "/api/outreach") return send(res, 200, await outreachQueue());
  if (path === "/api/stats") return send(res, 200, await allBreakdowns());
  if (path === "/api/setup") return send(res, 200, await setupStatus());
  if (path === "/api/jobs") return send(res, 200, listJobs());
  if (path.startsWith("/api/jobs/")) {
    const job = getJob(path.slice("/api/jobs/".length));
    if (!job) throw new HttpError(404, "job not found");
    const from = Math.max(0, Number(url.searchParams.get("from") ?? 0) || 0);
    return send(res, 200, { ...job, log: job.log.slice(from), logLength: job.log.length });
  }
  if (path.startsWith("/api/postings/")) return send(res, 200, await postingDetail(path.slice("/api/postings/".length)));
  if (path === "/file") return serveOutputFile(res, url.searchParams.get("path") ?? "");
  return serveStatic(res, path);
}

const server = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: err instanceof Error ? err.message : String(err) });
    else res.end();
  });
});

function openBrowser(link: string): void {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd.exe", ["/c", "start", "", link]] : process.platform === "darwin" ? ["open", [link]] : ["xdg-open", [link]];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", shell: false });
  child.on("error", () => console.log(`Open ${link} in your browser.`)); // no xdg-open etc.: just print the link
  child.unref();
}

const link = `http://localhost:${PORT}`;
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    // Already running (second double-click on the shortcut): just bring it up in the browser
    console.log(`Job Agent is already running → ${link}`);
    if (process.argv.includes("--open")) openBrowser(link);
    void pool.end().finally(() => process.exit(0));
    return;
  }
  console.error(err);
  process.exit(1);
});

async function boot(): Promise<void> {
  try {
    if (!(await isUp())) {
      console.log(`Starting the database (${dbMode()})…`);
      await startDb();
    }
  } catch (err: unknown) {
    // The GUI still opens: its views show the error and a "Start database" button
    console.error(`⚠ Database not started: ${err instanceof Error ? err.message : String(err)}`);
  }
  server.listen(PORT, HOST, () => {
    console.log(`Job Agent → ${link}  (close this window or press Ctrl+C to stop)`);
    if (process.argv.includes("--open")) openBrowser(link);
  });
}
void boot();

const shutdown = (): void => {
  server.close();
  void pool.end().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
