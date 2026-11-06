import { randomUUID } from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";
import db from "../db";
import { addMonthsToYearMonth } from "../cuotas";
import { toArgentinaDateString } from "../timezone";
import { NO_HISTORY_MESSAGE, NO_HISTORY_SAVINGS_MESSAGE } from "./purchaseFeasibility";
import { FAILED_MESSAGE as RECEIPT_FAILED_MESSAGE } from "./receiptConfirmationFlow";

const mockTranscribeAudio = vi.hoisted(() => vi.fn());
const mockClassifyMessage = vi.hoisted(() => vi.fn());
const mockSendSelfMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockAnswerQuery = vi.hoisted(() => vi.fn());
const mockHandleConfirmationReply = vi.hoisted(() => vi.fn().mockResolvedValue("no_pending"));
const mockResendPendingPrompt = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRequestDelete = vi.hoisted(() => vi.fn().mockResolvedValue("none_found"));
const mockHandleDeleteReply = vi.hoisted(() => vi.fn().mockResolvedValue("no_pending"));
const mockResendPendingDeletePrompt = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRequestCuotaPayment = vi.hoisted(() => vi.fn().mockResolvedValue("none_found"));
const mockHandleCuotaPaymentReply = vi.hoisted(() => vi.fn().mockResolvedValue("no_pending"));
const mockResendPendingCuotaPaymentPrompt = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRequestPurchaseFeasibility = vi.hoisted(() => vi.fn().mockResolvedValue("blocked_pending"));
const mockHandlePurchaseFeasibilityReply = vi.hoisted(() => vi.fn().mockResolvedValue("no_pending"));
const mockResendPendingPurchaseFeasibilityPrompt = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockHandleReceiptImage = vi.hoisted(() => vi.fn().mockResolvedValue("auto_logged"));
const mockHandleReceiptConfirmationReply = vi.hoisted(() => vi.fn().mockResolvedValue("no_pending"));
const mockResendPendingReceiptPrompt = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockWithdrawSavings = vi.hoisted(() => vi.fn().mockResolvedValue({ withdrawnCents: 0 }));
const mockProjectMonthlySavingsCapacity = vi.hoisted(() => vi.fn());
const mockComposeSavingsProjectionAnswer = vi.hoisted(() => vi.fn());
// persist.ts (used for real by these tests) also imports from this same
// module — the pure reminderRowData stays real, the side-effecting
// promptNextIfIdle is stubbed.
const mockPromptNextIfIdle = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("./transcribe", () => ({ transcribeAudio: mockTranscribeAudio }));
vi.mock("./classify", () => ({ classifyMessage: mockClassifyMessage }));
vi.mock("./connection", () => ({ sendSelfMessage: mockSendSelfMessage }));
vi.mock("./query", () => ({ answerQuery: mockAnswerQuery }));
vi.mock("./reminders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reminders")>()),
  handleConfirmationReply: mockHandleConfirmationReply,
  resendPendingPrompt: mockResendPendingPrompt,
  promptNextIfIdle: mockPromptNextIfIdle,
}));
vi.mock("./deleteFlow", () => ({
  requestDelete: mockRequestDelete,
  handleDeleteReply: mockHandleDeleteReply,
  resendPendingDeletePrompt: mockResendPendingDeletePrompt,
}));
vi.mock("./cuotaPaymentFlow", () => ({
  requestCuotaPayment: mockRequestCuotaPayment,
  handleCuotaPaymentReply: mockHandleCuotaPaymentReply,
  resendPendingCuotaPaymentPrompt: mockResendPendingCuotaPaymentPrompt,
}));
vi.mock("./purchaseFeasibilityFlow", () => ({
  requestPurchaseFeasibility: mockRequestPurchaseFeasibility,
  handlePurchaseFeasibilityReply: mockHandlePurchaseFeasibilityReply,
  resendPendingPurchaseFeasibilityPrompt: mockResendPendingPurchaseFeasibilityPrompt,
}));
vi.mock("./receiptConfirmationFlow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./receiptConfirmationFlow")>()),
  handleReceiptImage: mockHandleReceiptImage,
  handleReceiptConfirmationReply: mockHandleReceiptConfirmationReply,
  resendPendingReceiptPrompt: mockResendPendingReceiptPrompt,
}));
vi.mock("./savingsWithdrawal", () => ({ withdrawSavings: mockWithdrawSavings }));
vi.mock("./purchaseFeasibility", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./purchaseFeasibility")>()),
  projectMonthlySavingsCapacity: mockProjectMonthlySavingsCapacity,
  composeSavingsProjectionAnswer: mockComposeSavingsProjectionAnswer,
}));

import { handleIncomingMessage } from "./router";

function mockTranscribeAudioToReturn(text: string | null) {
  mockTranscribeAudio.mockResolvedValueOnce(text);
}

async function seedAwaitingConfirmationReminder() {
  const note = await db.note.create({
    data: {
      rawText: "turno con el dentista",
      source: "text",
      type: "recordatorio",
      whatsappMessageId: randomUUID(),
    },
  });
  return db.reminder.create({
    data: {
      noteId: note.id,
      parsedDatetime: new Date("2026-10-31T15:00:00Z"),
      status: "awaiting_confirmation",
      calendarEventId: null,
    },
  });
}

