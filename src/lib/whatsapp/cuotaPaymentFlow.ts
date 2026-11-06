// Cuota-payment confirmation/disambiguation queue: the state machine
// between a natural-language payment request by WhatsApp ("pagué el
// gimnasio", "pagué la tarjeta mastercard, 85000") and an actual
// Note+Expense+RecurringPayment (payItem/payGroup, src/lib/cuotas.ts).
// Mirrors deleteFlow.ts's exact skeleton, with one structural difference: a
// single match is NOT a "confirm with sí/no" stage — it pays directly,
// since by design a one-candidate payment request needs no confirmation.
// Only an AMBIGUOUS match (more than one candidate) ever creates a pending
// row and waits for a reply.
//
// Concurrency/invariant: at most one of {a Reminder row
// awaiting_confirmation/confirming, a PendingDeletion row, a
// PendingCuotaPayment row} exists at a time (the "3-way" invariant —
// reminders.ts's claimNextQueuedReminder and deleteFlow.ts's
// insertPendingDeletionIfNoReminderPending both already guard against this
// row too). requestCuotaPayment refuses to create a
// PendingCuotaPayment while a Reminder is pending OR a PendingDeletion is
// open, and the atomic insert below additionally guards against a second
// PendingCuotaPayment (the schema's own "a lo sumo una fila a la vez").
import { randomUUID } from "node:crypto";
import type { RecurringGroup, RecurringItem } from "@prisma/client";
import db from "../db";
import { payGroup, payItem } from "../cuotas";
import { toArgentinaDateString } from "../timezone";
import { findCuotaCandidates, type CuotaCandidate } from "./cuotaMatch";
import { classifyYesNo, promptNextIfIdle, quoteNoteText } from "./reminders";
import { sendSelfMessage } from "./connection";

// JSON-encoded shape stored in PendingCuotaPayment.candidates (schema
// comment) — a lightweight reference (kind + id) rather than the
// full CuotaCandidate (which, for "group", also carries its member items —
// those are re-derived from the DB when needed, not snapshotted here).
type CuotaCandidateRef = { kind: "item"; id: string } | { kind: "group"; id: string };

// Sends a self-chat message without ever throwing: used for notices whose
// failure must not abort the state transition that triggered them (same
// discipline as deleteFlow.ts's sendSelfMessageSafely).
async function sendSelfMessageSafely(text: string): Promise<void> {
  try {
    await sendSelfMessage(text);
  } catch (err) {
    console.error("[cuotaPaymentFlow] could not send WhatsApp message", err);
  }
}

function candidateName(candidate: CuotaCandidate): string {
  return candidate.kind === "item" ? candidate.item.name : candidate.group.name;
}

function quotedCandidateName(candidate: CuotaCandidate): string {
  return quoteNoteText(candidateName(candidate));
}

function toCandidateRef(candidate: CuotaCandidate): CuotaCandidateRef {
  return candidate.kind === "item"
    ? { kind: "item", id: candidate.item.id }
    : { kind: "group", id: candidate.group.id };
}

async function resolveCandidateRef(ref: CuotaCandidateRef): Promise<CuotaCandidate | null> {
  if (ref.kind === "item") {
    const item: RecurringItem | null = await db.recurringItem.findUnique({ where: { id: ref.id } });
    return item ? { kind: "item", item } : null;
  }
  const group: RecurringGroup | null = await db.recurringGroup.findUnique({ where: { id: ref.id } });
  // The group's own member items aren't needed here (payGroup re-derives
  // its payable set from the DB), only its name — for messages.
  return group ? { kind: "group", group, items: [] } : null;
}

async function resolveCandidateRefs(refs: CuotaCandidateRef[]): Promise<CuotaCandidate[]> {
  const resolved = await Promise.all(refs.map((ref) => resolveCandidateRef(ref)));
  return resolved.filter((c): c is CuotaCandidate => c !== null);
}

function disambiguationPromptFor(candidates: CuotaCandidate[]): string {
  const lines = candidates.map((c, i) => `${i + 1}. "${quotedCandidateName(c)}"`);
  return `${lines.join("\n")}\nRespondé con el número (o 'ninguna').`;
}

