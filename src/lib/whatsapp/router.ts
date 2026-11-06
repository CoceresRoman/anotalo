// Wires the WhatsApp connection to classification and persistence:
// this is the `onMessage` callback instrumentation.ts installs. A single
// message in must always become either a persisted Note or a sent answer —
// never a dropped message or an unhandled exception (the "never loses a
// message" requirement).
import { addMonthsToYearMonth } from "../cuotas";
import { config } from "../config";
import { formatCents } from "../money";
import db from "../db";
import { toArgentinaDateString } from "../timezone";
import { classifyMessage, type ClassificationResult } from "./classify";
import { sendSelfMessage } from "./connection";
import {
  handleCuotaPaymentReply,
  requestCuotaPayment,
  resendPendingCuotaPaymentPrompt,
} from "./cuotaPaymentFlow";
import { handleDeleteReply, requestDelete, resendPendingDeletePrompt } from "./deleteFlow";
import { persistClassifiedNote } from "./persist";
import {
  composeSavingsProjectionAnswer,
  NO_HISTORY_SAVINGS_MESSAGE,
  projectMonthlySavingsCapacity,
} from "./purchaseFeasibility";
import {
  handlePurchaseFeasibilityReply,
  requestPurchaseFeasibility,
  resendPendingPurchaseFeasibilityPrompt,
} from "./purchaseFeasibilityFlow";
import { answerQuery } from "./query";
import {
  FAILED_MESSAGE as RECEIPT_FAILED_MESSAGE,
  handleReceiptConfirmationReply,
  handleReceiptImage,
  resendPendingReceiptPrompt,
} from "./receiptConfirmationFlow";
import { handleConfirmationReply, isConfirmationReplyText, resendPendingPrompt } from "./reminders";
import { withdrawSavings } from "./savingsWithdrawal";
import { transcribeAudio } from "./transcribe";

// Fixed failure message for the proyeccion_ahorro
// branch below — same discipline as COMPUTE_FEASIBILITY_FAILURE_MESSAGE in
// purchaseFeasibilityFlow.ts, so a Groq failure here never escapes
// handleIncomingMessage uncaught (it only wraps classifyAndHandle in
// try/finally, not try/catch).
const SAVINGS_PROJECTION_FAILURE_MESSAGE = "No pude calcular eso ahora, probá de nuevo en un rato.";

// Fixed placeholder raw text for a Note created when an audio message
// couldn't be turned into text at all — transcription failed (Groq
// failure, empty/corrupt audio) or the audio couldn't even be downloaded
// (connection.ts then hands over no buffer). The message still becomes a
// persisted no_identificado Note instead of vanishing silently.
const UNTRANSCRIBABLE_AUDIO_TEXT = "[audio no transcribible]";

const NO_IDENTIFICADO: ClassificationResult = { intent: "capture", noteType: "no_identificado" };

// Fixed placeholder raw text for an image message whose download failed
// (connection.ts couldn't fetch the media) — same criterion as
// UNTRANSCRIBABLE_AUDIO_TEXT above for audio: there's no buffer at all to
// send to Groq, so the message still becomes a persisted no_identificado
// Note instead of vanishing silently.
const UNDOWNLOADED_RECEIPT_IMAGE_TEXT = "[imagen de ticket no descargada]";

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

// Universal idempotency: claims a WhatsApp message id before anything
// else happens, whatever the message turns out to be (capture, query,
// confirmation reply). The primary-key insert is atomic, so a redelivered
// message — an offline "append" batch overlapping an earlier "notify", a
// history-sync replay, a concurrent duplicate — or an id the bot recorded
// as its own sent message ("self_sent", see connection.ts) is rejected
// here and never has its effect applied twice. The claim is deliberately
// never released on failure: re-running a half-applied confirmation reply
// is a worse failure (anti-goal: wrong Calendar event) than not retrying,
// and every capture failure already has its own fallback below.
async function claimMessage(waMessageId: string): Promise<boolean> {
  try {
    await db.processedMessage.create({ data: { whatsappMessageId: waMessageId, outcome: "processing" } });
    return true;
  } catch (err) {
    if (isUniqueConstraintError(err)) return false;
    throw err;
  }
}