// Expense/Reminder both have a required FK to Note, so clear them first —
// same pattern as the other whatsapp/* and api/* tests.
beforeEach(async () => {
  await db.processedMessage.deleteMany();
  await db.expense.deleteMany();
  await db.pendingDeletion.deleteMany();
  await db.pendingCuotaPayment.deleteMany();
  await db.pendingPurchaseSimulation.deleteMany();
  await db.pendingReceiptConfirmation.deleteMany();
  await db.reminder.deleteMany();
  await db.note.deleteMany();
  mockTranscribeAudio.mockReset();
  mockClassifyMessage.mockReset();
  mockSendSelfMessage.mockReset().mockResolvedValue(undefined);
  mockAnswerQuery.mockReset();
  mockHandleConfirmationReply.mockReset().mockResolvedValue("no_pending");
  mockResendPendingPrompt.mockReset().mockResolvedValue(undefined);
  mockPromptNextIfIdle.mockReset().mockResolvedValue(undefined);
  mockRequestDelete.mockReset().mockResolvedValue("none_found");
  mockHandleDeleteReply.mockReset().mockResolvedValue("no_pending");
  mockResendPendingDeletePrompt.mockReset().mockResolvedValue(undefined);
  mockRequestCuotaPayment.mockReset().mockResolvedValue("none_found");
  mockHandleCuotaPaymentReply.mockReset().mockResolvedValue("no_pending");
  mockResendPendingCuotaPaymentPrompt.mockReset().mockResolvedValue(undefined);
  mockRequestPurchaseFeasibility.mockReset().mockResolvedValue("blocked_pending");
  mockHandlePurchaseFeasibilityReply.mockReset().mockResolvedValue("no_pending");
  mockResendPendingPurchaseFeasibilityPrompt.mockReset().mockResolvedValue(undefined);
  mockHandleReceiptImage.mockReset().mockResolvedValue("auto_logged");
  mockHandleReceiptConfirmationReply.mockReset().mockResolvedValue("no_pending");
  mockResendPendingReceiptPrompt.mockReset().mockResolvedValue(undefined);
  mockWithdrawSavings.mockReset().mockResolvedValue({ withdrawnCents: 0 });
  mockProjectMonthlySavingsCapacity.mockReset();
  mockComposeSavingsProjectionAnswer.mockReset();
});

async function seedPendingDeletion(noteId: string, stage: "confirming" | "disambiguating" = "confirming") {
  return db.pendingDeletion.create({ data: { stage, noteIds: JSON.stringify([noteId]) } });
}

async function seedPendingCuotaPayment() {
  return db.pendingCuotaPayment.create({
    data: { candidates: JSON.stringify([{ kind: "item", id: "some-item-id" }]), overrideAmountCents: null },
  });
}

async function seedPendingPurchaseSimulation() {
  return db.pendingPurchaseSimulation.create({
    data: { conversationText: "¿me conviene comprar una heladera de 800000?", missingField: "mode" },
  });
}

async function seedPendingReceiptConfirmation() {
  return db.pendingReceiptConfirmation.create({
    data: { amountCents: 150000, category: "Mercado", occurredAt: new Date("2026-11-04T12:00:00Z") },
  });
}

test("handleIncomingMessage stores a no_identificado note when audio transcription fails, and never processes the same waMessageId twice", async () => {
  mockTranscribeAudioToReturn(null);

  await handleIncomingMessage(null, "wa-999", "audio", Buffer.from("corrupt audio"));
  await handleIncomingMessage(null, "wa-999", "audio", Buffer.from("corrupt audio"));

  const notes = await db.note.findMany({ where: { whatsappMessageId: "wa-999" } });
  expect(notes).toHaveLength(1);
  expect(notes[0]!.type).toBe("no_identificado");
  // A failed transcription skips classification entirely, per the brief.
  expect(mockClassifyMessage).not.toHaveBeenCalled();
  // transcribeAudio itself must only run once too (second call is a no-op
  // short-circuited by the already-processed check).
  expect(mockTranscribeAudio).toHaveBeenCalledTimes(1);
});

test("handleIncomingMessage classifies successfully transcribed audio and persists it", async () => {
  mockTranscribeAudioToReturn("compré café, 3000 pesos");
  mockClassifyMessage.mockResolvedValueOnce({
    intent: "capture",
    noteType: "gasto",
    amountCents: 300000,
    category: "comida",
  });

  await handleIncomingMessage(null, "wa-audio-ok", "audio", Buffer.from("fake audio"));

  expect(mockClassifyMessage).toHaveBeenCalledWith("compré café, 3000 pesos", expect.any(String));
  const note = await db.note.findUnique({
    where: { whatsappMessageId: "wa-audio-ok" },
    include: { expense: true },
  });
  expect(note?.type).toBe("gasto");
  expect(note?.source).toBe("audio");
  expect(note?.rawText).toBe("compré café, 3000 pesos");
  expect(note?.expense?.amountCents).toBe(300000);
});

test("handleIncomingMessage classifies a text message directly, without calling transcribeAudio", async () => {
  mockClassifyMessage.mockResolvedValueOnce({ intent: "capture", noteType: "idea" });

  await handleIncomingMessage("una idea genial", "wa-text-1", "text");

  expect(mockTranscribeAudio).not.toHaveBeenCalled();
  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-text-1" } });
  expect(note?.type).toBe("idea");
  expect(note?.source).toBe("text");
});

