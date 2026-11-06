// Reminder confirmation queue: the state machine between a classified
// "recordatorio" Note and an actual Google Calendar event. The anti-goal
// this file exists to enforce: NEVER create a Calendar event without
// the user's explicit "sí" (or equivalent) reply — enqueueReminder only ever
// asks; handleConfirmationReply is the sole caller of createCalendarEvent,
// and only on its confirm branch.
//
// Concurrency rule: only one Reminder is ever `awaiting_confirmation` (or
// `confirming`, the short-lived state while its Calendar write is in
// flight) at a time. A reminder that arrives while another is already pending stays
// `queued` and only gets its own prompt once the pending one resolves
// (confirmed or rejected) — see promptNextIfIdle below.
//
// NOTE: this file is distinct from `src/lib/reminders.ts` (the UI
// badge-formatting helpers for the Recordatorios page) — same word,
// unrelated module, do not merge or confuse the two.
import type { Reminder } from "@prisma/client";
import { createCalendarEvent, isGoogleCalendarConfigured } from "../calendar";
import db from "../db";
import { argentinaDateParts } from "../timezone";
import { sendSelfMessage } from "./connection";

// A message is a yes/no reply only when the WHOLE trimmed message is one of
// these short tokens, optionally followed by punctuation/whitespace ("sí.",
// "dale!", "ok ?"). Anchored at both ends, not just the start: unaccented
// "si" ("if"), "ok", "dale", "no" and "mal" all begin ordinary sentences —
// "si llueve llevar paraguas" must never create a Calendar event, and
// "no olvidar pagar la luz" must never discard the reminder (and with it,
// lose the message). Anything longer ("sí, pero a las 16", "no sé si va")
// is "unrecognized": the router classifies and saves it as a normal note
// and re-sends the prompt.
//
// The trailing class deliberately excludes letters, digits and "_", which
// also keeps the earlier boundary fix: the brief's `\b` (which fails right
// after a non-ASCII "í", breaking "sí") is gone, "sin"/"ok2"/"dale_algo"
// still don't match, and "sí"/"SÍ" do.
const CONFIRM_REGEX = /^(s[ií]|dale|correcto|ok)[\s.,;:!¡?¿]*$/i;
const REJECT_REGEX = /^(no|mal|incorrecto)[\s.,;:!¡?¿]*$/i;

/** Whether a message reads as a yes/no answer to a confirmation prompt. */
export function isConfirmationReplyText(text: string): boolean {
  const trimmed = text.trim();
  return CONFIRM_REGEX.test(trimmed) || REJECT_REGEX.test(trimmed);
}

// Shared with deleteFlow.ts (its "confirming" stage uses the exact same
// yes/no vocabulary as a reminder confirmation reply).
export function classifyYesNo(text: string): "confirm" | "reject" | "unrecognized" {
  const trimmed = text.trim();
  if (CONFIRM_REGEX.test(trimmed)) return "confirm";
  if (REJECT_REGEX.test(trimmed)) return "reject";
  return "unrecognized";
}

// Always rendered in Argentina time, never the server's local clock: the
// production VM runs in UTC, where getHours() would show "18:00" for a
// 15:00 ART reminder — and you would be confirming a time that isn't the
// one you meant (or, worse, a correct-looking time for a wrong instant).
function formatReminderDate(date: Date): string {
  const p = argentinaDateParts(date);
  return `${p.day}/${p.month}/${p.year} a las ${p.hour}:${p.minute}`;
}

const MAX_PROMPT_TEXT_LENGTH = 120;

// Shared with deleteFlow.ts: both the reminder-confirmation prompt and the
// delete-confirmation prompt quote the note's text the same way.
export function quoteNoteText(rawText: string | undefined): string {
  const text = (rawText ?? "recordatorio").replace(/\s+/g, " ").trim();
  return text.length > MAX_PROMPT_TEXT_LENGTH ? `${text.slice(0, MAX_PROMPT_TEXT_LENGTH - 1)}…` : text;
}

