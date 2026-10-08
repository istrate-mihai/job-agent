// src/ingest/gmail/auth.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";
import { z } from "zod";

// ⚠ Security: read + compose. compose is used ONLY to create drafts for outreach (src/outreach/gmailDraft.ts);
// no code path calls drafts.send or messages.send, so you always review and press Send yourself.
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"];
const CREDENTIALS_PATH = "secrets/gmail-credentials.json";
const TOKEN_PATH = "secrets/gmail-token.json";

const ClientKeySchema = z.object({ client_id: z.string(), client_secret: z.string() });
const CredentialsSchema = z.union([
  z.object({ installed: ClientKeySchema }),
  z.object({ web: ClientKeySchema }),
]);
const TokenSchema = z.object({
  type: z.literal("authorized_user"),
  client_id: z.string(),
  client_secret: z.string(),
  refresh_token: z.string(),
});

export type GmailAuth = InstanceType<typeof google.auth.OAuth2>;

export async function loadGmailAuth(): Promise<GmailAuth> {
  let raw: string;
  try {
    raw = await readFile(TOKEN_PATH, "utf8");
  } catch {
    throw new Error(`Gmail not authorized (${TOKEN_PATH} missing). Run: npm run gmail:auth`);
  }
  const token = TokenSchema.parse(JSON.parse(raw));
  const auth = new google.auth.OAuth2(token.client_id, token.client_secret);
  auth.setCredentials({ refresh_token: token.refresh_token });
  return auth;
}

export async function authorizeInteractive(): Promise<void> {
  const credentials = CredentialsSchema.parse(JSON.parse(await readFile(CREDENTIALS_PATH, "utf8")));
  const key = "installed" in credentials ? credentials.installed : credentials.web;

  const client = await authenticate({ scopes: SCOPES, keyfilePath: CREDENTIALS_PATH }); // opens the browser consent screen
  const refreshToken = client.credentials.refresh_token;
  if (!refreshToken) {
    throw new Error(
      "Google returned no refresh token. Remove the app at https://myaccount.google.com/permissions and run gmail:auth again.",
    );
  }

  await mkdir("secrets", { recursive: true });
  const token: z.infer<typeof TokenSchema> = {
    type: "authorized_user",
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: refreshToken,
  };
  await writeFile(TOKEN_PATH, JSON.stringify(token, null, 2), { mode: 0o600 });
}

/** Turns Google's terse auth errors into the fix. invalid_grant = refresh token revoked or expired
 *  (apps left in "Testing" mode get 7-day tokens: publish the app to stop that, see npm run gmail:setup). */
export function explainGmailError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/invalid_grant|token has been expired or revoked/i.test(msg)) {
    return new Error("Gmail authorization expired or was revoked. Reconnect: npm run gmail:setup (or the Setup page in the app).");
  }
  if (/insufficient.*scope|insufficientPermissions/i.test(msg)) {
    return new Error("Gmail token is missing a permission. Reconnect: npm run gmail:setup");
  }
  if (/Gmail API has not been used|accessNotConfigured|SERVICE_DISABLED/i.test(msg)) {
    return new Error("The Gmail API is not enabled in your Google Cloud project: https://console.cloud.google.com/apis/library/gmail.googleapis.com");
  }
  return err instanceof Error ? err : new Error(msg);
}

export const GMAIL_PATHS = { credentials: CREDENTIALS_PATH, token: TOKEN_PATH } as const;
export { CredentialsSchema };