test("handleIncomingMessage answers a query via sendSelfMessage instead of persisting a Note", async () => {
  mockClassifyMessage.mockResolvedValueOnce({ intent: "query" });
  mockAnswerQuery.mockResolvedValueOnce("Gastaste $3.200 en comida esta semana.");

  await handleIncomingMessage("¿cuánto gasté esta semana?", "wa-query-1", "text");

  expect(mockAnswerQuery).toHaveBeenCalledWith("¿cuánto gasté esta semana?", expect.any(String));
  expect(mockSendSelfMessage).toHaveBeenCalledWith("Gastaste $3.200 en comida esta semana.");
  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-query-1" } });
  expect(note).toBeNull();
});

test("handleIncomingMessage never classifies the same waMessageId twice for a text message", async () => {
  mockClassifyMessage.mockResolvedValue({ intent: "capture", noteType: "idea" });

  await handleIncomingMessage("una idea", "wa-dup", "text");
  await handleIncomingMessage("una idea", "wa-dup", "text");

  expect(mockClassifyMessage).toHaveBeenCalledTimes(1);
  const notes = await db.note.findMany({ where: { whatsappMessageId: "wa-dup" } });
  expect(notes).toHaveLength(1);
});

test("handleIncomingMessage routes a text reply to handleConfirmationReply (not classifyMessage) when a reminder is awaiting_confirmation", async () => {
  await seedAwaitingConfirmationReminder();
  mockHandleConfirmationReply.mockResolvedValueOnce("confirmed");

  await handleIncomingMessage("sí", "wa-confirm-1", "text");

  expect(mockHandleConfirmationReply).toHaveBeenCalledWith("sí");
  expect(mockClassifyMessage).not.toHaveBeenCalled();
  // The reply itself is never persisted as its own Note — it's an answer
  // to the pending reminder's prompt, not a new note to classify.
  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-confirm-1" } });
  expect(note).toBeNull();
});

test("handleIncomingMessage routes a transcribed audio reply to handleConfirmationReply too, when a reminder is awaiting_confirmation", async () => {
  await seedAwaitingConfirmationReminder();
  mockTranscribeAudioToReturn("no");
  mockHandleConfirmationReply.mockResolvedValueOnce("rejected");

  await handleIncomingMessage(null, "wa-confirm-audio", "audio", Buffer.from("fake audio"));

  expect(mockHandleConfirmationReply).toHaveBeenCalledWith("no");
  expect(mockClassifyMessage).not.toHaveBeenCalled();
});