// Sends a self-chat message without ever throwing — same local pattern as
// deleteFlow.ts's/cuotaPaymentFlow.ts's own sendSelfMessageSafely. Used by
// the retiro_ahorro branch below: that withdrawal already committed by the
// time this runs, so a delivery failure here must never propagate out of
// handleIncomingMessage (which only wraps classifyAndHandle in try/finally,
// not try/catch) and must never undo or retry the withdrawal.
async function sendSelfMessageSafely(text: string): Promise<void> {
  try {
    await sendSelfMessage(text);
  } catch (err) {
    console.error("[router] could not send WhatsApp message", err);
  }
}

// Diagnostic only (e.g. to find a capture the LLM misread as a query).
async function recordOutcome(waMessageId: string, outcome: string): Promise<void> {
  await db.processedMessage
    .update({ where: { whatsappMessageId: waMessageId }, data: { outcome } })
    .catch((err) => console.error("[router] could not record message outcome", err));
}

// persistClassifiedNote is transactional (a failed Expense/Reminder write
// rolls its Note back), so on failure nothing was written and the message
// can still be saved as a plain no_identificado Note — visible in
// Sin clasificar for manual correction instead of lost.
async function persistWithFallback(
  result: ClassificationResult,
  rawText: string,
  source: "text" | "audio",
  waMessageId: string
): Promise<void> {
  try {
    await persistClassifiedNote(result, rawText, source, waMessageId);
  } catch (err) {
    if (result.noteType === "no_identificado") throw err;
    console.error("[router] persisting the classified note failed, saving it as no_identificado", err);
    await persistClassifiedNote(NO_IDENTIFICADO, rawText, source, waMessageId);
  }
}

async function classifyAndHandle(
  text: string,
  source: "text" | "audio",
  waMessageId: string
): Promise<string> {
  const nowIso = new Date().toISOString();
  const result = await classifyMessage(text, nowIso);

  if (result.intent === "query") {
    // Known limitation: if the LLM misreads a capture as a question,
    // nothing is persisted as a Note — only answered. That's inherent LLM
    // unreliability, not something code can detect; the ProcessedMessage
    // row's outcome="query" at least makes it diagnosable afterwards.
    const answer = await answerQuery(text, nowIso);
    try {
      await sendSelfMessage(answer);
    } catch (err) {
      // An answer that can't be delivered would leave the message with no
      // effect at all — save the question instead so it isn't lost.
      console.error("[router] could not send the query answer, saving the question as a note", err);
      await persistClassifiedNote(NO_IDENTIFICADO, text, source, waMessageId);
      return "query_unsent";
    }
    return "query";
  }

  if (result.intent === "delete") {
    const outcome = await requestDelete(text);
    return `delete_${outcome}`;
  }

  if (result.intent === "pago_cuota") {
    const outcome = await requestCuotaPayment(text, result.amountCents);
    return `pago_cuota_${outcome}`;
  }

  if (result.intent === "retiro_ahorro") {
    // Never asks for clarification and never creates a pending row (unlike
    // pago_cuota/factibilidad_compra's disambiguation flows) — this intent
    // always resolves immediately, so it doesn't participate in the 4-way
    // Reminder/PendingDeletion/PendingCuotaPayment/PendingPurchaseSimulation
    // invariant above in handleIncomingMessage.
    const { withdrawnCents } = await withdrawSavings(result.amountCents ?? null);
    await sendSelfMessageSafely(
      `Listo, registré un retiro de ${formatCents(withdrawnCents, config.defaultCurrency, config.locale)} de tu ahorro.`
    );
    return "retiro_ahorro";
  }

  if (result.intent === "factibilidad_compra") {
    const outcome = await requestPurchaseFeasibility(text);
    return `factibilidad_compra_${outcome}`;
  }

  if (result.intent === "proyeccion_ahorro") {
    // Never asks for clarification and never creates a pending row (unlike
    // factibilidad_compra's disambiguation flow) — "el mes que viene" is
    // always the default, so this intent always resolves immediately and
    // doesn't participate in the 4-way pending invariant, same as
    // retiro_ahorro above. The whole branch is wrapped in try/catch (not
    // just the WhatsApp send) so a Groq failure in either call never
    // escapes uncaught.
    try {
      const targetYearMonth = addMonthsToYearMonth(toArgentinaDateString(new Date(nowIso)).slice(0, 7), 1);
      const projection = await projectMonthlySavingsCapacity(targetYearMonth, nowIso);
      const answer =
        projection === "no_history"
          ? NO_HISTORY_SAVINGS_MESSAGE
          : await composeSavingsProjectionAnswer(text, targetYearMonth, projection);
      await sendSelfMessageSafely(answer);
    } catch (err) {
      console.error("[router] could not compute/compose the savings projection answer", err);
      await sendSelfMessageSafely(SAVINGS_PROJECTION_FAILURE_MESSAGE);
    }
    return "proyeccion_ahorro";
  }

  await persistWithFallback(result, text, source, waMessageId);
  return "capture";
}

