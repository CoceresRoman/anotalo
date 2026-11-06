// Google Calendar integration: the only place in the app that talks to the
// Calendar API. Deliberately does nothing else — no confirmation-queue
// logic (that's src/lib/whatsapp/reminders.ts, which is this module's only
// caller) and no OAuth consent flow (that's the one-time
// scripts/setup-google-auth.ts). This module just reads the token that
// script already wrote to disk and uses it to create events.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { google } from "googleapis";
import { ARGENTINA_TZ, toArgentinaIsoString } from "./timezone";

// Gitignored (see .gitignore's "whatsapp / google auth" section) — written
// once by scripts/setup-google-auth.ts when the user authorizes Calendar
// access, read here on every call. Never committed: it holds a live refresh
// token.
const TOKEN_PATH = path.resolve(process.cwd(), ".google-token.json");

// A reminder is just "do this at roughly this time" with no end time of its
// own, so a fixed 30-minute block is a reasonable default duration for the
// Calendar event rather than leaving the event with no end at all.
const DEFAULT_EVENT_DURATION_MS = 30 * 60 * 1000;

// Without an explicit timeout, a hung network path to Google could block
// this call forever — and with it, the bot's serialized WhatsApp message
// queue (see src/lib/whatsapp/reminders.ts), since messages are processed
// one at a time.
const CALENDAR_REQUEST_TIMEOUT_MS = 20_000;

interface StoredGoogleToken {
  refresh_token?: string;
  access_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
}

// Whether this deployment has Google Calendar credentials at all. Callers
// (src/lib/whatsapp/reminders.ts) use this to skip Calendar entirely rather
// than calling createCalendarEvent and handling the resulting failure —
// without it, confirming a reminder on a fresh clone with no Google
// credentials configured would throw here, get caught by the retry/"no"
// loop in reminders.ts, and never actually resolve.
export function isGoogleCalendarConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID) && Boolean(process.env.GOOGLE_CLIENT_SECRET);
}

async function buildAuthorizedClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables must be set to use Google Calendar"
    );
  }

  let raw: string;
  try {
    raw = await readFile(TOKEN_PATH, "utf-8");
  } catch {
    throw new Error(
      `${TOKEN_PATH} not found — run "npx tsx scripts/setup-google-auth.ts" once to authorize Google Calendar access`
    );
  }
  const token: StoredGoogleToken = JSON.parse(raw);

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oauth2Client.setCredentials(token);
  return oauth2Client;
}

export async function createCalendarEvent(summary: string, start: Date): Promise<string> {
  const auth = await buildAuthorizedClient();
  const calendar = google.calendar({ version: "v3", auth });

  const end = new Date(start.getTime() + DEFAULT_EVENT_DURATION_MS);

  const response = await calendar.events.insert(
    {
      calendarId: "primary",
      requestBody: {
        summary,
        // Explicit Argentina offset + timeZone: never left to whatever
        // the server's or the calendar's ambient timezone happens to be.
        start: { dateTime: toArgentinaIsoString(start), timeZone: ARGENTINA_TZ },
        end: { dateTime: toArgentinaIsoString(end), timeZone: ARGENTINA_TZ },
      },
    },
    { timeout: CALENDAR_REQUEST_TIMEOUT_MS }
  );

  const eventId = response.data.id;
  if (!eventId) {
    throw new Error("Google Calendar did not return an event id for the created event");
  }
  return eventId;
}

// googleapis (via gaxios) reports the HTTP status on `code` for API-level
// errors, and also on `status` and `response.status`. gaxios types `code` as
// string | number, so compare through Number() on each field: a string "404"
// must match too.
function isNotFoundError(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
  return (
    Number(e?.code) === 404 || Number(e?.status) === 404 || Number(e?.response?.status) === 404
  );
}

// Returns "already_gone" when Google says the event doesn't exist (404), so
// callers can treat a repeated delete as success. Any other error propagates.
export async function deleteCalendarEvent(eventId: string): Promise<"deleted" | "already_gone"> {
  const auth = await buildAuthorizedClient();
  const calendar = google.calendar({ version: "v3", auth });

  try {
    await calendar.events.delete(
      { calendarId: "primary", eventId },
      { timeout: CALENDAR_REQUEST_TIMEOUT_MS }
    );
  } catch (err) {
    if (isNotFoundError(err)) return "already_gone";
    throw err;
  }
  return "deleted";
}
