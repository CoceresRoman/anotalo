// Turns a `ClassificationResult` (from classify.ts) into the persisted
// `Note` row, plus whatever side-table row its type requires. This is the
// single place that writes a classified message to the database, shared by
// router.ts, the manual-reclassification `PATCH`
// (consolidating the duplication noted there), and the reminder confirmation
// flow.
import type { Note } from "@prisma/client";
import { config } from "../config";
import db from "../db";
import type { ClassificationResult, NoteType } from "./classify";
import { promptNextIfIdle, reminderRowData } from "./reminders";

export async function persistClassifiedNote(
  result: ClassificationResult,
  rawText: string,
  source: "text" | "audio" | "image",
  waMessageId: string
): Promise<Note> {
  const noteType: NoteType = result.noteType ?? "no_identificado";

  // Note + its Expense/Reminder row in ONE transaction, same as the
  // sin-clasificar reclassification route: if the second write fails, the
  // Note rolls back too — never a "gasto"/"recordatorio" Note with no
  // matching row (invisible in every webapp view). The caller (router.ts)
  // then falls back to persisting the message as no_identificado, so a
  // failure here still never loses the message.
  const note = await db.$transaction(async (tx) => {
    const created = await tx.note.create({
      data: {
        rawText,
        source,
        type: noteType,
        whatsappMessageId: waMessageId,
      },
    });

    if (noteType === "gasto") {
      // Never skip the Note for missing fields: amountCents/category default
      // instead of being required, so an incomplete classification still
      // produces a persisted (if imperfect) Expense row the webapp can later
      // correct via PATCH /api/gastos/:id.
      await tx.expense.create({
        data: {
          noteId: created.id,
          amountCents: result.amountCents ?? 0,
          category: result.category ?? null,
          // Only the configured default currency is summed into the totals.
          currency: result.currency ?? config.defaultCurrency,
          occurredAt: created.createdAt,
        },
      });
    } else if (noteType === "ingreso") {
      await tx.income.create({
        data: {
          noteId: created.id,
          amountCents: result.amountCents ?? 0,
          isSalary: result.isSalary ?? false,
          currency: result.currency ?? config.defaultCurrency,
          occurredAt: created.createdAt,
        },
      });
    } else if (noteType === "ahorro") {
      await tx.saving.create({
        data: {
          noteId: created.id,
          amountCents: result.amountCents ?? 0,
          currency: result.currency ?? config.defaultCurrency,
          occurredAt: created.createdAt,
        },
      });
    } else if (noteType === "recordatorio") {
      // reminderRowData applies the date guards: an invalid or past
      // datetime becomes ambiguous_no_date instead of reaching Prisma as an
      // Invalid Date (which would throw) or being prompted as-is.
      const parsed = result.parsedDatetime ? new Date(result.parsedDatetime) : null;
      await tx.reminder.create({ data: reminderRowData(created.id, parsed) });
    }

    return created;
  });

  // The prompt is a side effect outside the DB, so it runs only after the
  // transaction committed. promptNextIfIdle never throws.
  if (noteType === "recordatorio") await promptNextIfIdle();

  return note;
}
