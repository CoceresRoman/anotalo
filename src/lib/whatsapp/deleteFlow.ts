// Delete confirmation/disambiguation queue: the state machine between a
// natural-language delete request by WhatsApp ("borrá esa", "eliminá la
// idea de los libros") and an actual cascading delete (noteDeletion.ts).
// Mirrors reminders.ts's confirmation flow, but for note deletion instead
// of Calendar-event creation. The anti-goal this file exists to enforce:
// NEVER delete a note without the user's explicit "sí" (or equivalent) reply
// — requestDelete only ever asks or lists candidates; handleDeleteReply is
// the sole caller of deleteNoteCascading, and only on its confirm branch
// while stage is "confirming".
//
// Concurrency/invariant: at most one PendingDeletion row exists at a time,
// and it shares its "one pending confirmation of any kind" slot with
// Reminder.status — requestDelete refuses to create a PendingDeletion
// while a Reminder is awaiting_confirmation/confirming, and
// claimNextQueuedReminder (reminders.ts) refuses to promote a queued
// reminder while a PendingDeletion row exists. Both sides of that
// invariant are enforced ATOMICALLY in code (one guarded SQL statement
// each), not just checked with a plain read-then-write: enqueueReminder is
// reachable from two entry points not serialized against each other (the
// WhatsApp message loop and src/app/api/sin-clasificar/[id]/route.ts), so
// a Reminder can be promoted to awaiting_confirmation at any point between
// requestDelete's candidate lookup and it writing its own row — a plain
// "check Reminder, then separately insert PendingDeletion" would have a
// window where both end up open at once.
import { randomUUID } from "node:crypto";
import db from "../db";
import { findDeleteCandidates, type DeletableNote } from "./deleteMatch";
import { deleteNoteCascading } from "../noteDeletion";
import { classifyYesNo, promptNextIfIdle, quoteNoteText } from "./reminders";
import { sendSelfMessage } from "./connection";

const MAX_DISAMBIGUATE_LIST = 5;

// Sends a self-chat message without ever throwing: used for notices whose
// failure must not abort the state transition that triggered them (same
// discipline as reminders.ts's sendSelfMessageSafely).
async function sendSelfMessageSafely(text: string): Promise<void> {
  try {
    await sendSelfMessage(text);
  } catch (err) {
    console.error("[deleteFlow] could not send WhatsApp message", err);
  }
}

function confirmationPromptFor(note: DeletableNote | { rawText: string }): string {
  return `¿Borro "${quoteNoteText(note.rawText)}"? (respondé sí/no)`;
}

function disambiguationPromptFor(notes: DeletableNote[]): string {
  const lines = notes.map((note, i) => `${i + 1}. "${quoteNoteText(note.rawText)}"`);
  return `${lines.join("\n")}\nRespondé con el número (o 'ninguna').`;
}

const BLOCKED_PENDING_REMINDER_MESSAGE =
  "Tenés un recordatorio pendiente de confirmar — respondé sí/no antes de pedir un borrado.";