// Names the reminder (its note's text) and the full date including year,
// so a "sí" can never be mistaken as answering a different reminder — e.g.
// the next queued one, prompted right after the previous one resolved.
async function confirmationPrompt(reminder: Reminder): Promise<string> {
  const note = await db.note.findUnique({ where: { id: reminder.noteId } });
  // Only a "queued" reminder (always with a parsedDatetime) is ever promoted
  // to awaiting_confirmation, so the fallback is purely type-level.
  const when = reminder.parsedDatetime ? formatReminderDate(reminder.parsedDatetime) : "sin fecha clara";
  return `Entendí: "${quoteNoteText(note?.rawText)}" para el ${when}, ¿va? (respondé sí/no)`;
}

// Sends a self-chat message without ever throwing: used for notices whose
// failure must not abort the state transition that triggered them (the
// state itself is always left consistent and visible in the webapp).
async function sendSelfMessageSafely(text: string): Promise<boolean> {
  try {
    await sendSelfMessage(text);
    return true;
  } catch (err) {
    console.error("[reminders] could not send WhatsApp message", err);
    return false;
  }
}

// Promotes the oldest still-queued reminder to awaiting_confirmation —
// but only when nothing else is already awaiting a reply or mid-confirmation.
//
// enqueueReminder (hence this) is called from two independent entry points
// that are NOT serialized against each other: the WhatsApp message loop
// (connection.ts serializes messages among themselves) and
// src/app/api/sin-clasificar/[id]/route.ts, a separate HTTP route. A plain
// read-then-write sequence would let two overlapping calls both see
// "nobody's awaiting" and both promote a reminder. Instead the check and
// the claim are one atomic SQL UPDATE (the "nobody's busy" check is a NOT
// EXISTS evaluated by the same statement that writes). SQLite serializes
// writers, so the second concurrent execution necessarily affects zero rows.
//
// "confirming" counts as busy too: while one reminder's Calendar write is
// in flight it may still revert to awaiting_confirmation (Calendar
// failure), and a second reminder promoted in that window would break the
// one-at-a-time invariant.
//
// A pending PendingDeletion row (deleteFlow.ts), a pending
// PendingCuotaPayment row (cuotaPaymentFlow.ts), a pending
// PendingPurchaseSimulation row (purchaseFeasibilityFlow.ts), OR a
// pending PendingReceiptConfirmation row (receiptConfirmationFlow.ts)
// counts as busy too: all share this same "one pending
// confirmation of any kind" slot, so a reminder is never promoted while the
// user still has an open delete confirmation/disambiguation, an open
// cuota-payment disambiguation, an open purchase-feasibility question, or
// an open receipt (ticket photo) confirmation, to answer.
async function claimNextQueuedReminder(): Promise<Reminder | null> {
  const promoted = await db.$queryRaw<Reminder[]>`
    UPDATE "Reminder"
    SET "status" = 'awaiting_confirmation'
    WHERE "id" = (
      SELECT "id" FROM "Reminder" WHERE "status" = 'queued' ORDER BY "createdAt" ASC, "id" ASC LIMIT 1
    )
    AND NOT EXISTS (
      SELECT 1 FROM "Reminder" WHERE "status" IN ('awaiting_confirmation', 'confirming')
    )
    AND NOT EXISTS (SELECT 1 FROM "PendingDeletion")
    AND NOT EXISTS (SELECT 1 FROM "PendingCuotaPayment")
    AND NOT EXISTS (SELECT 1 FROM "PendingPurchaseSimulation")
    AND NOT EXISTS (SELECT 1 FROM "PendingReceiptConfirmation")
    RETURNING *
  `;
  const row = promoted[0];
  if (!row) return null;
  // $queryRaw returns SQLite's raw column values; re-read through Prisma so
  // parsedDatetime is a real Date.
  return db.reminder.findUnique({ where: { id: row.id } });
}

