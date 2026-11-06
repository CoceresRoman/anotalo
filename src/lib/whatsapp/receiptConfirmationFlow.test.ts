import { randomUUID } from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";
import db from "../db";

// handleReceiptImage/handleReceiptConfirmationReply's only external
// dependencies are extractReceiptFromImage (Groq vision) and
// sendSelfMessage (WhatsApp send) — persistClassifiedNote, the Note+Expense
// transaction, and the pending-row DB logic are real: these tests assert
// the decide/persist/confirm state machine against a real (test) DB, never
// touching Groq or WhatsApp. Same mocking discipline as
// cuotaPaymentFlow.test.ts/deleteFlow.test.ts.
const mockSendSelfMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockExtractReceiptFromImage = vi.hoisted(() => vi.fn());

vi.mock("./connection", () => ({ sendSelfMessage: mockSendSelfMessage }));
vi.mock("./ocrReceipt", async (importOriginal) => {
  const original = await importOriginal<typeof import("./ocrReceipt")>();
  return { ...original, extractReceiptFromImage: mockExtractReceiptFromImage };
});

import {
  handleReceiptConfirmationReply,
  handleReceiptImage,
  resendPendingReceiptPrompt,
} from "./receiptConfirmationFlow";

const OCCURRED_AT = new Date("2026-11-01T12:00:00-03:00");
const NOW_ISO = "2026-11-04T12:00:00.000Z";

function highConfidenceExtraction(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    amountCents: 150000,
    category: "Mercado",
    occurredAt: OCCURRED_AT,
    confidencePercent: 90,
    ...overrides,
  };
}

function lowConfidenceExtraction(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    amountCents: 50000,
    category: "Comida",
    occurredAt: OCCURRED_AT,
    confidencePercent: 40,
    ...overrides,
  };
}

async function seedNote({
  type = "idea",
  rawText = "nota de prueba",
}: { type?: string; rawText?: string } = {}) {
  return db.note.create({
    data: { rawText, source: "text", type, whatsappMessageId: randomUUID() },
  });
}

beforeEach(async () => {
  await db.expense.deleteMany();
  await db.pendingReceiptConfirmation.deleteMany();
  await db.pendingCuotaPayment.deleteMany();
  await db.pendingDeletion.deleteMany();
  await db.pendingPurchaseSimulation.deleteMany();
  await db.reminder.deleteMany();
  await db.note.deleteMany();
  mockSendSelfMessage.mockReset().mockResolvedValue(undefined);
  mockExtractReceiptFromImage.mockReset();
});

test("handleReceiptImage with confidence >= threshold persists the Expense directly, sends a message, and returns auto_logged", async () => {
  mockExtractReceiptFromImage.mockResolvedValue(highConfidenceExtraction());

  const outcome = await handleReceiptImage(Buffer.from("fake-image"), "wa-auto-log", NOW_ISO);

  expect(outcome).toBe("auto_logged");
  expect(await db.pendingReceiptConfirmation.count()).toBe(0);

  const expense = await db.expense.findFirst();
  expect(expense?.amountCents).toBe(150000);
  expect(expense?.category).toBe("Mercado");
  expect(expense?.occurredAt.toISOString()).toBe(OCCURRED_AT.toISOString());

  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-auto-log" } });
  expect(note?.type).toBe("gasto");
  expect(note?.source).toBe("image");

  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining("Mercado"));
});

test("handleReceiptImage with confidence < threshold and nothing else pending creates a PendingReceiptConfirmation, sends a message, and returns pending_confirmation", async () => {
  mockExtractReceiptFromImage.mockResolvedValue(lowConfidenceExtraction());

  const outcome = await handleReceiptImage(Buffer.from("fake-image"), "wa-pending", NOW_ISO);

  expect(outcome).toBe("pending_confirmation");
  expect(await db.expense.count()).toBe(0);

  const pending = await db.pendingReceiptConfirmation.findFirst();
  expect(pending?.amountCents).toBe(50000);
  expect(pending?.category).toBe("Comida");
  expect(pending?.occurredAt.toISOString()).toBe(OCCURRED_AT.toISOString());

  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining("Comida"));
});