// Inserts the PendingDeletion row only if no Reminder is currently
// awaiting_confirmation/confirming AND no PendingDeletion row already
// exists AND no PendingCuotaPayment row exists (cuotaPaymentFlow.ts) AND no PendingPurchaseSimulation row exists
// (purchaseFeasibilityFlow.ts) AND no PendingReceiptConfirmation
// row exists (receiptConfirmationFlow.ts — all four share
// this same "one pending confirmation of any kind" slot) — in the SAME
// statement that checks all five conditions, mirroring
// claimNextQueuedReminder's own UPDATE ... WHERE NOT EXISTS pattern
// (reminders.ts). SQLite serializes writers, so whichever of "a Reminder
// gets promoted" / "a PendingDeletion gets created" / "a PendingCuotaPayment
// gets created" / "a PendingPurchaseSimulation gets created" / "a
// PendingReceiptConfirmation gets created" / "this insert runs" commits
// first is also the one the others see — there is no gap between the check
// and the write for a concurrent enqueueReminder, a concurrent
// requestCuotaPayment, a concurrent purchase-feasibility question, a
// concurrent receipt confirmation, OR a second requestDelete call to land
// in. Returns false (and writes nothing) when a Reminder, an existing
// PendingDeletion, an existing PendingCuotaPayment, an existing
// PendingPurchaseSimulation, or an existing PendingReceiptConfirmation won
// the race.
async function insertPendingDeletionIfNoReminderPending(
  stage: "confirming" | "disambiguating",
  noteIds: string[]
): Promise<boolean> {
  const id = randomUUID();
  const encodedNoteIds = JSON.stringify(noteIds);
  const insertedCount = await db.$executeRaw`
    INSERT INTO "PendingDeletion" ("id", "stage", "noteIds")
    SELECT ${id}, ${stage}, ${encodedNoteIds}
    WHERE NOT EXISTS (
      SELECT 1 FROM "Reminder" WHERE "status" IN ('awaiting_confirmation', 'confirming')
    )
    AND NOT EXISTS (SELECT 1 FROM "PendingDeletion")
    AND NOT EXISTS (SELECT 1 FROM "PendingCuotaPayment")
    AND NOT EXISTS (SELECT 1 FROM "PendingPurchaseSimulation")
    AND NOT EXISTS (SELECT 1 FROM "PendingReceiptConfirmation")
  `;
  return insertedCount > 0;
}

const BLOCKED_PENDING_DELETION_MESSAGE =
  "Ya tenés un borrado pendiente — respondé esa confirmación primero (sí/no, un número, o 'ninguna').";

const BLOCKED_PENDING_CUOTA_PAYMENT_MESSAGE =
  "Ya tenés un pago de cuota pendiente de elegir — respondé esa confirmación (un número, o 'ninguna') antes de pedir un borrado.";

// Duplicated (not imported from purchaseFeasibilityFlow.ts, which
// didn't exist yet when this was written) — same accepted duplication
// pattern as BLOCKED_PENDING_REMINDER_MESSAGE/BLOCKED_PENDING_DELETION_MESSAGE/
// BLOCKED_PENDING_CUOTA_PAYMENT_MESSAGE already between this file and
// cuotaPaymentFlow.ts.
const BLOCKED_PENDING_PURCHASE_SIMULATION_MESSAGE =
  "Tenés una consulta de factibilidad de compra pendiente de responder — contestá eso antes de pedir un borrado.";

// Duplicated (not imported from receiptConfirmationFlow.ts) —
// same accepted duplication pattern as the other
// BLOCKED_PENDING_*_MESSAGE constants already between this file and
// cuotaPaymentFlow.ts/purchaseFeasibilityFlow.ts.
const BLOCKED_PENDING_RECEIPT_CONFIRMATION_MESSAGE =
  "Tenés un ticket pendiente de confirmar — respondé esa confirmación (sí/no) antes de pedir un borrado.";

export type DeleteRequestOutcome =
  | "asked_confirm"
  | "asked_disambiguate"
  | "none_found"
  | "blocked_pending_reminder"
  | "blocked_pending_deletion"
  | "blocked_pending_cuota_payment"
  | "blocked_pending_purchase_simulation"
  | "blocked_pending_receipt_confirmation";