async function currentYearMonth(): Promise<string> {
  return toArgentinaDateString(new Date()).slice(0, 7);
}

// Pays the resolved candidate via the shared payItem/payGroup helpers
// (src/lib/cuotas.ts), returning a human message for either
// outcome. The error strings ("not_active"/"already_paid"/"not_found"/
// "nothing_to_pay") are only reachable via a race against findCuotaCandidates
// having filtered to active+unpaid moments earlier — handled gracefully,
// never thrown.
async function payCandidateAndDescribe(
  candidate: CuotaCandidate,
  overrideAmountCents: number | null
): Promise<string> {
  const result =
    candidate.kind === "item"
      ? await payItem(candidate.item.id, overrideAmountCents)
      : await payGroup(candidate.group.id, overrideAmountCents);

  if (typeof result === "string") {
    return `No pude registrar el pago de "${quotedCandidateName(candidate)}" (ya estaba pagada o ya no está disponible).`;
  }

  return `Listo, marqué "${quotedCandidateName(candidate)}" como pagada.`;
}

const BLOCKED_PENDING_REMINDER_MESSAGE =
  "Tenés un recordatorio pendiente de confirmar — respondé sí/no antes de pedir el pago de una cuota.";

const BLOCKED_PENDING_DELETION_MESSAGE =
  "Tenés un borrado pendiente de confirmar — respondé esa confirmación antes de pedir el pago de una cuota.";

const BLOCKED_PENDING_CUOTA_PAYMENT_MESSAGE =
  "Ya tenés un pago de cuota pendiente de elegir — respondé esa confirmación (un número, o 'ninguna') antes de pedir otro pago.";

// Duplicated (not imported from purchaseFeasibilityFlow.ts, which
// didn't exist yet when this was written) — same accepted duplication
// pattern as BLOCKED_PENDING_REMINDER_MESSAGE/BLOCKED_PENDING_DELETION_MESSAGE/
// BLOCKED_PENDING_CUOTA_PAYMENT_MESSAGE already between this file and
// deleteFlow.ts.
const BLOCKED_PENDING_PURCHASE_SIMULATION_MESSAGE =
  "Tenés una consulta de factibilidad de compra pendiente de responder — contestá eso antes de pedir el pago de una cuota.";

// Duplicated (not imported from receiptConfirmationFlow.ts) —
// same accepted duplication pattern as the other
// BLOCKED_PENDING_*_MESSAGE constants already between this file and
// deleteFlow.ts/purchaseFeasibilityFlow.ts.
const BLOCKED_PENDING_RECEIPT_CONFIRMATION_MESSAGE =
  "Tenés un ticket pendiente de confirmar — respondé esa confirmación (sí/no) antes de pedir el pago de una cuota.";

