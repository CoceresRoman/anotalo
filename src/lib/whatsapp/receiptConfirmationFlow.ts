// Receipt-image decision/persistence flow: the state machine between a
// ticket/factura photo sent over WhatsApp (connection.ts -> router.ts)
// and an actual Expense row. Fifth member of the
// Reminder/PendingDeletion/PendingCuotaPayment/PendingPurchaseSimulation
// "at most one pending confirmation of any kind" family (schema.prisma
// comment on PendingReceiptConfirmation) — mirrors cuotaPaymentFlow.ts's
// exact request/handleXReply/resendPendingXPrompt skeleton, with one
// structural difference: a HIGH-confidence read is NOT a "confirm with
// sí/no" stage — it logs the Expense directly, since by design a
// confident read needs no confirmation. Only a LOW-confidence read ever
// creates a pending row and waits for a reply.
//
// Concurrency/invariant: same discipline as cuotaPaymentFlow.ts's/
// deleteFlow.ts's own pending-row inserts — the PendingReceiptConfirmation
// row below is created via an atomic INSERT ... WHERE NOT EXISTS (raw SQL),
// never a plain check-then-create. deleteFlow.ts documents why a plain
// check is not enough: src/app/api/sin-clasificar/[id]/route.ts can promote
// a Reminder to awaiting_confirmation from the webapp, a path that is NOT
// serialized against the WhatsApp message queue in connection.ts — so a
// Reminder (or a PendingDeletion/PendingCuotaPayment/
// PendingPurchaseSimulation) can appear in the gap between a separate check
// and a separate create. SQLite serializes writers, so the atomic insert
// below has no such gap. This insert also self-checks against a second
// PendingReceiptConfirmation row (two low-confidence photos in a row must
// never both open one — a later "sí"/"no" could otherwise resolve the
// wrong row via findFirst()'s unordered pick). Wiring this flow's OWN
// PendingReceiptConfirmation row into the OTHER four flows' own atomic
// guards (so e.g. requestDelete also refuses to run while a receipt
// confirmation is open) lives in each of those files' own insert/request
// functions (reminders.ts/deleteFlow.ts/cuotaPaymentFlow.ts/
// purchaseFeasibilityFlow.ts) — this file only needs to protect its OWN
// insert against the other four.
import { randomUUID } from "node:crypto";
import { config } from "../config";
import db from "../db";
import { formatCents } from "../money";
import { argentinaDateParts } from "../timezone";
import type { ClassificationResult } from "./classify";
import { sendSelfMessage } from "./connection";
import { extractReceiptFromImage, RECEIPT_CONFIDENCE_THRESHOLD, type ReceiptExtraction } from "./ocrReceipt";
import { persistClassifiedNote } from "./persist";
import { classifyYesNo, promptNextIfIdle } from "./reminders";

// Sends a self-chat message without ever throwing — same local pattern as
// cuotaPaymentFlow.ts's/deleteFlow.ts's own sendSelfMessageSafely.
async function sendSelfMessageSafely(text: string): Promise<void> {
  try {
    await sendSelfMessage(text);
  } catch (err) {
    console.error("[receiptConfirmationFlow] could not send WhatsApp message", err);
  }
}

// Same shape as router.ts's own (unexported) NO_IDENTIFICADO — duplicated
// rather than imported since router.ts doesn't export it (and this file is
// consumed BY router.ts, not the other way around).
const NO_IDENTIFICADO: ClassificationResult = { intent: "capture", noteType: "no_identificado" };

const UNREADABLE_RECEIPT_RAW_TEXT = "[imagen de ticket no legible]";
const FAILED_RECEIPT_RAW_TEXT = "[imagen de ticket — error técnico al procesar]";
const LOGGED_RECEIPT_RAW_TEXT = "[imagen de ticket]";

