// Purchase-feasibility clarification queue: the state machine between a
// natural-language purchase question by WhatsApp ("¿me conviene comprar una
// heladera de 800.000 en 6 cuotas?") and the final composed answer
// (purchaseFeasibility.ts's extraction -> math/DB aggregates -> composition
// pipeline). This file owns NONE of that math/DB/Groq logic —
// only the conversation state: what's still missing, what to ask next, and
// when enough is known to resolve.
//
// Mirrors cuotaPaymentFlow.ts's own skeleton: an upfront 4-way mutual-
// exclusion guard (Reminder/PendingDeletion/PendingCuotaPayment/
// PendingPurchaseSimulation) checked in the same priority order,
// an atomic INSERT ... SELECT ... WHERE NOT EXISTS (...) that re-checks all
// four in the same statement (so a concurrent reminder/delete/cuota-payment/
// second purchase question landing in the gap between the upfront check and
// the insert is still caught), and the same sendSelfMessageSafely /
// promptNextIfIdle discipline as the other three flows.
//
// Nota: el mensaje "hay una consulta de factibilidad pendiente" que bloquea
// a los otros 3 flujos ya quedó duplicado inline en
// deleteFlow.ts/cuotaPaymentFlow.ts/reminders.ts — este archivo no
// exporta ni reusa ese string, solo define sus PROPIOS mensajes de bloqueo
// (para cuando ES este archivo el que está bloqueado por los otros tres, o
// por otra PendingPurchaseSimulation ya abierta).
import { randomUUID } from "node:crypto";
import db from "../db";
import {
  composeFeasibilityAnswer,
  evaluateFeasibility,
  extractPurchaseParams,
  NO_HISTORY_MESSAGE,
  type ExtractedPurchaseParams,
} from "./purchaseFeasibility";
import { classifyYesNo, promptNextIfIdle } from "./reminders";
import { sendSelfMessage } from "./connection";

export type MissingPurchaseField = "price" | "mode" | "installments" | "interest";

// Sends a self-chat message without ever throwing: used for notices whose
// failure must not abort the state transition that triggered them (same
// discipline as cuotaPaymentFlow.ts/deleteFlow.ts's sendSelfMessageSafely).
async function sendSelfMessageSafely(text: string): Promise<void> {
  try {
    await sendSelfMessage(text);
  } catch (err) {
    console.error("[purchaseFeasibilityFlow] could not send WhatsApp message", err);
  }
}

/**
 * Decide qué dato, si falta alguno, hay que pedirle al usuario antes de
 * poder evaluar la compra. Chequea en este orden exacto: precio -> modo de
 * pago -> cantidad de cuotas (solo si el modo las necesita) -> interés
 * (solo si el modo necesita cuotas Y el usuario ya dijo que hay interés
 * pero no dio ni la tasa ni el total final). Sin interés mencionado se
 * asume 0% sin preguntar nada.
 */
export function determineMissingField(params: ExtractedPurchaseParams): MissingPurchaseField | null {
  if (params.priceCents === undefined) return "price";
  if (params.mode === undefined) return "mode";

  const needsInstallments = params.mode === "cuotas" || params.mode === "ambos";
  if (needsInstallments) {
    if (params.installments === undefined) return "installments";
    if (
      params.hasInterest === true &&
      params.tnaPercent === undefined &&
      params.totalToPayCents === undefined
    ) {
      return "interest";
    }
  }

  return null;
}

const CLARIFICATION_QUESTIONS: Record<MissingPurchaseField, string> = {
  price: "¿Cuánto cuesta lo que querés comprar?",
  mode: "¿Lo pensás pagar en cuotas, de contado, querés que compare las dos opciones, querés ahorrar para comprarlo más adelante, o es un gasto recurrente que se repite todos los meses?",
  installments: "¿En cuántas cuotas?",
  interest: "¿A qué tasa (TNA) financiás, o cuánto vas a terminar pagando en total?",
};

