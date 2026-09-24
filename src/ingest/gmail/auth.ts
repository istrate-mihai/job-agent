// src/ingest/gmail/auth.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";
import { z } from "zod";

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]; // ⚠ Security: read-only, nothing can be sent or deleted
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
