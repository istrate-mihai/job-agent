// src/scripts/gmailAuth.ts
import { authorizeInteractive } from "../ingest/gmail/auth.js";

try {
  await authorizeInteractive();
  console.log("Gmail authorized. Token saved to secrets/gmail-token.json");
} catch (err: unknown) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