export async function requestDelete(requestText: string): Promise<DeleteRequestOutcome> {
  // Fast path only: avoids the findDeleteCandidates lookup entirely in the
  // common case where a Reminder is already visibly pending. This read is
  // NOT what makes the invariant safe under concurrency — the atomic
  // insert below is — but it also lets a delete request for a note whose
  // OWN Reminder is pending (excluded from findDeleteCandidates's
  // candidates) still report "blocked_pending_reminder" instead of
  // "none_found".
  const pendingReminder = await db.reminder.findFirst({
    where: { status: { in: ["awaiting_confirmation", "confirming"] } },
  });
  if (pendingReminder) {
    await sendSelfMessageSafely(BLOCKED_PENDING_REMINDER_MESSAGE);
    return "blocked_pending_reminder";
  }

  // Same fast-path discipline as the Reminder check above, for an open
  // purchase-feasibility question (purchaseFeasibilityFlow.ts):
  // avoids the findDeleteCandidates lookup entirely in the common case
  // where a purchase-feasibility question is already visibly pending.
  const pendingPurchaseSimulation = await db.pendingPurchaseSimulation.findFirst();
  if (pendingPurchaseSimulation) {
    await sendSelfMessageSafely(BLOCKED_PENDING_PURCHASE_SIMULATION_MESSAGE);
    return "blocked_pending_purchase_simulation";
  }

  // Same fast-path discipline as the checks above, for an open receipt
  // (ticket photo) confirmation (receiptConfirmationFlow.ts) —
  // fifth member of the "one pending confirmation of any kind"
  // family.
  const pendingReceiptConfirmation = await db.pendingReceiptConfirmation.findFirst();
  if (pendingReceiptConfirmation) {
    await sendSelfMessageSafely(BLOCKED_PENDING_RECEIPT_CONFIRMATION_MESSAGE);
    return "blocked_pending_receipt_confirmation";
  }

  const match = await findDeleteCandidates(requestText);

  if (match.kind === "none") {
    await sendSelfMessageSafely("No encontré ninguna nota reciente que coincida con eso.");
    return "none_found";
  }

  const stage: "confirming" | "disambiguating" = match.kind === "single" ? "confirming" : "disambiguating";
  const notes: DeletableNote[] = match.kind === "single" ? [match.note] : match.notes.slice(0, MAX_DISAMBIGUATE_LIST);
  const noteIds = notes.map((n) => n.id);

  // The actual safety net: a Reminder promoted to awaiting_confirmation
  // anywhere between the fast-path check above and this very statement
  // (e.g. findDeleteCandidates's own await is itself a yield point) is
  // caught here, atomically, and this PendingDeletion is never created.
  const inserted = await insertPendingDeletionIfNoReminderPending(stage, noteIds);
  if (!inserted) {
    // The insert's guard failed for one of five reasons — a Reminder won
    // the race, a PendingDeletion already existed (e.g. another
    // delete request that slipped in via an unrecognized reply to the
    // first one), a PendingCuotaPayment is open (cuotaPaymentFlow.ts), a
    // PendingPurchaseSimulation is open (purchaseFeasibilityFlow.ts), or
    // a PendingReceiptConfirmation is open
    // (receiptConfirmationFlow.ts). These reads are
    // best-effort, purely to choose the right message: the atomicity that
    // actually matters already happened in the insert above, so a further
    // race here (the reminder resolving, say) only risks picking the
    // slightly-less-accurate message, never a second PendingDeletion row.
    const stillPendingReminder = await db.reminder.findFirst({
      where: { status: { in: ["awaiting_confirmation", "confirming"] } },
    });
    if (stillPendingReminder) {
      await sendSelfMessageSafely(BLOCKED_PENDING_REMINDER_MESSAGE);
      return "blocked_pending_reminder";
    }
    const openPendingDeletion = await db.pendingDeletion.findFirst();
    if (!openPendingDeletion) {
      const openPendingCuotaPayment = await db.pendingCuotaPayment.findFirst();
      if (openPendingCuotaPayment) {
        await sendSelfMessageSafely(BLOCKED_PENDING_CUOTA_PAYMENT_MESSAGE);
        return "blocked_pending_cuota_payment";
      }
      const openPendingPurchaseSimulation = await db.pendingPurchaseSimulation.findFirst();
      if (openPendingPurchaseSimulation) {
        await sendSelfMessageSafely(BLOCKED_PENDING_PURCHASE_SIMULATION_MESSAGE);
        return "blocked_pending_purchase_simulation";
      }
      const openPendingReceiptConfirmation = await db.pendingReceiptConfirmation.findFirst();
      if (openPendingReceiptConfirmation) {
        await sendSelfMessageSafely(BLOCKED_PENDING_RECEIPT_CONFIRMATION_MESSAGE);
        return "blocked_pending_receipt_confirmation";
      }
    }
    await sendSelfMessageSafely(BLOCKED_PENDING_DELETION_MESSAGE);
    return "blocked_pending_deletion";
  }

  if (match.kind === "single") {
    await sendSelfMessageSafely(confirmationPromptFor(notes[0]!));
    return "asked_confirm";
  }

  await sendSelfMessageSafely(disambiguationPromptFor(notes));
  return "asked_disambiguate";
}