export async function handleIncomingMessage(
  text: string | null,
  waMessageId: string,
  source: "text" | "audio" | "image",
  mediaBuffer?: Buffer
): Promise<void> {
  if (!(await claimMessage(waMessageId))) return;

  // Notes written before the ProcessedMessage ledger existed have no row
  // there; Note.whatsappMessageId (@unique) still identifies them.
  const existing = await db.note.findUnique({ where: { whatsappMessageId: waMessageId } });
  if (existing) {
    await recordOutcome(waMessageId, "duplicate");
    return;
  }

  // Images never produce text to classify, so this branch must stay ahead
  // of the audio/text effectiveText derivation below.
  if (source === "image") {
    if (!mediaBuffer) {
      // No buffer at all (connection.ts couldn't download the image):
      // nothing to send to Groq. Same criterion as the audio-no-buffer case
      // below for persistence (saved as no_identificado instead of lost),
      // but unlike audio this is a technical-failure case the feature's own
      // anti-goal explicitly covers ("ninguna foto se pierde en silencio"):
      // every other failure path in this feature (unreadable/failed/
      // blocked) always ends in a visible chat message too, so this one
      // reuses receiptConfirmationFlow.ts's own "failed" message — same
      // single source of truth, never a second copy of that string.
      await persistClassifiedNote(NO_IDENTIFICADO, UNDOWNLOADED_RECEIPT_IMAGE_TEXT, source, waMessageId);
      await sendSelfMessageSafely(RECEIPT_FAILED_MESSAGE);
      await recordOutcome(waMessageId, "receipt_failed");
      return;
    }
    const outcome = await handleReceiptImage(mediaBuffer, waMessageId, new Date().toISOString());
    await recordOutcome(waMessageId, `receipt_${outcome}`);
    return;
  }

  // No buffer at all (connection.ts couldn't download the audio) is
  // treated exactly like a failed transcription.
  let effectiveText: string | null;
  if (source === "audio") effectiveText = mediaBuffer ? await transcribeAudio(mediaBuffer) : null;
  else effectiveText = text;

  if (effectiveText === null || effectiveText.trim() === "") {
    await persistClassifiedNote(
      NO_IDENTIFICADO,
      source === "audio" ? UNTRANSCRIBABLE_AUDIO_TEXT : (text ?? ""),
      source,
      waMessageId
    );
    await recordOutcome(waMessageId, "capture_placeholder");
    return;
  }

  // A reminder awaiting confirmation gets first look: a yes/no is its
  // answer. Anything else is NOT an answer — it's a new message that
  // happened to arrive while the prompt was open, so it goes through normal
  // classification below, and the prompt is re-sent afterwards.
  let repromptAfter = false;
  const pendingReminder = await db.reminder.findFirst({
    where: { status: { in: ["awaiting_confirmation", "confirming"] } },
  });
  if (pendingReminder) {
    const outcome = await handleConfirmationReply(effectiveText);
    if (outcome !== "unrecognized" && outcome !== "no_pending") {
      await recordOutcome(waMessageId, `confirmation_${outcome}`);
      return;
    }
    // "no_pending": the reminder got resolved between the check above and
    // the reply handler (by a concurrent reply). A yes/no was a redundant
    // reply to it — nothing to do; anything else is just classified (no
    // open prompt left to repeat).
    if (outcome === "no_pending" && isConfirmationReplyText(effectiveText)) {
      await recordOutcome(waMessageId, "confirmation_already_resolved");
      return;
    }
    repromptAfter = outcome === "unrecognized";
  }

  // Mirrors the pendingReminder block above, for an open delete
  // confirmation/disambiguation (deleteFlow.ts) instead of a reminder's
  // yes/no. The four invariants (this one, pendingReminder,
  // pendingCuotaPayment, and pendingPurchaseSimulation below) never overlap
  // (requestDelete/requestCuotaPayment/requestPurchaseFeasibility refuse to
  // open their own pending row while another of the four is open, and vice
  // versa), so at most one of these four blocks ever actually has something
  // to do — their relative order here doesn't matter.
  let repromptDeleteAfter = false;
  const pendingDeletion = await db.pendingDeletion.findFirst();
  if (pendingDeletion) {
    const outcome = await handleDeleteReply(effectiveText);
    if (outcome !== "unrecognized" && outcome !== "no_pending") {
      await recordOutcome(waMessageId, `delete_${outcome}`);
      return;
    }
    repromptDeleteAfter = outcome === "unrecognized";
  }

  // Mirrors the pendingDeletion block above, for an open cuota-payment
  // disambiguation (cuotaPaymentFlow.ts) instead of a delete
  // confirmation/disambiguation.
  let repromptCuotaPaymentAfter = false;
  const pendingCuotaPayment = await db.pendingCuotaPayment.findFirst();
  if (pendingCuotaPayment) {
    const outcome = await handleCuotaPaymentReply(effectiveText);
    if (outcome !== "unrecognized" && outcome !== "no_pending") {
      await recordOutcome(waMessageId, `pago_cuota_${outcome}`);
      return;
    }
    repromptCuotaPaymentAfter = outcome === "unrecognized";
  }

  // Mirrors the pendingCuotaPayment block above, for an open purchase-
  // feasibility clarification (purchaseFeasibilityFlow.ts) instead of a
  // cuota-payment disambiguation. Its outcome set also includes
  // "cancelled" (a bare "no" cancels the whole purchase-feasibility
  // request) — that outcome is just as terminal/already-handled as
  // "answered"/"asked_clarify", so it returns early here too.
  let repromptPurchaseFeasibilityAfter = false;
  const pendingPurchaseSimulation = await db.pendingPurchaseSimulation.findFirst();
  if (pendingPurchaseSimulation) {
    const outcome = await handlePurchaseFeasibilityReply(effectiveText);
    if (outcome !== "unrecognized" && outcome !== "no_pending") {
      await recordOutcome(waMessageId, `factibilidad_compra_${outcome}`);
      return;
    }
    repromptPurchaseFeasibilityAfter = outcome === "unrecognized";
  }

  // Mirrors the pendingPurchaseSimulation block above, for an open receipt
  // (ticket photo) confirmation (receiptConfirmationFlow.ts) instead of a
  // purchase-feasibility clarification — fifth and last member of the "at
  // most one pending confirmation of any kind" family.
  let repromptReceiptAfter = false;
  const pendingReceiptConfirmation = await db.pendingReceiptConfirmation.findFirst();
  if (pendingReceiptConfirmation) {
    const outcome = await handleReceiptConfirmationReply(effectiveText);
    if (outcome !== "unrecognized" && outcome !== "no_pending") {
      await recordOutcome(waMessageId, `receipt_confirmation_${outcome}`);
      return;
    }
    repromptReceiptAfter = outcome === "unrecognized";
  }

  try {
    const outcome = await classifyAndHandle(effectiveText, source, waMessageId);
    await recordOutcome(waMessageId, outcome);
  } finally {
    // After the message itself was handled, so a failing re-prompt can
    // never cost the message. None of the resend helpers ever throw.
    if (repromptAfter) await resendPendingPrompt();
    if (repromptDeleteAfter) await resendPendingDeletePrompt();
    if (repromptCuotaPaymentAfter) await resendPendingCuotaPaymentPrompt();
    if (repromptPurchaseFeasibilityAfter) await resendPendingPurchaseFeasibilityPrompt();
    if (repromptReceiptAfter) await resendPendingReceiptPrompt();
  }
}