const UNREADABLE_MESSAGE = "No pude leer el ticket. Mandalo de nuevo o cargá el gasto a mano.";
// Exportado: router.ts reusa este mismo texto para su propio caso de
// "la imagen de ticket no se pudo descargar" (connection.ts no entregó
// ningún buffer) — es la misma falla técnica que esta función reporta
// cuando SÍ tiene un buffer pero falla al procesarlo con Groq, así que debe
// ser una única fuente de verdad, nunca una segunda copia del string que
// pueda desalinearse.
export const FAILED_MESSAGE = "Tuve un problema técnico leyendo la foto. Probá de nuevo en un rato.";
const BLOCKED_MESSAGE =
  "Tenés algo pendiente de confirmar antes. Resolvelo y mandame la foto de nuevo.";
const REJECTED_MESSAGE = "Dale, no cargué el gasto.";

type ReceiptFields = { amountCents: number; category: string; occurredAt: Date };

function dayMonth(occurredAt: Date): string {
  const p = argentinaDateParts(occurredAt);
  return `${p.day}/${p.month}`;
}

function describeReceiptExpense(fields: ReceiptFields): string {
  return `${formatCents(fields.amountCents, config.defaultCurrency, config.locale)} en ${fields.category}, ${dayMonth(fields.occurredAt)}`;
}

function autoLoggedMessage(fields: ReceiptFields): string {
  return `Anotado: ${describeReceiptExpense(fields)}.`;
}

function pendingConfirmationPrompt(fields: ReceiptFields): string {
  return `Leí un ticket: ${describeReceiptExpense(fields)}. ¿Lo cargo? (respondé sí/no)`;
}

// The actual Note+Expense write (shared by the auto-log path in
// handleReceiptImage and the "sí" branch of handleReceiptConfirmationReply,
// so the transaction is never duplicated) — same Note+Expense-in-one-
// transaction pattern as persist.ts, but with an EXPLICIT occurredAt (the
// extraction's/pending row's own date), never persistClassifiedNote's
// always-created.createdAt.
async function persistReceiptExpense(fields: ReceiptFields, waMessageId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const note = await tx.note.create({
      data: {
        rawText: LOGGED_RECEIPT_RAW_TEXT,
        source: "image",
        type: "gasto",
        whatsappMessageId: waMessageId,
      },
    });
    await tx.expense.create({
      data: {
        noteId: note.id,
        amountCents: fields.amountCents,
        category: fields.category,
        currency: config.defaultCurrency,
        occurredAt: fields.occurredAt,
      },
    });
  });
}