function clarificationQuestionFor(missingField: MissingPurchaseField): string {
  return CLARIFICATION_QUESTIONS[missingField];
}

const BLOCKED_PENDING_REMINDER_MESSAGE =
  "Tenés un recordatorio pendiente de confirmar — respondé sí/no antes de consultar la factibilidad de una compra.";

const BLOCKED_PENDING_DELETION_MESSAGE =
  "Tenés un borrado pendiente de confirmar — respondé esa confirmación antes de consultar la factibilidad de una compra.";

const BLOCKED_PENDING_CUOTA_PAYMENT_MESSAGE =
  "Tenés un pago de cuota pendiente de elegir — respondé esa confirmación antes de consultar la factibilidad de una compra.";

const BLOCKED_PENDING_PURCHASE_SIMULATION_MESSAGE =
  "Ya tenés una consulta de factibilidad de compra pendiente de responder — contestá eso antes de preguntar por otra compra.";

// Duplicated (not imported from receiptConfirmationFlow.ts) —
// same accepted duplication pattern as the other
// BLOCKED_PENDING_*_MESSAGE constants already between this file and
// deleteFlow.ts/cuotaPaymentFlow.ts.
const BLOCKED_PENDING_RECEIPT_CONFIRMATION_MESSAGE =
  "Tenés un ticket pendiente de confirmar — respondé esa confirmación (sí/no) antes de consultar la factibilidad de una compra.";

// composeFeasibilityAnswer (purchaseFeasibility.ts) deliberately throws when
// Groq returns no content for the composed answer — by design, mirroring
// query.ts's composeAnswer. query.ts's own caller, answerQuery, guards
// against that by wrapping both of its Groq calls in one top-level
// try/catch and returning a fixed failure message on any error, so nothing
// ever escapes it. This file needs the exact same guard: router.ts's
// handleIncomingMessage wraps its call to classifyAndHandle in try/finally,
// NOT try/catch, so an uncaught throw here would propagate all the way out
// of the WhatsApp message handler for that message — violating this app's
// own invariant (router.ts's header comment) that a message in must always
// become either a persisted Note or a sent answer, never a dropped message.
const COMPUTE_FEASIBILITY_FAILURE_MESSAGE =
  "No pude calcular eso ahora, probá de nuevo en un rato.";

// Computes and sends the final feasibility answer for `params`, reusing the
// exact same evaluateFeasibility -> (NO_HISTORY_MESSAGE | composeFeasibilityAnswer)
// resolution in both requestPurchaseFeasibility's "nothing missing" path and
// handlePurchaseFeasibilityReply's "newMissing === null" / interest-exception
// paths. Both callers already delete the PendingPurchaseSimulation row (if
// any) and call promptNextIfIdle() BEFORE invoking this — the request is
// considered over the moment this is called, so a failure in here still
// results in a message being sent, never a silently dropped one.
async function computeAndSendFeasibilityAnswer(
  conversationText: string,
  params: ExtractedPurchaseParams
): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    const result = await evaluateFeasibility(params, nowIso);
    if (result === "no_history") {
      await sendSelfMessageSafely(NO_HISTORY_MESSAGE);
      return;
    }
    const answer = await composeFeasibilityAnswer(conversationText, result);
    await sendSelfMessageSafely(answer);
  } catch (err) {
    console.error("[purchaseFeasibilityFlow] could not compute/compose the feasibility answer", err);
    await sendSelfMessageSafely(COMPUTE_FEASIBILITY_FAILURE_MESSAGE);
  }
}

