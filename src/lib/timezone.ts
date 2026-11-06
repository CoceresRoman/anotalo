// Server-side date math for your timezone. Every server-side place that
// turns an instant into a calendar date/time a human sees (the WhatsApp
// confirmation prompt, the Calendar event, month/day boundaries for totals
// and queries) MUST go through these helpers instead of Date's local-clock
// methods (getHours(), getDate(), ...) — the production VM runs in UTC, and
// the local-clock methods would silently render/compute in UTC there. The
// webapp's client-side pages don't need this: browsers already run in the
// viewer's own timezone.
//
// The timezone/offset come from config.ts (APP_TIMEZONE/APP_UTC_OFFSET),
// defaulting to America/Argentina/Buenos_Aires, a fixed UTC-3 with no DST
// (none since 2009). This module still assumes a FIXED offset with no DST —
// building boundary instants with a literal offset is only exact for a zone
// like that; formatting still goes through Intl with an explicit timeZone.

import { config } from "./config";

// Kept as aliases (rather than renaming every internal use below) so
// classify.ts/calendar.ts don't need to change their imports.
export const ARGENTINA_TZ = config.timezone;
export const ARGENTINA_UTC_OFFSET = config.utcOffset;

export type ArgentinaDateParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: config.timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

// formatToParts + manual padStart (rather than trusting a locale's output
// shape) because some Node/ICU builds don't zero-pad "2-digit" fields for
// every locale (see the old formatReminderDate comment in whatsapp/reminders.ts).
export function argentinaDateParts(date: Date): ArgentinaDateParts {
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    partsFormatter.formatToParts(date).find((p) => p.type === type)?.value ?? "0";
  return {
    year: get("year").padStart(4, "0"),
    month: get("month").padStart(2, "0"),
    day: get("day").padStart(2, "0"),
    // Some ICU builds render midnight as "24" even with hourCycle h23.
    hour: (get("hour") === "24" ? "00" : get("hour")).padStart(2, "0"),
    minute: get("minute").padStart(2, "0"),
    second: get("second").padStart(2, "0"),
  };
}

/** "2026-11-04T15:00:00-03:00" — the instant rendered as Argentina wall-clock time. */
export function toArgentinaIsoString(date: Date): string {
  const p = argentinaDateParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${config.utcOffset}`;
}

/** "2026-11-04" — the Argentina calendar date of an instant. */
export function toArgentinaDateString(date: Date): string {
  const p = argentinaDateParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Start (inclusive) or end (inclusive, last millisecond) of an Argentina calendar day "YYYY-MM-DD". */
export function argentinaDayBoundary(ymd: string, endOfDay: boolean): Date {
  const time = endOfDay ? "23:59:59.999" : "00:00:00.000";
  return new Date(`${ymd}T${time}${config.utcOffset}`);
}

/** [start, end) of an Argentina calendar month; monthIndex is 0-based. */
export function argentinaMonthRange(year: number, monthIndex: number): { start: Date; end: Date } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const nextYear = monthIndex === 11 ? year + 1 : year;
  const nextMonthIndex = (monthIndex + 1) % 12;
  return {
    start: new Date(`${year}-${pad(monthIndex + 1)}-01T00:00:00.000${config.utcOffset}`),
    end: new Date(`${nextYear}-${pad(nextMonthIndex + 1)}-01T00:00:00.000${config.utcOffset}`),
  };
}