test("handleReceiptImage with confidence < threshold is blocked while a Reminder is awaiting_confirmation", async () => {
  mockExtractReceiptFromImage.mockResolvedValue(lowConfidenceExtraction());
  const note = await seedNote({ type: "recordatorio", rawText: "turno con el dentista" });
  await db.reminder.create({
    data: {
      noteId: note.id,
      parsedDatetime: new Date(Date.now() + 86400000),
      status: "awaiting_confirmation",
      calendarEventId: null,
    },
  });

  const outcome = await handleReceiptImage(Buffer.from("fake-image"), "wa-blocked-reminder", NOW_ISO);

  expect(outcome).toBe("blocked_by_other_pending");
  expect(await db.pendingReceiptConfirmation.count()).toBe(0);
  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining("pendiente"));
});

test("handleReceiptImage with confidence < threshold is blocked while a PendingDeletion is open", async () => {
  mockExtractReceiptFromImage.mockResolvedValue(lowConfidenceExtraction());
  const note = await seedNote({ rawText: "idea de la app de libros" });
  await db.pendingDeletion.create({
    data: { stage: "confirming", noteIds: JSON.stringify([note.id]) },
  });

  const outcome = await handleReceiptImage(Buffer.from("fake-image"), "wa-blocked-deletion", NOW_ISO);

  expect(outcome).toBe("blocked_by_other_pending");
  expect(await db.pendingReceiptConfirmation.count()).toBe(0);
});

test("handleReceiptImage with confidence < threshold is blocked while a PendingCuotaPayment is open", async () => {
  mockExtractReceiptFromImage.mockResolvedValue(lowConfidenceExtraction());
  await db.pendingCuotaPayment.create({
    data: { candidates: JSON.stringify([{ kind: "item", id: "fake-item-id" }]), overrideAmountCents: null },
  });

  const outcome = await handleReceiptImage(Buffer.from("fake-image"), "wa-blocked-cuota", NOW_ISO);

  expect(outcome).toBe("blocked_by_other_pending");
  expect(await db.pendingReceiptConfirmation.count()).toBe(0);
});

// A second low-confidence photo arriving
// while one PendingReceiptConfirmation is already open (e.g. the user sending
// two receipts in a row while catching up) must be blocked by this flow's
// OWN self-check — not just the other four tables' — or a later "sí" could
// resolve the wrong one (findFirst() has no ordering).
test("handleReceiptImage with confidence < threshold is blocked while a PendingReceiptConfirmation is already open, and creates no second row", async () => {
  mockExtractReceiptFromImage.mockResolvedValue(lowConfidenceExtraction());
  await db.pendingReceiptConfirmation.create({
    data: { amountCents: 70000, category: "Transporte", occurredAt: OCCURRED_AT },
  });

  const outcome = await handleReceiptImage(Buffer.from("fake-image"), "wa-blocked-receipt", NOW_ISO);

  expect(outcome).toBe("blocked_by_other_pending");
  expect(await db.pendingReceiptConfirmation.count()).toBe(1);
});

test("handleReceiptImage with confidence < threshold is blocked while a PendingPurchaseSimulation is open", async () => {
  mockExtractReceiptFromImage.mockResolvedValue(lowConfidenceExtraction());
  await db.pendingPurchaseSimulation.create({
    data: { conversationText: "quiero comprar algo", missingField: "price" },
  });

  const outcome = await handleReceiptImage(Buffer.from("fake-image"), "wa-blocked-purchase", NOW_ISO);

  expect(outcome).toBe("blocked_by_other_pending");
  expect(await db.pendingReceiptConfirmation.count()).toBe(0);
});

