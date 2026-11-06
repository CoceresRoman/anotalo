// Shared cascading-delete helper for a Note: the single place that decides
// how deleting a Note interacts with its Reminder row and, through it, a
// Google Calendar event. Both the web DELETE endpoints and the
// WhatsApp delete flow call this instead of re-deriving the
// ordering themselves.
import db from "./db";
import { deleteCalendarEvent } from "./calendar";

// "deleted" covers both "successfully removed" and "there was nothing to
// remove" (idempotent) — callers that need to distinguish those don't
// exist yet, and the brief's return type only has two members.
export async function deleteNoteCascading(
  noteId: string
): Promise<"deleted" | "calendar_delete_failed"> {
  const note = await db.note.findUnique({
    where: { id: noteId },
    include: { reminder: true },
  });

  // Already gone: deleting a note that doesn't exist is a harmless no-op,
  // not an error — the caller's goal (the note is gone) already holds.
  if (!note) return "deleted";

  const calendarEventId = note.reminder?.calendarEventId;
  if (calendarEventId) {
    try {
      // Resolving ("deleted" or "already_gone") means Calendar is no
      // longer a reason to keep the row around; only a throw blocks the
      // delete below.
      await deleteCalendarEvent(calendarEventId);
    } catch (err) {
      console.error("[noteDeletion] deleteCalendarEvent failed", err);
      // Nothing deleted: the Reminder still points at a Calendar event we
      // couldn't confirm is gone, so the Note must stay findable too (a
      // Reminder row with no Note would be orphaned and never shown).
      return "calendar_delete_failed";
    }
  }

  // Children first, then Note, in one transaction — same discipline as
  // persist.ts's create (just in reverse order), and required by each
  // child's noteId foreign key: the child row must go before its parent.
  // deleteMany (not delete) for all five: a note has at most one Expense/
  // Income/Saving/Reminder and zero or more RecurringPayment rows, but
  // deleteMany doesn't throw when there's no matching row, unlike delete —
  // so one shape works for every note type without branching on note.type.
  await db.$transaction([
    db.recurringPayment.deleteMany({ where: { noteId } }),
    db.reminder.deleteMany({ where: { noteId } }),
    db.expense.deleteMany({ where: { noteId } }),
    db.income.deleteMany({ where: { noteId } }),
    db.saving.deleteMany({ where: { noteId } }),
    db.note.delete({ where: { id: noteId } }),
  ]);

  return "deleted";
}