// Checks the 5-way mutual-exclusion invariant in priority order (Reminder ->
// PendingDeletion -> PendingCuotaPayment -> PendingReceiptConfirmation ->
// PendingPurchaseSimulation), sending the matching blocking message and
// returning true the moment one is found. Shared between
// requestPurchaseFeasibility's upfront check (called with
// assumeSelfIfNoneFound=false: nothing is blocking yet, so finding none of
// the five is the expected, silent case) and its post-insert-failure
// fallback (called with assumeSelfIfNoneFound=true: the insert's own WHERE
// NOT EXISTS already proved one of the five exists, so if the first four
// reads above — including PendingReceiptConfirmation, a real DB table
// distinct from this flow's own — come up empty, the blocker must be this
// flow's OWN self-check (another PendingPurchaseSimulation), sent
// unconditionally rather than queried again, same discipline as
// requestCuotaPayment's own post-insert-failure fallback in
// cuotaPaymentFlow.ts).
async function checkAndReportBlockedPending(assumeSelfIfNoneFound: boolean): Promise<boolean> {
  const pendingReminder = await db.reminder.findFirst({
    where: { status: { in: ["awaiting_confirmation", "confirming"] } },
  });
  if (pendingReminder) {
    await sendSelfMessageSafely(BLOCKED_PENDING_REMINDER_MESSAGE);
    return true;
  }

  const pendingDeletion = await db.pendingDeletion.findFirst();
  if (pendingDeletion) {
    await sendSelfMessageSafely(BLOCKED_PENDING_DELETION_MESSAGE);
    return true;
  }

  const pendingCuotaPayment = await db.pendingCuotaPayment.findFirst();
  if (pendingCuotaPayment) {
    await sendSelfMessageSafely(BLOCKED_PENDING_CUOTA_PAYMENT_MESSAGE);
    return true;
  }

  // Receipt (ticket photo) confirmation (receiptConfirmationFlow.ts) —
  // a real, separate table from this flow's own, so
  // always actually queried here (never assumed) in both call modes.
  const pendingReceiptConfirmation = await db.pendingReceiptConfirmation.findFirst();
  if (pendingReceiptConfirmation) {
    await sendSelfMessageSafely(BLOCKED_PENDING_RECEIPT_CONFIRMATION_MESSAGE);
    return true;
  }

  if (assumeSelfIfNoneFound) {
    await sendSelfMessageSafely(BLOCKED_PENDING_PURCHASE_SIMULATION_MESSAGE);
    return true;
  }

  const pendingPurchaseSimulation = await db.pendingPurchaseSimulation.findFirst();
  if (pendingPurchaseSimulation) {
    await sendSelfMessageSafely(BLOCKED_PENDING_PURCHASE_SIMULATION_MESSAGE);
    return true;
  }

  return false;
}