// Confirmed-real race (not theoretical): a plain
// "check the 4 other tables, then create PendingReceiptConfirmation" has a
// gap between the check and the create. src/app/api/sin-clasificar/[id]/route.ts
// can promote a Reminder to awaiting_confirmation from the webapp — a path
// that is NOT serialized against the WhatsApp message queue in
// connection.ts — so a Reminder can appear in exactly that gap. This test
// simulates that by making the (mocked) extractReceiptFromImage call itself
// create the Reminder row as a side effect before resolving — the same
// technique deleteFlow.test.ts/cuotaPaymentFlow.test.ts use to simulate a
// race landing inside the one await before their own atomic insert. The
// atomic INSERT ... WHERE NOT EXISTS in
// insertPendingReceiptConfirmationIfNothingElsePending must still catch it
// and create no PendingReceiptConfirmation.
test("handleReceiptImage creates no PendingReceiptConfirmation when a Reminder is promoted to awaiting_confirmation during the OCR extraction call (atomic race guard)", async () => {
  const reminderNote = await seedNote({ type: "recordatorio", rawText: "turno con el dentista" });

  mockExtractReceiptFromImage.mockImplementationOnce(async () => {
    await db.reminder.create({
      data: {
        noteId: reminderNote.id,
        parsedDatetime: new Date(Date.now() + 86400000),
        status: "awaiting_confirmation",
        calendarEventId: null,
      },
    });
    return lowConfidenceExtraction();
  });

  const outcome = await handleReceiptImage(Buffer.from("fake-image"), "wa-race-reminder", NOW_ISO);

  expect(outcome).toBe("blocked_by_other_pending");
  expect(await db.pendingReceiptConfirmation.count()).toBe(0);
});

test("handleReceiptImage with an unreadable extraction persists a no_identificado Note, sends a message, and returns unreadable", async () => {
  mockExtractReceiptFromImage.mockResolvedValue("unreadable");

  const outcome = await handleReceiptImage(Buffer.from("fake-image"), "wa-unreadable", NOW_ISO);

  expect(outcome).toBe("unreadable");
  expect(await db.expense.count()).toBe(0);
  expect(await db.pendingReceiptConfirmation.count()).toBe(0);

  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-unreadable" } });
  expect(note?.type).toBe("no_identificado");
  expect(note?.source).toBe("image");

  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining("No pude leer"));
});

test("handleReceiptImage with a failed extraction persists a no_identificado Note and sends a message distinct from the unreadable one, returning failed", async () => {
  mockExtractReceiptFromImage.mockResolvedValue("failed");

  const outcome = await handleReceiptImage(Buffer.from("fake-image"), "wa-failed", NOW_ISO);

  expect(outcome).toBe("failed");
  expect(await db.expense.count()).toBe(0);

  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-failed" } });
  expect(note?.type).toBe("no_identificado");

  const failedMessage = mockSendSelfMessage.mock.calls[0]![0] as string;

  mockSendSelfMessage.mockClear();
  mockExtractReceiptFromImage.mockResolvedValue("unreadable");
  await handleReceiptImage(Buffer.from("fake-image"), "wa-failed-vs-unreadable", NOW_ISO);
  const unreadableMessage = mockSendSelfMessage.mock.calls[0]![0] as string;

  expect(failedMessage).not.toBe(unreadableMessage);
});

test("handleReceiptConfirmationReply('sí') with a pending row persists the Expense with the stored fields, deletes the row, and returns confirmed", async () => {
  await db.pendingReceiptConfirmation.create({
    data: { amountCents: 70000, category: "Transporte", occurredAt: OCCURRED_AT },
  });

  const outcome = await handleReceiptConfirmationReply("sí");

  expect(outcome).toBe("confirmed");
  expect(await db.pendingReceiptConfirmation.count()).toBe(0);

  const expense = await db.expense.findFirst();
  expect(expense?.amountCents).toBe(70000);
  expect(expense?.category).toBe("Transporte");
  expect(expense?.occurredAt.toISOString()).toBe(OCCURRED_AT.toISOString());

  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining("Transporte"));
});