// Never throws. If the prompt can't be sent (WhatsApp disconnected), the
// claim is reverted to "queued" — resumeReminderQueue re-runs this as soon
// as the connection opens again, so the reminder is never stranded.
export async function promptNextIfIdle(): Promise<void> {
  try {
    const next = await claimNextQueuedReminder();
    if (!next) return;

    const sent = await sendSelfMessageSafely(await confirmationPrompt(next));
    if (!sent) {
      await db.reminder.updateMany({
        where: { id: next.id, status: "awaiting_confirmation" },
        data: { status: "queued" },
      });
    }
  } catch (err) {
    console.error("[reminders] promptNextIfIdle failed", err);
  }
}

// The Reminder row for a note, with the code-level date guards:
// an Invalid Date never reaches Prisma, and a datetime that isn't strictly
// in the future is never trusted ("always resolve forward" is enforced
// here, not just requested of the LLM) — both become ambiguous_no_date:
// visible in the webapp, never prompted, never sent to Calendar.
export function reminderRowData(noteId: string, parsedDatetime: Date | null, now: Date = new Date()) {
  const usable =
    parsedDatetime !== null &&
    !Number.isNaN(parsedDatetime.getTime()) &&
    parsedDatetime.getTime() > now.getTime();
  return {
    noteId,
    parsedDatetime: usable ? parsedDatetime : null,
    status: usable ? "queued" : "ambiguous_no_date",
    calendarEventId: null,
  };
}

export async function enqueueReminder(noteId: string, parsedDatetime: Date | null): Promise<void> {
  await db.reminder.create({ data: reminderRowData(noteId, parsedDatetime) });
  await promptNextIfIdle();
}

// Re-sends the prompt for whichever reminder is currently awaiting a reply.
// Called by the router after it handled a message that turned out NOT to
// be a reply to the prompt, so the user is reminded the question is open.
// Never throws.
export async function resendPendingPrompt(): Promise<void> {
  try {
    const pending = await db.reminder.findFirst({ where: { status: "awaiting_confirmation" } });
    if (!pending) return;
    await sendSelfMessageSafely(await confirmationPrompt(pending));
  } catch (err) {
    console.error("[reminders] resendPendingPrompt failed", err);
  }
}

// Run once every time the WhatsApp connection opens (connection.ts, inside
// its serialized processing queue so it never overlaps a reply being
// handled). Two jobs:
// 1. A reminder left "confirming" can only mean the process died between
//    claiming it and recording the Calendar result. Put it back to
//    awaiting_confirmation (if nothing else is) and re-ask — never create
//    the event without a fresh "sí".
// 2. Prompt a reminder stranded in "queued" while disconnected (e.g. one
//    created from the webapp, whose prompt couldn't be sent).
export async function resumeReminderQueue(): Promise<void> {
  try {
    const recovered = await db.$queryRaw<Reminder[]>`
      UPDATE "Reminder"
      SET "status" = 'awaiting_confirmation'
      WHERE "id" = (
        SELECT "id" FROM "Reminder" WHERE "status" = 'confirming' ORDER BY "createdAt" ASC, "id" ASC LIMIT 1
      )
      AND NOT EXISTS (SELECT 1 FROM "Reminder" WHERE "status" = 'awaiting_confirmation')
      RETURNING "id"
    `;
    if (recovered.length > 0) {
      await resendPendingPrompt();
      return;
    }
    await promptNextIfIdle();
  } catch (err) {
    console.error("[reminders] resumeReminderQueue failed", err);
  }
}

export type ConfirmationOutcome =
  | "confirmed"
  // Confirmed, but Google Calendar isn't configured for this deployment
  // (no GOOGLE_CLIENT_ID/SECRET), so no Calendar event was attempted at all.
  | "confirmed_no_calendar"
  | "rejected"
  | "calendar_failed"
  // A yes/no reply whose reminder was resolved by a concurrent reply first
  // (lost the atomic claim) — it WAS a reply, just a redundant one.
  | "already_resolved"
  | "no_pending"
  | "unrecognized";

