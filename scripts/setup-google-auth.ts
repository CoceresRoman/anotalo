// One-time interactive CLI: authorizes this app's Google OAuth client for
// Calendar access and writes the resulting refresh token to
// ./.google-token.json (gitignored — see .gitignore's "whatsapp / google
// auth" section), which src/lib/calendar.ts reads on every
// createCalendarEvent call from then on. Run once with:
//
//   npx tsx scripts/setup-google-auth.ts
//
// Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (and optionally
// GOOGLE_REDIRECT_URI, default below) to already be set — either in the
// environment or in a ./.env file in the project root — from an OAuth
// client you create yourself in Google Cloud Console (type: "Desktop
// app" works fine for the manual copy-paste flow this script uses).
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { google } from "googleapis";

const TOKEN_PATH = path.resolve(process.cwd(), ".google-token.json");
const ENV_PATH = path.resolve(process.cwd(), ".env");
const DEFAULT_REDIRECT_URI = "http://localhost:3000/oauth2callback";

// A reminder only ever needs to create/read calendar events, never see the
// rest of your calendar — the narrowest scope that can do that.
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

// Minimal .env loader (same approach as vitest.setup.ts's loadEnvTestFile):
// this script runs standalone via `npx tsx`, outside Next.js's own request
// pipeline, so nothing else loads .env for it. Never overrides a variable
// already present in process.env.
async function loadDotEnvFile(filePath: string): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf-8");
  } catch {
    return;
  }
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function buildConsentUrl(oauth2Client: InstanceType<typeof google.auth.OAuth2>): string {
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [CALENDAR_SCOPE],
    // Without this, Google only issues a refresh_token the very first time
    // a given account authorizes this client — re-running the script to
    // fix a mistake would otherwise silently come back with no
    // refresh_token at all.
    prompt: "consent",
  });
}

// You paste either the bare authorization code or the full URL your
// browser got redirected to (http://localhost:.../oauth2callback?code=...),
// which never actually loads (nothing is listening on that port) but still
// shows the code in the address bar. Accepting either avoids a fragile
// "must copy exactly this substring" instruction.
export function extractAuthorizationCode(pastedInput: string): string {
  const trimmed = pastedInput.trim();
  if (!trimmed) {
    throw new Error("No code/URL was entered");
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    if (!code) {
      throw new Error(`No "code" query parameter found in the pasted URL: ${trimmed}`);
    }
    return code;
  }
  return trimmed;
}

export async function exchangeAndSaveToken(
  oauth2Client: InstanceType<typeof google.auth.OAuth2>,
  code: string,
  tokenPath: string
): Promise<void> {
  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh_token. This usually means the account already authorized " +
        "this client before without revoking access — remove this app's access at " +
        "https://myaccount.google.com/permissions and run this script again."
    );
  }
  await writeFile(tokenPath, JSON.stringify(tokens, null, 2), "utf-8");
}

async function main(): Promise<void> {
  await loadDotEnvFile(ENV_PATH);

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;

  if (!clientId || !clientSecret) {
    console.error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set (in the environment or in ./.env) " +
        "before running this script."
    );
    process.exitCode = 1;
    return;
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const consentUrl = buildConsentUrl(oauth2Client);

  console.log("1. Open this URL in a browser and authorize with the Google account to use:\n");
  console.log(consentUrl);
  console.log(
    "\n2. After authorizing, the browser will redirect to a URL that fails to load " +
      `(nothing is listening on ${redirectUri}) — that's expected.`
  );
  console.log('3. Paste the full redirected URL (or just its "code" value) below.\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let pastedInput: string;
  try {
    pastedInput = await rl.question("Paste the redirected URL or code: ");
  } finally {
    rl.close();
  }

  const code = extractAuthorizationCode(pastedInput);
  await exchangeAndSaveToken(oauth2Client, code, TOKEN_PATH);

  console.log(`\nSaved the refresh token to ${TOKEN_PATH}. Google Calendar sync is ready to use.`);
}

// Only runs the interactive flow when this file is executed directly (e.g.
// `npx tsx scripts/setup-google-auth.ts`), not when its exported helpers
// are imported for testing.
if (process.argv[1] && process.argv[1].endsWith("setup-google-auth.ts")) {
  main().catch((err) => {
    console.error("setup-google-auth failed:", err);
    process.exitCode = 1;
  });
}