test("handleIncomingMessage classifies normally when no reminder is awaiting_confirmation", async () => {
  mockClassifyMessage.mockResolvedValueOnce({ intent: "capture", noteType: "idea" });

  await handleIncomingMessage("una idea sin recordatorios pendientes", "wa-no-pending", "text");

  expect(mockHandleConfirmationReply).not.toHaveBeenCalled();
  expect(mockClassifyMessage).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// Final-review fixes (unit level; see router.integration.test.ts for the
// same scenarios against the real reminder state machine)
// ---------------------------------------------------------------------------

test("A message that is NOT a yes/no while a reminder is pending is still classified and persisted, and the prompt is re-sent afterwards", async () => {
  await seedAwaitingConfirmationReminder();
  mockHandleConfirmationReply.mockResolvedValueOnce("unrecognized");
  mockClassifyMessage.mockResolvedValueOnce({
    intent: "capture",
    noteType: "gasto",
    amountCents: 320000,
    category: "comida",
  });

  await handleIncomingMessage("café 3200", "wa-cafe", "text");

  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-cafe" }, include: { expense: true } });
  expect(note?.type).toBe("gasto");
  expect(note?.expense?.amountCents).toBe(320000);
  expect(mockResendPendingPrompt).toHaveBeenCalledTimes(1);
  // Persisted first, re-prompted second: a failing re-prompt can't cost the note.
  expect(mockResendPendingPrompt.mock.invocationCallOrder[0]!).toBeGreaterThan(
    mockClassifyMessage.mock.invocationCallOrder[0]!
  );
});

test("A question asked while a reminder is pending is answered, and the prompt is re-sent", async () => {
  await seedAwaitingConfirmationReminder();
  mockHandleConfirmationReply.mockResolvedValueOnce("unrecognized");
  mockClassifyMessage.mockResolvedValueOnce({ intent: "query" });
  mockAnswerQuery.mockResolvedValueOnce("Gastaste $0.");

  await handleIncomingMessage("¿cuánto gasté hoy?", "wa-q-pending", "text");

  expect(mockSendSelfMessage).toHaveBeenCalledWith("Gastaste $0.");
  expect(mockResendPendingPrompt).toHaveBeenCalledTimes(1);
});

test("An audio message whose download failed (no buffer at all) becomes a no_identificado placeholder Note, without calling transcribeAudio", async () => {
  await handleIncomingMessage(null, "wa-audio-nobuf", "audio", undefined);

  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-audio-nobuf" } });
  expect(note?.type).toBe("no_identificado");
  expect(note?.source).toBe("audio");
  expect(mockTranscribeAudio).not.toHaveBeenCalled();
  expect(mockClassifyMessage).not.toHaveBeenCalled();
});

test("The same waMessageId is only acted on once even when it is a query (no Note is ever created for it)", async () => {
  mockClassifyMessage.mockResolvedValue({ intent: "query" });
  mockAnswerQuery.mockResolvedValue("respuesta");

  await handleIncomingMessage("¿qué anoté ayer?", "wa-query-dup", "text");
  await handleIncomingMessage("¿qué anoté ayer?", "wa-query-dup", "text");

  expect(mockAnswerQuery).toHaveBeenCalledTimes(1);
  expect(mockSendSelfMessage).toHaveBeenCalledTimes(1);
});

test("The same waMessageId is only acted on once even when it is a confirmation reply", async () => {
  await seedAwaitingConfirmationReminder();
  mockHandleConfirmationReply.mockResolvedValue("rejected");

  await handleIncomingMessage("no", "wa-reply-dup", "text");
  await handleIncomingMessage("no", "wa-reply-dup", "text");

  expect(mockHandleConfirmationReply).toHaveBeenCalledTimes(1);
});

test("Two concurrent deliveries of the same waMessageId only process it once", async () => {
  mockClassifyMessage.mockResolvedValue({ intent: "capture", noteType: "idea" });

  await Promise.all([
    handleIncomingMessage("idea doble", "wa-concurrent-dup", "text"),
    handleIncomingMessage("idea doble", "wa-concurrent-dup", "text"),
  ]);

  expect(mockClassifyMessage).toHaveBeenCalledTimes(1);
  expect(await db.note.count({ where: { whatsappMessageId: "wa-concurrent-dup" } })).toBe(1);
});

test("A message id the bot recorded as its own sent message is never processed as input", async () => {
  await db.processedMessage.create({ data: { whatsappMessageId: "wa-bot-echo", outcome: "self_sent" } });

  await handleIncomingMessage("Entendí: ...", "wa-bot-echo", "text");

  expect(mockClassifyMessage).not.toHaveBeenCalled();
  expect(await db.note.count()).toBe(0);
});

test("never loses a capture: if persisting the classified note fails, the message is still saved as no_identificado", async () => {
  // An amount too large for SQLite's Int column makes the Expense write fail
  // inside persistClassifiedNote's transaction.
  mockClassifyMessage.mockResolvedValueOnce({ intent: "capture", noteType: "gasto", amountCents: 2 ** 40 });
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  await handleIncomingMessage("gasté una fortuna", "wa-fallback", "text");

  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-fallback" }, include: { expense: true } });
  expect(note?.type).toBe("no_identificado");
  expect(note?.rawText).toBe("gasté una fortuna");
  expect(note?.expense).toBeNull();
  errorSpy.mockRestore();
});

test("never loses a question: if the answer can't be sent, the question is saved as a no_identificado Note", async () => {
  mockClassifyMessage.mockResolvedValueOnce({ intent: "query" });
  mockAnswerQuery.mockResolvedValueOnce("respuesta");
  mockSendSelfMessage.mockRejectedValueOnce(new Error("socket closed"));
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  await handleIncomingMessage("¿cuánto gasté?", "wa-q-unsent", "text");

  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-q-unsent" } });
  expect(note?.type).toBe("no_identificado");
  expect(note?.rawText).toBe("¿cuánto gasté?");
  errorSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Delete intent + delete confirmation routing
// ---------------------------------------------------------------------------

test("handleIncomingMessage routes a 'delete' classification to requestDelete instead of persisting a Note", async () => {
  mockClassifyMessage.mockResolvedValueOnce({ intent: "delete" });
  mockRequestDelete.mockResolvedValueOnce("asked_confirm");

  await handleIncomingMessage("borrá esa idea", "wa-delete-1", "text");

  expect(mockRequestDelete).toHaveBeenCalledWith("borrá esa idea");
  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-delete-1" } });
  expect(note).toBeNull();
});

test("handleIncomingMessage routes a text reply to handleDeleteReply (not classifyMessage) when a PendingDeletion is open", async () => {
  const note = await db.note.create({
    data: { rawText: "idea de los libros", source: "text", type: "idea", whatsappMessageId: randomUUID() },
  });
  await seedPendingDeletion(note.id);
  mockHandleDeleteReply.mockResolvedValueOnce("deleted");

  await handleIncomingMessage("sí", "wa-delete-confirm-1", "text");

  expect(mockHandleDeleteReply).toHaveBeenCalledWith("sí");
  expect(mockClassifyMessage).not.toHaveBeenCalled();
  const reply = await db.note.findUnique({ where: { whatsappMessageId: "wa-delete-confirm-1" } });
  expect(reply).toBeNull();
});

test("handleIncomingMessage classifies normally and re-sends the delete prompt when the reply to a PendingDeletion is unrecognized", async () => {
  const note = await db.note.create({
    data: { rawText: "idea de los libros", source: "text", type: "idea", whatsappMessageId: randomUUID() },
  });
  await seedPendingDeletion(note.id);
  mockHandleDeleteReply.mockResolvedValueOnce("unrecognized");
  mockClassifyMessage.mockResolvedValueOnce({ intent: "capture", noteType: "idea" });

  await handleIncomingMessage("otra idea distinta", "wa-delete-unrecognized", "text");

  const persisted = await db.note.findUnique({ where: { whatsappMessageId: "wa-delete-unrecognized" } });
  expect(persisted?.type).toBe("idea");
  expect(mockResendPendingDeletePrompt).toHaveBeenCalledTimes(1);
});

test("handleIncomingMessage classifies normally when no PendingDeletion is open", async () => {
  mockClassifyMessage.mockResolvedValueOnce({ intent: "capture", noteType: "idea" });

  await handleIncomingMessage("una idea sin borrados pendientes", "wa-no-pending-delete", "text");

  expect(mockHandleDeleteReply).not.toHaveBeenCalled();
  expect(mockClassifyMessage).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// Pago_cuota intent + PendingCuotaPayment reply routing
// ---------------------------------------------------------------------------

test("a message classified as pago_cuota with a single match pays it and persists nothing as a separate note", async () => {
  mockClassifyMessage.mockResolvedValueOnce({ intent: "pago_cuota", amountCents: 85000 });
  mockRequestCuotaPayment.mockResolvedValueOnce("paid");

  await handleIncomingMessage("pagué la tarjeta mastercard, 850", "wa-cuota-paid-1", "text");

  expect(mockRequestCuotaPayment).toHaveBeenCalledWith("pagué la tarjeta mastercard, 850", 85000);
  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-cuota-paid-1" } });
  expect(note).toBeNull();
});

test("a message classified as pago_cuota with multiple matches asks to disambiguate", async () => {
  mockClassifyMessage.mockResolvedValueOnce({ intent: "pago_cuota" });
  mockRequestCuotaPayment.mockResolvedValueOnce("asked_disambiguate");

  await handleIncomingMessage("pagué el gimnasio", "wa-cuota-ambig-1", "text");

  expect(mockRequestCuotaPayment).toHaveBeenCalledWith("pagué el gimnasio", undefined);
  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-cuota-ambig-1" } });
  expect(note).toBeNull();
});

test("a reply while a PendingCuotaPayment is open is routed to handleCuotaPaymentReply, not reclassified", async () => {
  await seedPendingCuotaPayment();
  mockHandleCuotaPaymentReply.mockResolvedValueOnce("disambiguated");

  await handleIncomingMessage("1", "wa-cuota-reply-1", "text");

  expect(mockHandleCuotaPaymentReply).toHaveBeenCalledWith("1");
  expect(mockClassifyMessage).not.toHaveBeenCalled();
  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-cuota-reply-1" } });
  expect(note).toBeNull();
});

test("an unrecognized reply while a PendingCuotaPayment is open falls through to classification and reprompts afterward", async () => {
  await seedPendingCuotaPayment();
  mockHandleCuotaPaymentReply.mockResolvedValueOnce("unrecognized");
  mockClassifyMessage.mockResolvedValueOnce({ intent: "capture", noteType: "idea" });

  await handleIncomingMessage("otra cosa distinta", "wa-cuota-unrecognized", "text");

  const persisted = await db.note.findUnique({ where: { whatsappMessageId: "wa-cuota-unrecognized" } });
  expect(persisted?.type).toBe("idea");
  expect(mockResendPendingCuotaPaymentPrompt).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// Retiro_ahorro intent — always resolves immediately,
// never creates a pending row, never participates in the 4-way invariant.
// ---------------------------------------------------------------------------

test("a message classified as retiro_ahorro withdraws savings and sends a confirmation, without persisting a separate note", async () => {
  mockClassifyMessage.mockResolvedValueOnce({ intent: "retiro_ahorro", amountCents: 40_000_000 });
  mockWithdrawSavings.mockResolvedValueOnce({ withdrawnCents: 40_000_000 });

  await handleIncomingMessage("gasté mi ahorro en el TV, 400000", "wa-retiro-1", "text");

  expect(mockWithdrawSavings).toHaveBeenCalledWith(40_000_000);
  expect(mockSendSelfMessage).toHaveBeenCalledTimes(1);
  expect(mockSendSelfMessage.mock.calls[0]![0]).toContain("400.000");
  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-retiro-1" } });
  expect(note).toBeNull();
  const processed = await db.processedMessage.findUnique({ where: { whatsappMessageId: "wa-retiro-1" } });
  expect(processed?.outcome).toBe("retiro_ahorro");
});

test("a message classified as retiro_ahorro without an amount withdraws everything available (amountCents omitted -> null)", async () => {
  mockClassifyMessage.mockResolvedValueOnce({ intent: "retiro_ahorro" });
  mockWithdrawSavings.mockResolvedValueOnce({ withdrawnCents: 50_000_00 });

  await handleIncomingMessage("gasté todo mi ahorro en el TV", "wa-retiro-2", "text");

  expect(mockWithdrawSavings).toHaveBeenCalledWith(null);
});

// A WhatsApp send failure must never propagate: handleIncomingMessage only
// wraps classifyAndHandle in try/finally (not try/catch), so an unguarded
// sendSelfMessage here would escape uncaught after the withdrawal already
// committed. Same discipline as deleteFlow.ts/cuotaPaymentFlow.ts's own
// sendSelfMessageSafely — the withdrawal still completes and the message's
// outcome is still recorded even though the confirmation never got sent.
test("a sendSelfMessage failure on retiro_ahorro doesn't propagate: the withdrawal still completes and the outcome is still recorded", async () => {
  mockClassifyMessage.mockResolvedValueOnce({ intent: "retiro_ahorro", amountCents: 40_000_000 });
  mockWithdrawSavings.mockResolvedValueOnce({ withdrawnCents: 40_000_000 });
  mockSendSelfMessage.mockRejectedValueOnce(new Error("WhatsApp send failed"));

  await expect(
    handleIncomingMessage("gasté mi ahorro en el TV, 400000", "wa-retiro-send-fail", "text")
  ).resolves.toBeUndefined();

  expect(mockWithdrawSavings).toHaveBeenCalledWith(40_000_000);
  const processed = await db.processedMessage.findUnique({
    where: { whatsappMessageId: "wa-retiro-send-fail" },
  });
  expect(processed?.outcome).toBe("retiro_ahorro");
});

// ---------------------------------------------------------------------------
// Factibilidad_compra intent + PendingPurchaseSimulation reply routing
// ---------------------------------------------------------------------------

test("a message classified as factibilidad_compra dispatches to requestPurchaseFeasibility and records its outcome", async () => {
  mockClassifyMessage.mockResolvedValueOnce({ intent: "factibilidad_compra" });
  mockRequestPurchaseFeasibility.mockResolvedValueOnce("answered");

  await handleIncomingMessage("¿me conviene comprar una heladera de 800000?", "wa-feasibility-1", "text");

  expect(mockRequestPurchaseFeasibility).toHaveBeenCalledWith("¿me conviene comprar una heladera de 800000?");
  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-feasibility-1" } });
  expect(note).toBeNull();
  const processed = await db.processedMessage.findUnique({ where: { whatsappMessageId: "wa-feasibility-1" } });
  expect(processed?.outcome).toBe("factibilidad_compra_answered");
});

test("a reply while a PendingPurchaseSimulation is open is routed to handlePurchaseFeasibilityReply, not reclassified", async () => {
  await seedPendingPurchaseSimulation();
  mockHandlePurchaseFeasibilityReply.mockResolvedValueOnce("asked_clarify");

  await handleIncomingMessage("en cuotas", "wa-feasibility-reply-1", "text");

  expect(mockHandlePurchaseFeasibilityReply).toHaveBeenCalledWith("en cuotas");
  expect(mockClassifyMessage).not.toHaveBeenCalled();
  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-feasibility-reply-1" } });
  expect(note).toBeNull();
});

test("a 'cancelled' reply while a PendingPurchaseSimulation is open returns early too, same as 'answered'/'asked_clarify'", async () => {
  await seedPendingPurchaseSimulation();
  mockHandlePurchaseFeasibilityReply.mockResolvedValueOnce("cancelled");

  await handleIncomingMessage("no", "wa-feasibility-cancel-1", "text");

  expect(mockHandlePurchaseFeasibilityReply).toHaveBeenCalledWith("no");
  expect(mockClassifyMessage).not.toHaveBeenCalled();
  expect(mockResendPendingPurchaseFeasibilityPrompt).not.toHaveBeenCalled();
  const processed = await db.processedMessage.findUnique({ where: { whatsappMessageId: "wa-feasibility-cancel-1" } });
  expect(processed?.outcome).toBe("factibilidad_compra_cancelled");
});

test("an unrecognized reply while a PendingPurchaseSimulation is open falls through to classification and reprompts afterward", async () => {
  await seedPendingPurchaseSimulation();
  mockHandlePurchaseFeasibilityReply.mockResolvedValueOnce("unrecognized");
  mockClassifyMessage.mockResolvedValueOnce({ intent: "capture", noteType: "idea" });

  await handleIncomingMessage("otra cosa distinta", "wa-feasibility-unrecognized", "text");

  const persisted = await db.note.findUnique({ where: { whatsappMessageId: "wa-feasibility-unrecognized" } });
  expect(persisted?.type).toBe("idea");
  expect(mockResendPendingPurchaseFeasibilityPrompt).toHaveBeenCalledTimes(1);
});

test("handleIncomingMessage classifies normally when no PendingPurchaseSimulation is open", async () => {
  mockClassifyMessage.mockResolvedValueOnce({ intent: "capture", noteType: "idea" });

  await handleIncomingMessage("una idea sin consultas de factibilidad pendientes", "wa-no-pending-feasibility", "text");

  expect(mockHandlePurchaseFeasibilityReply).not.toHaveBeenCalled();
  expect(mockClassifyMessage).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// Proyeccion_ahorro intent — always resolves
// immediately (no object/price to extract, no clarification flow, never
// creates a pending row), mirroring retiro_ahorro's dispatch shape rather
// than factibilidad_compra's.
// ---------------------------------------------------------------------------

function expectedNextYearMonth(): string {
  return addMonthsToYearMonth(toArgentinaDateString(new Date()).slice(0, 7), 1);
}

test("a message classified as proyeccion_ahorro computes and sends the projection for next month, without persisting a note", async () => {
  mockClassifyMessage.mockResolvedValueOnce({ intent: "proyeccion_ahorro" });
  mockProjectMonthlySavingsCapacity.mockResolvedValueOnce({ capacityCents: 150_000_00, monthsUsed: 3, aguinaldoBonusCents: 0 });
  mockComposeSavingsProjectionAnswer.mockResolvedValueOnce("Podrías ahorrar $150.000 el mes que viene.");

  await handleIncomingMessage("¿cuánto puedo ahorrar el mes que viene?", "wa-proyeccion-1", "text");

  const targetYearMonth = expectedNextYearMonth();
  expect(mockProjectMonthlySavingsCapacity).toHaveBeenCalledWith(targetYearMonth, expect.any(String));
  expect(mockComposeSavingsProjectionAnswer).toHaveBeenCalledWith(
    "¿cuánto puedo ahorrar el mes que viene?",
    targetYearMonth,
    { capacityCents: 150_000_00, monthsUsed: 3, aguinaldoBonusCents: 0 }
  );
  expect(mockSendSelfMessage).toHaveBeenCalledWith("Podrías ahorrar $150.000 el mes que viene.");
  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-proyeccion-1" } });
  expect(note).toBeNull();
  const processed = await db.processedMessage.findUnique({ where: { whatsappMessageId: "wa-proyeccion-1" } });
  expect(processed?.outcome).toBe("proyeccion_ahorro");
});

// Fix round (task review): proyeccion_ahorro's no-history reply must use its
// OWN purchase-neutral message, never NO_HISTORY_MESSAGE (which talks about
// "evaluar esta compra" — confusing for a question that never mentioned any
// purchase).
test("a message classified as proyeccion_ahorro with no_history sends NO_HISTORY_SAVINGS_MESSAGE directly, without calling composeSavingsProjectionAnswer", async () => {
  mockClassifyMessage.mockResolvedValueOnce({ intent: "proyeccion_ahorro" });
  mockProjectMonthlySavingsCapacity.mockResolvedValueOnce("no_history");

  await handleIncomingMessage("¿cuánto puedo ahorrar el mes que viene?", "wa-proyeccion-no-history", "text");

  expect(mockComposeSavingsProjectionAnswer).not.toHaveBeenCalled();
  expect(mockSendSelfMessage).toHaveBeenCalledTimes(1);
  expect(mockSendSelfMessage.mock.calls[0]![0]).toBe(NO_HISTORY_SAVINGS_MESSAGE);
  // Never the purchase-worded message factibilidad_compra uses.
  expect(mockSendSelfMessage.mock.calls[0]![0]).not.toBe(NO_HISTORY_MESSAGE);
});

// A Groq/compute failure here must never propagate: handleIncomingMessage
// only wraps classifyAndHandle in try/finally (not try/catch), same
// discipline required of retiro_ahorro's/factibilidad_compra's own branches.
test("a projectMonthlySavingsCapacity failure on proyeccion_ahorro doesn't propagate: a fixed failure message is sent instead", async () => {
  mockClassifyMessage.mockResolvedValueOnce({ intent: "proyeccion_ahorro" });
  mockProjectMonthlySavingsCapacity.mockRejectedValueOnce(new Error("Groq API error"));
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  await expect(
    handleIncomingMessage("¿cuánto puedo ahorrar el mes que viene?", "wa-proyeccion-fail", "text")
  ).resolves.toBeUndefined();

  expect(mockSendSelfMessage).toHaveBeenCalledTimes(1);
  const processed = await db.processedMessage.findUnique({ where: { whatsappMessageId: "wa-proyeccion-fail" } });
  expect(processed?.outcome).toBe("proyeccion_ahorro");
  errorSpy.mockRestore();
});

test("a composeSavingsProjectionAnswer failure on proyeccion_ahorro also doesn't propagate", async () => {
  mockClassifyMessage.mockResolvedValueOnce({ intent: "proyeccion_ahorro" });
  mockProjectMonthlySavingsCapacity.mockResolvedValueOnce({ capacityCents: 150_000_00, monthsUsed: 3, aguinaldoBonusCents: 0 });
  mockComposeSavingsProjectionAnswer.mockRejectedValueOnce(new Error("Groq returned no content"));
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  await expect(
    handleIncomingMessage("¿cuánto puedo ahorrar el mes que viene?", "wa-proyeccion-compose-fail", "text")
  ).resolves.toBeUndefined();

  expect(mockSendSelfMessage).toHaveBeenCalledTimes(1);
  errorSpy.mockRestore();
});

test("proyeccion_ahorro never participates in the 4-way pending invariant: classifies normally when nothing else is pending", async () => {
  mockClassifyMessage.mockResolvedValueOnce({ intent: "proyeccion_ahorro" });
  mockProjectMonthlySavingsCapacity.mockResolvedValueOnce({ capacityCents: 50_000_00, monthsUsed: 2, aguinaldoBonusCents: 0 });
  mockComposeSavingsProjectionAnswer.mockResolvedValueOnce("Podrías ahorrar $50.000.");

  await handleIncomingMessage("¿cuánto me sobra para ahorrar?", "wa-proyeccion-2", "text");

  expect(await db.pendingPurchaseSimulation.count()).toBe(0);
  expect(await db.pendingDeletion.count()).toBe(0);
  expect(await db.pendingCuotaPayment.count()).toBe(0);
});

// ---------------------------------------------------------------------------
// Image messages (handleReceiptImage) + the fifth
// pending-confirmation block (PendingReceiptConfirmation / receiptConfirmationFlow.ts).
// ---------------------------------------------------------------------------

test("an image message is dispatched to handleReceiptImage (not classifyMessage) and its outcome is recorded", async () => {
  mockHandleReceiptImage.mockResolvedValueOnce("auto_logged");

  await handleIncomingMessage(null, "wa-img-1", "image", Buffer.from("fake jpeg"));

  expect(mockHandleReceiptImage).toHaveBeenCalledWith(
    Buffer.from("fake jpeg"),
    "wa-img-1",
    expect.any(String)
  );
  expect(mockClassifyMessage).not.toHaveBeenCalled();
  const processed = await db.processedMessage.findUnique({ where: { whatsappMessageId: "wa-img-1" } });
  expect(processed?.outcome).toBe("receipt_auto_logged");
});

test("each ReceiptImageOutcome is recorded with its own receipt_* outcome", async () => {
  mockHandleReceiptImage.mockResolvedValueOnce("pending_confirmation");

  await handleIncomingMessage(null, "wa-img-pending", "image", Buffer.from("fake jpeg"));

  const processed = await db.processedMessage.findUnique({ where: { whatsappMessageId: "wa-img-pending" } });
  expect(processed?.outcome).toBe("receipt_pending_confirmation");
});

test("an image message whose download failed (no buffer at all) is persisted as a no_identificado placeholder, sends the technical-failure message, without calling handleReceiptImage", async () => {
  await handleIncomingMessage(null, "wa-img-nobuf", "image", undefined);

  expect(mockHandleReceiptImage).not.toHaveBeenCalled();
  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-img-nobuf" } });
  expect(note?.type).toBe("no_identificado");
  expect(note?.source).toBe("image");
  const processed = await db.processedMessage.findUnique({ where: { whatsappMessageId: "wa-img-nobuf" } });
  expect(processed?.outcome).toBe("receipt_failed");
  // A failed download must not be lost in silence — it
  // reuses the exact same message receiptConfirmationFlow.ts sends for its
  // own "failed" outcome (single source of truth).
  expect(mockSendSelfMessage).toHaveBeenCalledWith(RECEIPT_FAILED_MESSAGE);
});

test("the same image waMessageId delivered twice is only dispatched to handleReceiptImage once", async () => {
  mockHandleReceiptImage.mockResolvedValue("auto_logged");

  await handleIncomingMessage(null, "wa-img-dup", "image", Buffer.from("fake jpeg"));
  await handleIncomingMessage(null, "wa-img-dup", "image", Buffer.from("fake jpeg"));

  expect(mockHandleReceiptImage).toHaveBeenCalledTimes(1);
});

test("a reply while a PendingReceiptConfirmation is open is routed to handleReceiptConfirmationReply, not reclassified", async () => {
  await seedPendingReceiptConfirmation();
  mockHandleReceiptConfirmationReply.mockResolvedValueOnce("confirmed");

  await handleIncomingMessage("sí", "wa-receipt-confirm-1", "text");

  expect(mockHandleReceiptConfirmationReply).toHaveBeenCalledWith("sí");
  expect(mockClassifyMessage).not.toHaveBeenCalled();
  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-receipt-confirm-1" } });
  expect(note).toBeNull();
  const processed = await db.processedMessage.findUnique({
    where: { whatsappMessageId: "wa-receipt-confirm-1" },
  });
  expect(processed?.outcome).toBe("receipt_confirmation_confirmed");
});

test("an unrecognized reply while a PendingReceiptConfirmation is open falls through to classification and reprompts afterward", async () => {
  await seedPendingReceiptConfirmation();
  mockHandleReceiptConfirmationReply.mockResolvedValueOnce("unrecognized");
  mockClassifyMessage.mockResolvedValueOnce({ intent: "capture", noteType: "idea" });

  await handleIncomingMessage("otra cosa distinta", "wa-receipt-unrecognized", "text");

  const persisted = await db.note.findUnique({ where: { whatsappMessageId: "wa-receipt-unrecognized" } });
  expect(persisted?.type).toBe("idea");
  expect(mockResendPendingReceiptPrompt).toHaveBeenCalledTimes(1);
});

test("handleIncomingMessage classifies normally when no PendingReceiptConfirmation is open", async () => {
  mockClassifyMessage.mockResolvedValueOnce({ intent: "capture", noteType: "idea" });

  await handleIncomingMessage("una idea sin tickets pendientes", "wa-no-pending-receipt", "text");

  expect(mockHandleReceiptConfirmationReply).not.toHaveBeenCalled();
  expect(mockClassifyMessage).toHaveBeenCalledTimes(1);
});

// The fifth (receipt) pending block must not interfere with the other
// four, and vice versa: none of the five fires when its own table is empty,
// even while a DIFFERENT one of the five has an open row.
test("a PendingReceiptConfirmation open does not trigger the other four pending-reply handlers", async () => {
  await seedPendingReceiptConfirmation();
  mockHandleReceiptConfirmationReply.mockResolvedValueOnce("unrecognized");
  mockClassifyMessage.mockResolvedValueOnce({ intent: "capture", noteType: "idea" });

  await handleIncomingMessage("otra cosa distinta", "wa-receipt-isolated", "text");

  expect(mockHandleConfirmationReply).not.toHaveBeenCalled();
  expect(mockHandleDeleteReply).not.toHaveBeenCalled();
  expect(mockHandleCuotaPaymentReply).not.toHaveBeenCalled();
  expect(mockHandlePurchaseFeasibilityReply).not.toHaveBeenCalled();
});

// And the reverse: an open PendingDeletion/PendingCuotaPayment/
// PendingPurchaseSimulation/pending reminder must not trigger the receipt
// handler when no PendingReceiptConfirmation row exists.
test("an open PendingPurchaseSimulation does not trigger handleReceiptConfirmationReply when no PendingReceiptConfirmation is open", async () => {
  await seedPendingPurchaseSimulation();
  mockHandlePurchaseFeasibilityReply.mockResolvedValueOnce("unrecognized");
  mockClassifyMessage.mockResolvedValueOnce({ intent: "capture", noteType: "idea" });

  await handleIncomingMessage("otra cosa distinta", "wa-no-receipt-pending", "text");

  expect(mockHandleReceiptConfirmationReply).not.toHaveBeenCalled();
});