// Inserts the PendingCuotaPayment row only if no Reminder is currently
// awaiting_confirmation/confirming AND no PendingDeletion row exists AND no
// PendingCuotaPayment row already exists AND no PendingPurchaseSimulation
// row exists (purchaseFeasibilityFlow.ts) AND no
// PendingReceiptConfirmation row exists (receiptConfirmationFlow.ts) — in the SAME statement that checks all five
// conditions, mirroring insertPendingDeletionIfNoReminderPending's own
// pattern (deleteFlow.ts). SQLite serializes writers, so there is no gap
// between the check and the write for a concurrent enqueueReminder, a
// concurrent requestDelete, a concurrent purchase-feasibility question, a
// concurrent receipt confirmation, OR a second requestCuotaPayment call to
// land in. Returns false (and writes nothing) when a Reminder, an existing
// PendingDeletion, an existing PendingCuotaPayment, an existing
// PendingPurchaseSimulation, or an existing PendingReceiptConfirmation won
// the race.
async function insertPendingCuotaPaymentIfNothingElsePending(
  candidates: CuotaCandidateRef[],
  overrideAmountCents: number | null
): Promise<boolean> {
  const id = randomUUID();
  const encodedCandidates = JSON.stringify(candidates);
  const insertedCount = await db.$executeRaw`
    INSERT INTO "PendingCuotaPayment" ("id", "candidates", "overrideAmountCents")
    SELECT ${id}, ${encodedCandidates}, ${overrideAmountCents}
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

export type CuotaPaymentRequestOutcome =
  | "paid"
  | "asked_disambiguate"
  | "none_found"
  | "blocked_pending";

export async function requestCuotaPayment(
  requestText: string,
  statedAmountCents?: number
): Promise<CuotaPaymentRequestOutcome> {
  // Same shared "one pending confirmation of any kind" slot as
  // requestDelete — checked upfront for ALL THREE of a pending Reminder, an
  // open PendingDeletion, AND an already-open PendingCuotaPayment, not just
  // the first of those: unlike requestDelete (which always creates a row,
  // for either its "confirming" or "disambiguating" stage, so the atomic
  // insert alone suffices as its safety net), a single-candidate payment
  // request here pays directly and creates NO row at all — so the atomic
  // insert's own guard (below, for the ambiguous path only) is never
  // reached on that path, and this upfront check is the only thing that
  // can block it. Without the PendingCuotaPayment leg here, a SECOND
  // "pagué X" request that happens to resolve to a single candidate would
  // pay directly while an earlier disambiguation is still open — the same
  // inconsistency the atomic insert's own guard exists to prevent for the
  // ambiguous path.
  const pendingReminder = await db.reminder.findFirst({
    where: { status: { in: ["awaiting_confirmation", "confirming"] } },
  });
  if (pendingReminder) {
    await sendSelfMessageSafely(BLOCKED_PENDING_REMINDER_MESSAGE);
    return "blocked_pending";
  }

  const pendingDeletion = await db.pendingDeletion.findFirst();
  if (pendingDeletion) {
    await sendSelfMessageSafely(BLOCKED_PENDING_DELETION_MESSAGE);
    return "blocked_pending";
  }

  const pendingCuotaPayment = await db.pendingCuotaPayment.findFirst();
  if (pendingCuotaPayment) {
    await sendSelfMessageSafely(BLOCKED_PENDING_CUOTA_PAYMENT_MESSAGE);
    return "blocked_pending";
  }

  const pendingPurchaseSimulation = await db.pendingPurchaseSimulation.findFirst();
  if (pendingPurchaseSimulation) {
    await sendSelfMessageSafely(BLOCKED_PENDING_PURCHASE_SIMULATION_MESSAGE);
    return "blocked_pending";
  }

  // Same upfront discipline as the other three checks above, for an open
  // receipt (ticket photo) confirmation (receiptConfirmationFlow.ts) —
  // fifth member of the "one pending confirmation of
  // any kind" family.
  const pendingReceiptConfirmation = await db.pendingReceiptConfirmation.findFirst();
  if (pendingReceiptConfirmation) {
    await sendSelfMessageSafely(BLOCKED_PENDING_RECEIPT_CONFIRMATION_MESSAGE);
    return "blocked_pending";
  }

  const yearMonth = await currentYearMonth();
  const match = await findCuotaCandidates(requestText, yearMonth);

  if (match.kind === "none") {
    await sendSelfMessageSafely("No encontré ninguna cuota que coincida con eso.");
    return "none_found";
  }

  if (match.kind === "single") {
    const message = await payCandidateAndDescribe(match.candidate, statedAmountCents ?? null);
    await sendSelfMessageSafely(message);
    return "paid";
  }

  // match.kind === "ambiguous"
  const refs = match.candidates.map(toCandidateRef);

  // The actual safety net for the ambiguous path: a Reminder promoted, a
  // PendingDeletion created, or a second ambiguous payment request's own
  // PendingCuotaPayment, anywhere between the checks above and this very
  // statement (findCuotaCandidates's own await is itself a yield point) is
  // caught here, atomically, and this PendingCuotaPayment is never created.
  const inserted = await insertPendingCuotaPaymentIfNothingElsePending(
    refs,
    statedAmountCents ?? null
  );
  if (!inserted) {
    // Best-effort read, purely to choose the right message — same
    // discipline as requestDelete's own post-insert-failure branch: the
    // atomicity that matters already happened in the insert above. FIVE
    // reasons the insert's guard can have failed (Reminder won the race, a
    // PendingDeletion was created, another PendingCuotaPayment already
    // existed/won the race — the insert's own self-check),
    // a PendingPurchaseSimulation is open (purchaseFeasibilityFlow.ts),
    // or a PendingReceiptConfirmation is open
    // (receiptConfirmationFlow.ts)), so all five are
    // checked here, in the same priority order as the upfront guard above.
    const stillPendingReminder = await db.reminder.findFirst({
      where: { status: { in: ["awaiting_confirmation", "confirming"] } },
    });
    if (stillPendingReminder) {
      await sendSelfMessageSafely(BLOCKED_PENDING_REMINDER_MESSAGE);
      return "blocked_pending";
    }
    const stillPendingDeletion = await db.pendingDeletion.findFirst();
    if (stillPendingDeletion) {
      await sendSelfMessageSafely(BLOCKED_PENDING_DELETION_MESSAGE);
      return "blocked_pending";
    }
    const stillPendingCuotaPayment = await db.pendingCuotaPayment.findFirst();
    if (stillPendingCuotaPayment) {
      await sendSelfMessageSafely(BLOCKED_PENDING_CUOTA_PAYMENT_MESSAGE);
      return "blocked_pending";
    }
    const stillPendingReceiptConfirmation = await db.pendingReceiptConfirmation.findFirst();
    if (stillPendingReceiptConfirmation) {
      await sendSelfMessageSafely(BLOCKED_PENDING_RECEIPT_CONFIRMATION_MESSAGE);
      return "blocked_pending";
    }
    await sendSelfMessageSafely(BLOCKED_PENDING_PURCHASE_SIMULATION_MESSAGE);
    return "blocked_pending";
  }

  await sendSelfMessageSafely(disambiguationPromptFor(match.candidates));
  return "asked_disambiguate";
}

export type CuotaPaymentReplyOutcome = "disambiguated" | "rejected" | "no_pending" | "unrecognized";

export async function handleCuotaPaymentReply(replyText: string): Promise<CuotaPaymentReplyOutcome> {
  const pending = await db.pendingCuotaPayment.findFirst();
  if (!pending) return "no_pending";

  const refs: CuotaCandidateRef[] = JSON.parse(pending.candidates);

  const trimmed = replyText.trim();
  const isNone = trimmed.toLowerCase() === "ninguna" || classifyYesNo(replyText) === "reject";
  if (isNone) {
    await db.pendingCuotaPayment.delete({ where: { id: pending.id } });
    // The slot is free again — a Reminder or PendingDeletion queued behind
    // it can now be promoted/created. Never throws.
    await promptNextIfIdle();
    await sendSelfMessageSafely("Dale, no pago nada.");
    return "rejected";
  }

  const index = Number.parseInt(trimmed, 10);
  const isValidNumber = /^\d+$/.test(trimmed) && index >= 1 && index <= refs.length;
  if (!isValidNumber) return "unrecognized";

  const chosenRef = refs[index - 1]!;
  const candidate = await resolveCandidateRef(chosenRef);

  await db.pendingCuotaPayment.delete({ where: { id: pending.id } });
  await promptNextIfIdle();

  if (!candidate) {
    await sendSelfMessageSafely("No pude registrar ese pago (ya no está disponible).");
    return "disambiguated";
  }

  const message = await payCandidateAndDescribe(candidate, pending.overrideAmountCents);
  await sendSelfMessageSafely(message);
  return "disambiguated";
}

// Re-sends the disambiguation list for whatever PendingCuotaPayment is
// currently open. Never throws (same style as resendPendingDeletePrompt in
// deleteFlow.ts).
export async function resendPendingCuotaPaymentPrompt(): Promise<void> {
  try {
    const pending = await db.pendingCuotaPayment.findFirst();
    if (!pending) return;

    const refs: CuotaCandidateRef[] = JSON.parse(pending.candidates);
    const candidates = await resolveCandidateRefs(refs);
    await sendSelfMessageSafely(disambiguationPromptFor(candidates));
  } catch (err) {
    console.error("[cuotaPaymentFlow] resendPendingCuotaPaymentPrompt failed", err);
  }
}