export type DeleteReplyOutcome =
  | "deleted"
  | "rejected"
  | "disambiguated"
  | "calendar_failed"
  | "no_pending"
  | "unrecognized";

async function notesForIds(noteIds: string[]): Promise<DeletableNote[]> {
  const notes = await db.note.findMany({
    where: { id: { in: noteIds } },
    include: { reminder: true },
  });
  // Preserve the stored order (noteIds), not whatever order the DB returns.
  const byId = new Map(notes.map((n) => [n.id, n as DeletableNote]));
  return noteIds.map((id) => byId.get(id)).filter((n): n is DeletableNote => n !== undefined);
}

export async function handleDeleteReply(replyText: string): Promise<DeleteReplyOutcome> {
  const pending = await db.pendingDeletion.findFirst();
  if (!pending) return "no_pending";

  const noteIds: string[] = JSON.parse(pending.noteIds);

  if (pending.stage === "confirming") {
    const classification = classifyYesNo(replyText);

    if (classification === "confirm") {
      const noteId = noteIds[0]!;
      const result = await deleteNoteCascading(noteId);
      await db.pendingDeletion.delete({ where: { id: pending.id } });
      // The PendingDeletion slot is free again either way (deleted or
      // calendar_delete_failed) — a Reminder queued behind it can now
      // be promoted. Never throws.
      await promptNextIfIdle();

      if (result === "calendar_delete_failed") {
        await sendSelfMessageSafely(
          "⚠️ No pude borrar el evento en Google Calendar asociado a esa nota. Podés volver a pedir el borrado para reintentarlo."
        );
        return "calendar_failed";
      }

      await sendSelfMessageSafely("Listo, la borré.");
      return "deleted";
    }

    if (classification === "reject") {
      await db.pendingDeletion.delete({ where: { id: pending.id } });
      await promptNextIfIdle();
      await sendSelfMessageSafely("Dale, no borro nada.");
      return "rejected";
    }

    return "unrecognized";
  }

  // pending.stage === "disambiguating"
  const trimmed = replyText.trim();
  const isNone = trimmed.toLowerCase() === "ninguna" || classifyYesNo(replyText) === "reject";
  if (isNone) {
    await db.pendingDeletion.delete({ where: { id: pending.id } });
    await promptNextIfIdle();
    await sendSelfMessageSafely("Dale, no borro nada.");
    return "rejected";
  }

  const index = Number.parseInt(trimmed, 10);
  const isValidNumber = /^\d+$/.test(trimmed) && index >= 1 && index <= noteIds.length;
  if (!isValidNumber) return "unrecognized";

  const chosenNoteId = noteIds[index - 1]!;
  await db.pendingDeletion.update({
    where: { id: pending.id },
    data: { stage: "confirming", noteIds: JSON.stringify([chosenNoteId]) },
  });

  const [chosenNote] = await notesForIds([chosenNoteId]);
  await sendSelfMessageSafely(confirmationPromptFor(chosenNote ?? { rawText: "esa nota" }));
  return "disambiguated";
}

// Re-sends the prompt for whatever PendingDeletion is currently open, at
// whichever stage it's in. Never throws (same style as
// resendPendingPrompt in reminders.ts).
export async function resendPendingDeletePrompt(): Promise<void> {
  try {
    const pending = await db.pendingDeletion.findFirst();
    if (!pending) return;

    const noteIds: string[] = JSON.parse(pending.noteIds);
    const notes = await notesForIds(noteIds);

    if (pending.stage === "confirming") {
      const note = notes[0] ?? { rawText: "esa nota" };
      await sendSelfMessageSafely(confirmationPromptFor(note));
      return;
    }

    await sendSelfMessageSafely(disambiguationPromptFor(notes));
  } catch (err) {
    console.error("[deleteFlow] resendPendingDeletePrompt failed", err);
  }
}