test("handleReceiptConfirmationReply('no') with a pending row persists nothing, deletes the row, and returns rejected", async () => {
  await db.pendingReceiptConfirmation.create({
    data: { amountCents: 70000, category: "Transporte", occurredAt: OCCURRED_AT },
  });

  const outcome = await handleReceiptConfirmationReply("no");

  expect(outcome).toBe("rejected");
  expect(await db.expense.count()).toBe(0);
  expect(await db.pendingReceiptConfirmation.count()).toBe(0);
  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining("no cargué"));
});

test("handleReceiptConfirmationReply with unrecognized text does not delete the pending row and returns unrecognized", async () => {
  await db.pendingReceiptConfirmation.create({
    data: { amountCents: 70000, category: "Transporte", occurredAt: OCCURRED_AT },
  });

  const outcome = await handleReceiptConfirmationReply("asdasd");

  expect(outcome).toBe("unrecognized");
  expect(await db.pendingReceiptConfirmation.count()).toBe(1);
  expect(await db.expense.count()).toBe(0);
});

test("handleReceiptConfirmationReply with no pending row returns no_pending and sends no message", async () => {
  const outcome = await handleReceiptConfirmationReply("sí");

  expect(outcome).toBe("no_pending");
  expect(mockSendSelfMessage).not.toHaveBeenCalled();
});

// A Reminder queued behind an
// open receipt confirmation must be promoted as soon as that
// PendingReceiptConfirmation row is cleared — same discipline as
// deleteFlow.test.ts's "handleDeleteReply 'sí' promotes a Reminder queued
// behind the PendingDeletion once it's cleared" test. promptNextIfIdle
// (reminders.ts) is real here (not mocked), same as in
// deleteFlow.test.ts/cuotaPaymentFlow.test.ts.
test("handleReceiptConfirmationReply('sí') promotes a Reminder queued behind the PendingReceiptConfirmation once it's cleared", async () => {
  const reminderNote = await seedNote({ type: "recordatorio", rawText: "turno con el dentista" });
  const queuedReminder = await db.reminder.create({
    data: {
      noteId: reminderNote.id,
      parsedDatetime: new Date(Date.now() + 86400000),
      status: "queued",
      calendarEventId: null,
    },
  });
  await db.pendingReceiptConfirmation.create({
    data: { amountCents: 70000, category: "Transporte", occurredAt: OCCURRED_AT },
  });

  const outcome = await handleReceiptConfirmationReply("sí");

  expect(outcome).toBe("confirmed");
  const promoted = await db.reminder.findUnique({ where: { id: queuedReminder.id } });
  expect(promoted?.status).toBe("awaiting_confirmation");
});

test("handleReceiptConfirmationReply('no') promotes a Reminder queued behind the PendingReceiptConfirmation once it's cleared", async () => {
  const reminderNote = await seedNote({ type: "recordatorio", rawText: "turno con el dentista" });
  const queuedReminder = await db.reminder.create({
    data: {
      noteId: reminderNote.id,
      parsedDatetime: new Date(Date.now() + 86400000),
      status: "queued",
      calendarEventId: null,
    },
  });
  await db.pendingReceiptConfirmation.create({
    data: { amountCents: 70000, category: "Transporte", occurredAt: OCCURRED_AT },
  });

  const outcome = await handleReceiptConfirmationReply("no");

  expect(outcome).toBe("rejected");
  const promoted = await db.reminder.findUnique({ where: { id: queuedReminder.id } });
  expect(promoted?.status).toBe("awaiting_confirmation");
});

test("resendPendingReceiptPrompt re-sends the same prompt for the current PendingReceiptConfirmation", async () => {
  await db.pendingReceiptConfirmation.create({
    data: { amountCents: 70000, category: "Transporte", occurredAt: OCCURRED_AT },
  });

  await resendPendingReceiptPrompt();

  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining("Transporte"));
});

test("resendPendingReceiptPrompt never throws when nothing is pending", async () => {
  await expect(resendPendingReceiptPrompt()).resolves.toBeUndefined();
  expect(mockSendSelfMessage).not.toHaveBeenCalled();
});