// Inserts the PendingPurchaseSimulation row only if no Reminder is currently
// awaiting_confirmation/confirming AND no PendingDeletion row exists AND no
// PendingCuotaPayment row exists AND no PendingPurchaseSimulation row
// already exists AND no PendingReceiptConfirmation row exists
// (receiptConfirmationFlow.ts) — in the SAME statement
// that checks all five conditions, mirroring
// insertPendingCuotaPaymentIfNothingElsePending's own pattern
// (cuotaPaymentFlow.ts). SQLite serializes writers, so there is no
// gap between the check and the write for a concurrent enqueueReminder, a
// concurrent requestDelete, a concurrent requestCuotaPayment, a concurrent
// receipt confirmation, OR a second requestPurchaseFeasibility call to land
// in. Returns false (and writes nothing) when any of the five won the race.
async function insertPendingPurchaseSimulationIfNothingElsePending(
  conversationText: string,
  missingField: MissingPurchaseField
): Promise<boolean> {
  const id = randomUUID();
  const insertedCount = await db.$executeRaw`
    INSERT INTO "PendingPurchaseSimulation" ("id", "conversationText", "missingField")
    SELECT ${id}, ${conversationText}, ${missingField}
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

export type PurchaseFeasibilityRequestOutcome = "answered" | "asked_clarify" | "blocked_pending";

export async function requestPurchaseFeasibility(
  questionText: string
): Promise<PurchaseFeasibilityRequestOutcome> {
  if (await checkAndReportBlockedPending(false)) {
    return "blocked_pending";
  }

  const params = await extractPurchaseParams(questionText);
  const missingField = determineMissingField(params);

  if (missingField !== null) {
    const inserted = await insertPendingPurchaseSimulationIfNothingElsePending(questionText, missingField);
    if (!inserted) {
      // Best-effort read, purely to choose the right blocking message — the
      // atomicity that matters already happened in the insert above. Same
      // priority order as the upfront guard, with the fourth leg sent
      // unconditionally if the first three come up empty (see
      // checkAndReportBlockedPending's own comment).
      await checkAndReportBlockedPending(true);
      return "blocked_pending";
    }

    await sendSelfMessageSafely(clarificationQuestionFor(missingField));
    return "asked_clarify";
  }

  await computeAndSendFeasibilityAnswer(questionText, params);
  return "answered";
}

export type PurchaseFeasibilityReplyOutcome =
  | "answered"
  | "asked_clarify"
  | "cancelled"
  | "no_pending"
  | "unrecognized";

export async function handlePurchaseFeasibilityReply(
  replyText: string
): Promise<PurchaseFeasibilityReplyOutcome> {
  const pending = await db.pendingPurchaseSimulation.findFirst();
  if (!pending) return "no_pending";

  if (classifyYesNo(replyText) === "reject") {
    await db.pendingPurchaseSimulation.delete({ where: { id: pending.id } });
    // The slot is free again — a Reminder/PendingDeletion/PendingCuotaPayment
    // queued behind it can now be promoted/created. Never throws.
    await promptNextIfIdle();
    await sendSelfMessageSafely("Dale, no sigo con esa consulta.");
    return "cancelled";
  }

  const newConversationText = `${pending.conversationText}\n${replyText}`;
  const newParams = await extractPurchaseParams(newConversationText);
  const newMissing = determineMissingField(newParams);

  if (newMissing === null) {
    await db.pendingPurchaseSimulation.delete({ where: { id: pending.id } });
    await promptNextIfIdle();
    await computeAndSendFeasibilityAnswer(newConversationText, newParams);
    return "answered";
  }

  if (newMissing !== pending.missingField) {
    // Progress: a different field is now missing than the one that was
    // asked about — update the row in place (same id) and ask the new
    // question.
    await db.pendingPurchaseSimulation.update({
      where: { id: pending.id },
      data: { conversationText: newConversationText, missingField: newMissing },
    });
    await sendSelfMessageSafely(clarificationQuestionFor(newMissing));
    return "asked_clarify";
  }

  // newMissing === pending.missingField: no progress — the re-extraction
  // still reports the SAME missing field as before. There's no safe
  // default for ANY of the four fields (price/mode/installments/interest):
  // a bare reject ("no"/"mal"/"incorrecto") already cancelled the whole
  // request above via classifyYesNo, so there's no real risk of an
  // infinite loop here — and silently assuming 0% interest would both
  // understate the financing cost with nothing disclosing the assumption,
  // and risk swallowing an unrelated message (e.g. a new expense) that
  // happened to not re-resolve "interest" either. Leave the pending row
  // completely untouched and don't send anything from here — this reply is
  // treated as an unrelated message so the router can classify it normally
  // and re-show the pending question afterwards.
  return "unrecognized";
}

// Re-sends the clarification question for whichever PendingPurchaseSimulation
// is currently open. Never throws (same style as resendPendingCuotaPaymentPrompt
// in cuotaPaymentFlow.ts / resendPendingDeletePrompt in deleteFlow.ts).
export async function resendPendingPurchaseFeasibilityPrompt(): Promise<void> {
  try {
    const pending = await db.pendingPurchaseSimulation.findFirst();
    if (!pending) return;

    const missingField = pending.missingField as MissingPurchaseField;
    await sendSelfMessageSafely(clarificationQuestionFor(missingField));
  } catch (err) {
    console.error("[purchaseFeasibilityFlow] resendPendingPurchaseFeasibilityPrompt failed", err);
  }
}