export async function handleConfirmationReply(replyText: string): Promise<ConfirmationOutcome> {
  const pending = await db.reminder.findFirst({
    where: { status: { in: ["awaiting_confirmation", "confirming"] } },
  });
  if (!pending) return "no_pending";

  const classification = classifyYesNo(replyText);
  const isConfirm = classification === "confirm";
  const isReject = classification === "reject";

  if (pending.status === "confirming") {
    // Another reply is mid-way through confirming this reminder (its
    // Calendar call is in flight). A second yes/no is redundant; anything
    // else is a new message for the router to classify.
    return isConfirm || isReject ? "already_resolved" : "no_pending";
  }

  if (isConfirm) {
    // Google Calendar isn't configured for this deployment (no
    // GOOGLE_CLIENT_ID/SECRET) — open-source clones shouldn't get stuck in
    // the calendar_failed retry/"no" loop below just because nobody has set
    // up Calendar credentials. Confirm directly, skipping both the
    // short-lived "confirming" status and the try/catch around
    // createCalendarEvent entirely: this is a parallel path taken only when
    // Calendar isn't configured, not a replacement for the confirmation
    // gate itself. Still claims atomically straight from
    // awaiting_confirmation (the same invariant holds here too).
    if (!isGoogleCalendarConfigured()) {
      const { count } = await db.reminder.updateMany({
        where: { id: pending.id, status: "awaiting_confirmation" },
        data: { status: "confirmed", calendarEventId: null },
      });
      if (count === 0) return "already_resolved";

      const note = await db.note.findUnique({ where: { id: pending.noteId } });
      await sendSelfMessageSafely(
        `Guardado: "${quoteNoteText(note?.rawText)}". No se sincronizó con ningún calendario porque la integración con Google Calendar no está configurada.`
      );
      await promptNextIfIdle();
      return "confirmed_no_calendar";
    }

    // Claim FIRST, call Calendar second: only the call whose guarded
    // update wins ever reaches createCalendarEvent. A concurrent second
    // "sí" (Baileys doesn't await async listeners, and the webapp route
    // runs outside the WhatsApp queue) affects zero rows and returns
    // without touching Calendar.
    const { count } = await db.reminder.updateMany({
      where: { id: pending.id, status: "awaiting_confirmation" },
      data: { status: "confirming" },
    });
    if (count === 0) return "already_resolved";

    const note = await db.note.findUnique({ where: { id: pending.noteId } });
    const summary = note?.rawText ?? "Recordatorio";

    let eventId: string;
    try {
      if (!pending.parsedDatetime) throw new Error("el recordatorio no tiene fecha");
      eventId = await createCalendarEvent(summary, pending.parsedDatetime);
    } catch (err) {
      // Never fail silently. Put the reminder back where a new "sí"
      // retries it (or "no" discards it), and tell the user why.
      console.error("[reminders] createCalendarEvent failed", err);
      await db.reminder.updateMany({
        where: { id: pending.id, status: "confirming" },
        data: { status: "awaiting_confirmation" },
      });
      const reason = err instanceof Error ? err.message : String(err);
      await sendSelfMessageSafely(
        `⚠️ No pude crear el evento en Google Calendar para "${quoteNoteText(note?.rawText)}" (${reason}). ` +
          `Sigue pendiente: respondé sí para reintentar o no para descartarlo.`
      );
      return "calendar_failed";
    }

    await db.reminder.updateMany({
      where: { id: pending.id, status: "confirming" },
      data: { status: "confirmed", calendarEventId: eventId },
    });
    await promptNextIfIdle();
    return "confirmed";
  }

  if (isReject) {
    const { count } = await db.reminder.updateMany({
      where: { id: pending.id, status: "awaiting_confirmation" },
      data: { status: "rejected" },
    });
    if (count === 0) return "already_resolved";
    await promptNextIfIdle();
    return "rejected";
  }

  // Not a yes/no: this is NOT a reply to the prompt but a new message that
  // happened to arrive while one was pending. Nothing changes here; the
  // router persists/answers it normally and then calls resendPendingPrompt.
  return "unrecognized";
}
