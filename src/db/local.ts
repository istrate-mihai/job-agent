// src/db/local.ts
// Starts/stops the database for whichever mode .env selects, so nobody needs Docker:
//   DB_MODE=embedded  → a real PostgreSQL shipped as an npm package (embedded-postgres), data in .pgdata/
//   DB_MODE=docker    → docker compose service "db" (the default when DB_MODE is unset, for existing installs)
//   DB_MODE=external  → you run Postgres yourself; only connectivity is checked
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";

export type DbMode = "embedded" | "docker" | "external";

const ROOT = process.cwd();
export const DATA_DIR = resolve(ROOT, ".pgdata");
const LOG_FILE = resolve(ROOT, ".pgdata.log");

export function dbMode(): DbMode {
  const raw = (process.env["DB_MODE"] || "docker").trim().toLowerCase();
  if (raw === "embedded" || raw === "docker" || raw === "external") return raw;
  throw new Error(`DB_MODE must be embedded, docker or external (got "${raw}")`);
}

interface Conn {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
}

export function connection(url = process.env["DATABASE_URL"]): Conn {
  if (!url) throw new Error("DATABASE_URL is not set in .env (run: npm run setup)");
  const u = new URL(url);
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    host: u.hostname || "127.0.0.1",
    port: Number(u.port || 5432),
    database: decodeURIComponent(u.pathname.slice(1)) || "postgres",
  };
}

/** true when the configured database accepts connections */
export async function isUp(url = process.env["DATABASE_URL"]): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function exec(cmd: string, args: string[], opts: { quiet?: boolean } = {}): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    let output = "";
    const child = spawn(cmd, args, { cwd: ROOT, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const collect = (d: Buffer): void => {
      output += d.toString();
      if (!opts.quiet) process.stdout.write(d);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => done({ code: 127, output: err.message }));
    child.on("close", (code) => done({ code: code ?? 1, output }));
  });
}

export async function dockerAvailable(): Promise<boolean> {
  return (await exec("docker", ["info", "--format", "{{.ServerVersion}}"], { quiet: true })).code === 0;
}

async function binaries(): Promise<{ pg_ctl: string; initdb: string }> {
  const pkg = `@embedded-postgres/${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  try {
    return (await import(pkg)) as { pg_ctl: string; initdb: string };
  } catch {
    throw new Error(`No embedded PostgreSQL for ${process.platform}-${process.arch} (${pkg}). Run npm ci again, or use DB_MODE=docker.`);
  }
}

async function waitUntilUp(seconds: number, url = process.env["DATABASE_URL"]): Promise<boolean> {
  for (let i = 0; i < seconds; i += 1) {
    if (await isUp(url)) return true;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

async function startEmbedded(): Promise<void> {
  const c = connection();
  if (!["127.0.0.1", "localhost"].includes(c.host)) throw new Error("DB_MODE=embedded needs DATABASE_URL on 127.0.0.1");
  const bin = await binaries();

  if (!existsSync(join(DATA_DIR, "PG_VERSION"))) {
    console.log(`Creating the local database in ${DATA_DIR} (first run only)…`);
    await mkdir(DATA_DIR, { recursive: true });
    // ⚠ Security: password via a temp file, never on the command line (visible in process lists)
    const pwFile = resolve(ROOT, `.pgpw-${randomBytes(6).toString("hex")}`);
    await writeFile(pwFile, c.password, { mode: 0o600 });
    try {
      const init = await exec(bin.initdb, ["-D", DATA_DIR, "-U", c.user, `--pwfile=${pwFile}`, "-A", "scram-sha-256", "-E", "UTF8", "--locale=C"], { quiet: true });
      if (init.code !== 0) {
        await rm(DATA_DIR, { recursive: true, force: true });
        const hint = /root/i.test(init.output) ? " PostgreSQL refuses to run as root/Administrator: run as a normal user." : "";
        throw new Error(`initdb failed:${hint}\n${init.output.trim()}`);
      }
    } finally {
      await rm(pwFile, { force: true });
    }
  }

  if ((await exec(bin.pg_ctl, ["status", "-D", DATA_DIR], { quiet: true })).code !== 0) {
    // pg_ctl daemonizes: the database keeps running after this process (or the GUI) exits, like a Docker container
    const start = await exec(
      bin.pg_ctl,
      ["start", "-D", DATA_DIR, "-l", LOG_FILE, "-w", "-t", "60", "-o", `-p ${c.port} -c listen_addresses=127.0.0.1`],
      { quiet: true },
    );
    if (start.code !== 0) throw new Error(`PostgreSQL did not start (see ${LOG_FILE}):\n${start.output.trim()}`);
  }
  // Server first (maintenance DB), then make sure the app database exists
  const admin = { host: "127.0.0.1", port: c.port, user: c.user, password: c.password, database: "postgres" };
  const adminUrl = `postgres://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@127.0.0.1:${c.port}/postgres`;
  if (!(await waitUntilUp(30, adminUrl))) throw new Error(`PostgreSQL is not accepting connections on port ${c.port}. Check ${LOG_FILE}.`);
  const client = new pg.Client(admin);
  await client.connect();
  try {
    const exists = await client.query("select 1 from pg_database where datname = $1", [c.database]);
    if (exists.rowCount === 0) await client.query(`create database "${c.database.replace(/"/g, '""')}"`);
  } finally {
    await client.end();
  }
  if (!(await waitUntilUp(10))) throw new Error(`Database "${c.database}" is not reachable on port ${c.port}. Check ${LOG_FILE}.`);
}

export async function startDb(): Promise<void> {
  const mode = dbMode();
  if (await isUp()) return;
  if (mode === "embedded") return startEmbedded();
  if (mode === "docker") {
    if (!(await dockerAvailable())) {
      throw new Error("Docker is not running. Start Docker Desktop, or switch to the built-in database: set DB_MODE=embedded in .env (npm run setup does it).");
    }
    const up = await exec("docker", ["compose", "up", "-d", "--wait", "db"]);
    if (up.code !== 0) throw new Error("docker compose up failed (output above).");
    if (!(await waitUntilUp(30))) throw new Error("Docker database started but is not reachable with DATABASE_URL.");
    return;
  }
  throw new Error("DB_MODE=external and the database is not reachable with DATABASE_URL.");
}

export async function stopDb(): Promise<void> {
  const mode = dbMode();
  if (mode === "embedded") {
    if (!existsSync(join(DATA_DIR, "PG_VERSION"))) return;
    const bin = await binaries();
    await exec(bin.pg_ctl, ["stop", "-D", DATA_DIR, "-m", "fast", "-w"], { quiet: true });
  } else if (mode === "docker") {
    await exec("docker", ["compose", "stop", "db"]);
  }
}
