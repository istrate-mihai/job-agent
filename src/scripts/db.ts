// src/scripts/db.ts
// Usage: npm run db:up | db:down | db:status   (mode from DB_MODE in .env: embedded | docker | external)
import { dbMode, isUp, startDb, stopDb } from "../db/local.js";

async function main(): Promise<number> {
  const action = process.argv[2] ?? "status";
  const mode = dbMode();
  if (action === "up") {
    await startDb();
    console.log(`✔ Database running (${mode}).`);
    return 0;
  }
  if (action === "down") {
    await stopDb();
    console.log(`Database stopped (${mode}).`);
    return 0;
  }
  const up = await isUp();
  console.log(`${up ? "✔ running" : "✖ not running"} (${mode})${up ? "" : " — start it: npm run db:up"}`);
  return up ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