// Inserts the PendingReceiptConfirmation row only if no Reminder is
// currently awaiting_confirmation/confirming AND no PendingDeletion row
// exists AND no PendingCuotaPayment row exists AND no
// PendingPurchaseSimulation row exists AND no PendingReceiptConfirmation row
// already exists (this file's own self-check — two low-confidence photos in
// a row must never both open a row, or a later "sí"/"no" could resolve the
// wrong one via findFirst()'s unordered pick) — in the SAME statement that
// checks all five conditions, mirroring insertPendingDeletionIfNoReminderPending's
// (deleteFlow.ts) and insertPendingCuotaPaymentIfNothingElsePending's
// (cuotaPaymentFlow.ts) own INSERT ... WHERE NOT EXISTS pattern. Returns
// false (and writes nothing) when any of the five won the race against
// this insert.
async function insertPendingReceiptConfirmationIfNothingElsePending(
  fields: ReceiptFields
): Promise<boolean> {
  const id = randomUUID();
  const insertedCount = await db.$executeRaw`
    INSERT INTO "PendingReceiptConfirmation" ("id", "amountCents", "category", "occurredAt")
    SELECT ${id}, ${fields.amountCents}, ${fields.category}, ${fields.occurredAt}
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

export type ReceiptImageOutcome =
  | "auto_logged"
  | "pending_confirmation"
  | "blocked_by_other_pending"
  | "unreadable"
  | "failed";

export async function handleReceiptImage(
  imageBuffer: Buffer,
  waMessageId: string,
  nowIso: string
): Promise<ReceiptImageOutcome> {
  const extraction: ReceiptExtraction | "unreadable" | "failed" = await extractReceiptFromImage(
    imageBuffer,
    nowIso
  );

  if (extraction === "unreadable") {
    await persistClassifiedNote(NO_IDENTIFICADO, UNREADABLE_RECEIPT_RAW_TEXT, "image", waMessageId);
    await sendSelfMessageSafely(UNREADABLE_MESSAGE);
    return "unreadable";
  }

  if (extraction === "failed") {
    await persistClassifiedNote(NO_IDENTIFICADO, FAILED_RECEIPT_RAW_TEXT, "image", waMessageId);
    await sendSelfMessageSafely(FAILED_MESSAGE);
    return "failed";
  }

  const fields: ReceiptFields = {
    amountCents: extraction.amountCents,
    category: extraction.category,
    occurredAt: extraction.occurredAt,
  };

  if (extraction.confidencePercent >= RECEIPT_CONFIDENCE_THRESHOLD) {
    // The real incoming image message's own id — this Note IS the direct
    // record of that message, unlike the synthetic "web:"-prefixed id used
    // below for a Note created later, out-of-band, by a confirmation reply.
    await persistReceiptExpense(fields, waMessageId);
    await sendSelfMessageSafely(autoLoggedMessage(fields));
    return "auto_logged";
  }

  const inserted = await insertPendingReceiptConfirmationIfNothingElsePending(fields);
  if (!inserted) {
    await sendSelfMessageSafely(BLOCKED_MESSAGE);
    return "blocked_by_other_pending";
  }

  await sendSelfMessageSafely(pendingConfirmationPrompt(fields));
  return "pending_confirmation";
}

export type ReceiptConfirmationReplyOutcome = "confirmed" | "rejected" | "no_pending" | "unrecognized";

export async function handleReceiptConfirmationReply(
  replyText: string
): Promise<ReceiptConfirmationReplyOutcome> {
  const pending = await db.pendingReceiptConfirmation.findFirst();
  if (!pending) return "no_pending";

  const fields: ReceiptFields = {
    amountCents: pending.amountCents,
    category: pending.category,
    occurredAt: pending.occurredAt,
  };

  const classification = classifyYesNo(replyText);

  if (classification === "confirm") {
    // Not a real WhatsApp message id — PendingReceiptConfirmation doesn't
    // store the original image message's id (schema: id/amountCents/
    // category/occurredAt/requestedAt only), so this Note is a separate,
    // synthetic row for the now-confirmed expense. Same "web:"-prefixed
    // random id pattern as cuotas.ts's payItem/payGroup and
    // savingsWithdrawal.ts.
    await persistReceiptExpense(fields, `web:${randomUUID()}`);
    await db.pendingReceiptConfirmation.delete({ where: { id: pending.id } });
    // The slot is free again — a Reminder/PendingDeletion/PendingCuotaPayment/
    // PendingPurchaseSimulation queued behind it can now be promoted/created.
    // Never throws.
    await promptNextIfIdle();
    await sendSelfMessageSafely(autoLoggedMessage(fields));
    return "confirmed";
  }

  if (classification === "reject") {
    await db.pendingReceiptConfirmation.delete({ where: { id: pending.id } });
    await promptNextIfIdle();
    await sendSelfMessageSafely(REJECTED_MESSAGE);
    return "rejected";
  }

  return "unrecognized";
}

// Re-sends the "leí esto, ¿lo cargo?" prompt for whatever
// PendingReceiptConfirmation is currently open. Never throws (same style as
// resendPendingCuotaPaymentPrompt in cuotaPaymentFlow.ts).
export async function resendPendingReceiptPrompt(): Promise<void> {
  try {
    const pending = await db.pendingReceiptConfirmation.findFirst();
    if (!pending) return;

    await sendSelfMessageSafely(
      pendingConfirmationPrompt({
        amountCents: pending.amountCents,
        category: pending.category,
        occurredAt: pending.occurredAt,
      })
    );
  } catch (err) {
    console.error("[receiptConfirmationFlow] resendPendingReceiptPrompt failed", err);
  }
}
