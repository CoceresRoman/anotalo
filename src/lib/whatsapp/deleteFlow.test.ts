import { randomUUID } from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";
import db from "../db";

// requestDelete/handleDeleteReply's only two external dependencies:
// sendSelfMessage (WhatsApp send) and deleteNoteCascading (the shared
// cascading-delete helper) — both mocked so these tests assert the
// request/confirm/disambiguate state machine itself, never touching
// WhatsApp or Google Calendar (deleteNoteCascading's own concern).
const mockSendSelfMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDeleteNoteCascading = vi.hoisted(() => vi.fn().mockResolvedValue("deleted"));

vi.mock("./connection", () => ({ sendSelfMessage: mockSendSelfMessage }));
vi.mock("../noteDeletion", () => ({ deleteNoteCascading: mockDeleteNoteCascading }));

import { handleDeleteReply, requestDelete, resendPendingDeletePrompt } from "./deleteFlow";
// Imported as a namespace (not destructured) specifically so a single test
// below can spy on findDeleteCandidates to simulate a concurrent
// enqueueReminder landing inside requestDelete's own await window — see
// that test for why.
import * as deleteMatchModule from "./deleteMatch";

async function seedNote({
  type = "idea",
  rawText = "idea de la app de libros",
}: {
  type?: string;
  rawText?: string;
} = {}) {
  return db.note.create({
    data: {
      rawText,
      source: "text",
      type,
      whatsappMessageId: randomUUID(),
    },
  });
}

beforeEach(async () => {
  await db.expense.deleteMany();
  await db.pendingDeletion.deleteMany();
  await db.pendingCuotaPayment.deleteMany();
  await db.pendingPurchaseSimulation.deleteMany();
  await db.pendingReceiptConfirmation.deleteMany();
  await db.reminder.deleteMany();
  await db.note.deleteMany();
  mockSendSelfMessage.mockReset().mockResolvedValue(undefined);
  mockDeleteNoteCascading.mockReset().mockResolvedValue("deleted");
});

test("requestDelete with no candidates sends a 'not found' message and creates no PendingDeletion", async () => {
  const outcome = await requestDelete("borrá la idea de los libros");

  expect(outcome).toBe("none_found");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(
    expect.stringContaining("No encontré ninguna nota reciente")
  );
  expect(await db.pendingDeletion.count()).toBe(0);
});

test("requestDelete with a single match sends a confirmation prompt quoting the note and creates a PendingDeletion(stage='confirming')", async () => {
  const note = await seedNote({ type: "idea", rawText: "idea de la app de libros" });

  const outcome = await requestDelete("borrá la idea de la app de libros");

  expect(outcome).toBe("asked_confirm");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(
    expect.stringContaining('"idea de la app de libros"')
  );
  const pending = await db.pendingDeletion.findFirst();
  expect(pending?.stage).toBe("confirming");
  expect(JSON.parse(pending!.noteIds)).toEqual([note.id]);
});

test("requestDelete with multiple matches sends a numbered list and creates a PendingDeletion(stage='disambiguating')", async () => {
  const note1 = await seedNote({ type: "idea", rawText: "idea sobre libros de cocina" });
  const note2 = await seedNote({ type: "idea", rawText: "idea sobre libros de historia" });

  const outcome = await requestDelete("borrá la idea de los libros");

  expect(outcome).toBe("asked_disambiguate");
  const message = mockSendSelfMessage.mock.calls[0]![0] as string;
  expect(message).toContain("1.");
  expect(message).toContain("2.");
  expect(message.toLowerCase()).toContain("número");
  const pending = await db.pendingDeletion.findFirst();
  expect(pending?.stage).toBe("disambiguating");
  expect(JSON.parse(pending!.noteIds).sort()).toEqual([note1.id, note2.id].sort());
});

test("requestDelete while a Reminder is awaiting_confirmation is blocked: sends a 'resolve the pending one first' message, creates no PendingDeletion", async () => {
  const note = await seedNote({ type: "recordatorio", rawText: "turno con el dentista" });
  await db.reminder.create({
    data: {
      noteId: note.id,
      parsedDatetime: new Date("2026-11-04T15:00:00-03:00"),
      status: "awaiting_confirmation",
      calendarEventId: null,
    },
  });

  const outcome = await requestDelete("borrá el turno con el dentista");

  expect(outcome).toBe("blocked_pending_reminder");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(
    expect.stringContaining("recordatorio pendiente de confirmar")
  );
  expect(await db.pendingDeletion.count()).toBe(0);
});

// RequestDelete must also refuse to run
// while a PendingReceiptConfirmation (receiptConfirmationFlow.ts)
// is open — the fifth member of the "one pending
// confirmation of any kind" family, which hadn't joined this invariant in
// either direction before this fix.
test("requestDelete while a PendingReceiptConfirmation is open is blocked: sends a 'resolve the pending one first' message, creates no PendingDeletion", async () => {
  await seedNote({ type: "idea", rawText: "idea de la app de libros" });
  await db.pendingReceiptConfirmation.create({
    data: { amountCents: 70000, category: "Transporte", occurredAt: new Date() },
  });

  const outcome = await requestDelete("borrá la idea de la app de libros");

  expect(outcome).toBe("blocked_pending_receipt_confirmation");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining("ticket pendiente de confirmar"));
  expect(await db.pendingDeletion.count()).toBe(0);
});

// Confirmed-real race (not theoretical): requestDelete's own
// "no Reminder pending" check and its PendingDeletion insert are two
// separate awaits, with findDeleteCandidates's own DB round-trip as an
// extra yield point in between. A concurrent enqueueReminder (reachable
// from a second, non-serialized entry point — see
// src/app/api/sin-clasificar/[id]/route.ts) can promote a Reminder to
// awaiting_confirmation in exactly that window. This test simulates that
// by making findDeleteCandidates itself create the Reminder row as a side
// effect before returning its (otherwise real) result — the atomic insert
// guard in requestDelete must still catch it and create no PendingDeletion.
test("requestDelete creates no PendingDeletion when a Reminder is promoted to awaiting_confirmation during the candidate lookup (atomic race guard)", async () => {
  await seedNote({ type: "idea", rawText: "idea de la app de libros" });
  const reminderNote = await seedNote({ type: "recordatorio", rawText: "turno con el dentista" });

  const original = deleteMatchModule.findDeleteCandidates;
  const spy = vi
    .spyOn(deleteMatchModule, "findDeleteCandidates")
    .mockImplementationOnce(async (requestText: string) => {
      await db.reminder.create({
        data: {
          noteId: reminderNote.id,
          parsedDatetime: new Date("2026-11-04T15:00:00-03:00"),
          status: "awaiting_confirmation",
          calendarEventId: null,
        },
      });
      return original(requestText);
    });

  const outcome = await requestDelete("borrá la idea de la app de libros");

  expect(outcome).toBe("blocked_pending_reminder");
  expect(await db.pendingDeletion.count()).toBe(0);
  expect(mockSendSelfMessage).toHaveBeenCalledWith(
    expect.stringContaining("recordatorio pendiente de confirmar")
  );

  spy.mockRestore();
});

// A second delete request while one PendingDeletion is already open
// (e.g. an unrecognized reply to the first one that the LLM then
// classifies as a fresh "delete" intent, per router.ts's fall-through to
// classifyAndHandle) must not create a second row — the atomic insert's
// new "AND NOT EXISTS PendingDeletion" guard should block it.
test("requestDelete while a PendingDeletion already exists is blocked: sends a 'resolve the pending one first' message, creates no second row", async () => {
  const existingNote = await seedNote({ type: "idea", rawText: "idea de la app de libros" });
  await db.pendingDeletion.create({
    data: { stage: "confirming", noteIds: JSON.stringify([existingNote.id]) },
  });
  await seedNote({ type: "idea", rawText: "idea sobre libros de cocina" });

  const outcome = await requestDelete("borrá la idea de los libros de cocina");

  expect(outcome).toBe("blocked_pending_deletion");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(
    expect.stringContaining("Ya tenés un borrado pendiente")
  );
  expect(await db.pendingDeletion.count()).toBe(1);
});

// The atomic insert guard now also checks PendingCuotaPayment
// (cuotaPaymentFlow.ts) — an open cuota-payment disambiguation must block a
// new PendingDeletion the same way an existing PendingDeletion already does
// (test above).
test("requestDelete while a PendingCuotaPayment exists is blocked: creates no PendingDeletion", async () => {
  await db.pendingCuotaPayment.create({
    data: { candidates: JSON.stringify([{ kind: "item", id: "some-item-id" }]), overrideAmountCents: null },
  });
  await seedNote({ type: "idea", rawText: "idea de la app de libros" });

  const outcome = await requestDelete("borrá la idea de la app de libros");

  expect(outcome).toBe("blocked_pending_cuota_payment");
  expect(await db.pendingDeletion.count()).toBe(0);
});

// Final-review finding (mirror of eda9cb9 on the cuota-payment side): the
// post-insert-failure fallback only picked between "Reminder pending" and
// "PendingDeletion open", wrongly blaming a borrado when the real blocker
// is an open PendingCuotaPayment.
test("requestDelete's post-insert-failure fallback blames a pending cuota payment, not a borrado, when that's what's actually blocking", async () => {
  await db.pendingCuotaPayment.create({
    data: { candidates: JSON.stringify([{ kind: "item", id: "some-item-id" }]), overrideAmountCents: null },
  });
  await seedNote({ type: "idea", rawText: "idea de la app de libros" });

  const outcome = await requestDelete("borrá la idea de la app de libros");

  expect(outcome).toBe("blocked_pending_cuota_payment");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining("pago de cuota pendiente"));
  expect(mockSendSelfMessage).not.toHaveBeenCalledWith(expect.stringContaining("borrado pendiente"));
  expect(await db.pendingDeletion.count()).toBe(0);
});

// Same, but with the PendingCuotaPayment landing inside requestDelete's own
// await window (simulated like the Reminder race test above).
test("requestDelete blames a pending cuota payment that won the race during the candidate lookup (atomic race guard)", async () => {
  await seedNote({ type: "idea", rawText: "idea de la app de libros" });

  const original = deleteMatchModule.findDeleteCandidates;
  const spy = vi
    .spyOn(deleteMatchModule, "findDeleteCandidates")
    .mockImplementationOnce(async (requestText: string) => {
      await db.pendingCuotaPayment.create({
        data: { candidates: JSON.stringify([{ kind: "item", id: "some-item-id" }]), overrideAmountCents: null },
      });
      return original(requestText);
    });

  const outcome = await requestDelete("borrá la idea de la app de libros");

  expect(outcome).toBe("blocked_pending_cuota_payment");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining("pago de cuota pendiente"));
  expect(await db.pendingDeletion.count()).toBe(0);
  expect(await db.pendingCuotaPayment.count()).toBe(1);

  spy.mockRestore();
});

// PendingPurchaseSimulation is the 4th leg
// of the same "one pending confirmation of any kind" slot — an open
// purchase-feasibility question (still missing price/mode/installments/
// interest) must block a new delete request the same way an open
// PendingCuotaPayment already does (test above).
test("requestDelete while a PendingPurchaseSimulation exists is blocked: creates no PendingDeletion", async () => {
  await db.pendingPurchaseSimulation.create({
    data: { conversationText: "¿me conviene comprar una heladera?", missingField: "price" },
  });
  await seedNote({ type: "idea", rawText: "idea de la app de libros" });

  const outcome = await requestDelete("borrá la idea de la app de libros");

  expect(outcome).toBe("blocked_pending_purchase_simulation");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(
    expect.stringContaining("consulta de factibilidad de compra pendiente")
  );
  expect(await db.pendingDeletion.count()).toBe(0);
});

test("handleDeleteReply 'sí' while confirming calls deleteNoteCascading with the right noteId, clears PendingDeletion, sends a success message", async () => {
  const note = await seedNote({ rawText: "idea de la app de libros" });
  await db.pendingDeletion.create({
    data: { stage: "confirming", noteIds: JSON.stringify([note.id]) },
  });

  const outcome = await handleDeleteReply("sí");

  expect(outcome).toBe("deleted");
  expect(mockDeleteNoteCascading).toHaveBeenCalledWith(note.id);
  expect(await db.pendingDeletion.count()).toBe(0);
  expect(mockSendSelfMessage).toHaveBeenCalled();
});

test("handleDeleteReply 'no' while confirming clears PendingDeletion and sends a cancellation message", async () => {
  const note = await seedNote();
  await db.pendingDeletion.create({
    data: { stage: "confirming", noteIds: JSON.stringify([note.id]) },
  });

  const outcome = await handleDeleteReply("no");

  expect(outcome).toBe("rejected");
  expect(mockDeleteNoteCascading).not.toHaveBeenCalled();
  expect(await db.pendingDeletion.count()).toBe(0);
  expect(mockSendSelfMessage).toHaveBeenCalled();
});

test("handleDeleteReply when deleteNoteCascading returns 'calendar_delete_failed' clears PendingDeletion and sends a retry message, outcome 'calendar_failed'", async () => {
  const note = await seedNote({ type: "recordatorio" });
  mockDeleteNoteCascading.mockResolvedValueOnce("calendar_delete_failed");
  await db.pendingDeletion.create({
    data: { stage: "confirming", noteIds: JSON.stringify([note.id]) },
  });

  const outcome = await handleDeleteReply("sí");

  expect(outcome).toBe("calendar_failed");
  expect(await db.pendingDeletion.count()).toBe(0);
  const message = mockSendSelfMessage.mock.calls[0]![0] as string;
  expect(message.toLowerCase()).toContain("no pude");
});

test("handleDeleteReply 'sí' when the target note was already deleted elsewhere still succeeds gracefully (deleteNoteCascading's own idempotent 'deleted' return), clears PendingDeletion", async () => {
  mockDeleteNoteCascading.mockResolvedValueOnce("deleted"); // mismo valor que si nunca hubiese existido
  await db.pendingDeletion.create({
    data: { stage: "confirming", noteIds: JSON.stringify(["already-gone-note-id"]) },
  });

  const outcome = await handleDeleteReply("sí");

  expect(outcome).toBe("deleted");
  expect(await db.pendingDeletion.count()).toBe(0);
  expect(mockSendSelfMessage).toHaveBeenCalled();
});

test("handleDeleteReply with a valid number while disambiguating narrows to that one candidate and re-asks for confirmation (stage becomes 'confirming')", async () => {
  const note1 = await seedNote({ rawText: "idea sobre libros de cocina" });
  const note2 = await seedNote({ rawText: "idea sobre libros de historia" });
  await db.pendingDeletion.create({
    data: { stage: "disambiguating", noteIds: JSON.stringify([note1.id, note2.id]) },
  });

  const outcome = await handleDeleteReply("2");

  expect(outcome).toBe("disambiguated");
  const pending = await db.pendingDeletion.findFirst();
  expect(pending?.stage).toBe("confirming");
  expect(JSON.parse(pending!.noteIds)).toEqual([note2.id]);
  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining('"idea sobre libros de historia"'));
  expect(mockDeleteNoteCascading).not.toHaveBeenCalled();
});

test("handleDeleteReply with 'ninguna' while disambiguating clears PendingDeletion and sends a cancellation message", async () => {
  const note1 = await seedNote({ rawText: "idea sobre libros de cocina" });
  const note2 = await seedNote({ rawText: "idea sobre libros de historia" });
  await db.pendingDeletion.create({
    data: { stage: "disambiguating", noteIds: JSON.stringify([note1.id, note2.id]) },
  });

  const outcome = await handleDeleteReply("ninguna");

  expect(outcome).toBe("rejected");
  expect(await db.pendingDeletion.count()).toBe(0);
  expect(mockDeleteNoteCascading).not.toHaveBeenCalled();
  expect(mockSendSelfMessage).toHaveBeenCalled();
});

test("handleDeleteReply with unrelated text returns 'unrecognized' and leaves the PendingDeletion untouched", async () => {
  const note = await seedNote();
  await db.pendingDeletion.create({
    data: { stage: "confirming", noteIds: JSON.stringify([note.id]) },
  });
  mockSendSelfMessage.mockClear();

  const outcome = await handleDeleteReply("no entiendo qué me preguntás");

  expect(outcome).toBe("unrecognized");
  expect(mockSendSelfMessage).not.toHaveBeenCalled();
  expect(mockDeleteNoteCascading).not.toHaveBeenCalled();
  const pending = await db.pendingDeletion.findFirst();
  expect(pending?.stage).toBe("confirming");
});

test("handleDeleteReply with a number out of range while disambiguating returns 'unrecognized' and leaves PendingDeletion untouched", async () => {
  const note1 = await seedNote({ rawText: "idea sobre libros de cocina" });
  const note2 = await seedNote({ rawText: "idea sobre libros de historia" });
  await db.pendingDeletion.create({
    data: { stage: "disambiguating", noteIds: JSON.stringify([note1.id, note2.id]) },
  });
  mockSendSelfMessage.mockClear();

  const outcome = await handleDeleteReply("5");

  expect(outcome).toBe("unrecognized");
  const pending = await db.pendingDeletion.findFirst();
  expect(pending?.stage).toBe("disambiguating");
  expect(mockSendSelfMessage).not.toHaveBeenCalled();
});

test("handleDeleteReply with no PendingDeletion at all returns 'no_pending'", async () => {
  const outcome = await handleDeleteReply("sí");

  expect(outcome).toBe("no_pending");
  expect(mockDeleteNoteCascading).not.toHaveBeenCalled();
});

// A Reminder queued behind an open delete confirmation must be
// promoted as soon as that PendingDeletion row is cleared — otherwise it
// sits silently in "queued" until some unrelated event happens to call
// promptNextIfIdle. The queued Reminder needs a real future parsedDatetime
// (reminderRowData/enqueueReminder never leave a "queued" row without one),
// and promptNextIfIdle's own call chain (claimNextQueuedReminder +
// confirmationPrompt) never touches Google Calendar — only
// handleConfirmationReply's confirm branch does that — so no
// createCalendarEvent mock is needed here.
test("handleDeleteReply 'sí' promotes a Reminder queued behind the PendingDeletion once it's cleared", async () => {
  const deleteNote = await seedNote({ type: "idea", rawText: "idea de la app de libros" });
  const reminderNote = await seedNote({ type: "recordatorio", rawText: "turno con el dentista" });
  const queuedReminder = await db.reminder.create({
    data: {
      noteId: reminderNote.id,
      parsedDatetime: new Date("2026-11-04T15:00:00-03:00"),
      status: "queued",
      calendarEventId: null,
    },
  });
  await db.pendingDeletion.create({
    data: { stage: "confirming", noteIds: JSON.stringify([deleteNote.id]) },
  });

  const outcome = await handleDeleteReply("sí");

  expect(outcome).toBe("deleted");
  const promoted = await db.reminder.findUnique({ where: { id: queuedReminder.id } });
  expect(promoted?.status).toBe("awaiting_confirmation");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining("Listo, la borré."));
  expect(mockSendSelfMessage).toHaveBeenCalledWith(
    expect.stringContaining('"turno con el dentista"')
  );
});

test("resendPendingDeletePrompt re-sends the confirmation prompt when stage is 'confirming'", async () => {
  const note = await seedNote({ rawText: "idea de la app de libros" });
  await db.pendingDeletion.create({
    data: { stage: "confirming", noteIds: JSON.stringify([note.id]) },
  });

  await resendPendingDeletePrompt();

  expect(mockSendSelfMessage).toHaveBeenCalledWith(
    expect.stringContaining('"idea de la app de libros"')
  );
});

test("resendPendingDeletePrompt re-sends the disambiguation list when stage is 'disambiguating'", async () => {
  const note1 = await seedNote({ rawText: "idea sobre libros de cocina" });
  const note2 = await seedNote({ rawText: "idea sobre libros de historia" });
  await db.pendingDeletion.create({
    data: { stage: "disambiguating", noteIds: JSON.stringify([note1.id, note2.id]) },
  });

  await resendPendingDeletePrompt();

  const message = mockSendSelfMessage.mock.calls[0]![0] as string;
  expect(message).toContain("1.");
  expect(message).toContain("2.");
});

test("resendPendingDeletePrompt never throws when nothing is pending", async () => {
  await expect(resendPendingDeletePrompt()).resolves.toBeUndefined();
  expect(mockSendSelfMessage).not.toHaveBeenCalled();
});

test("resendPendingDeletePrompt never throws when sendSelfMessage fails", async () => {
  const note = await seedNote();
  await db.pendingDeletion.create({
    data: { stage: "confirming", noteIds: JSON.stringify([note.id]) },
  });
  mockSendSelfMessage.mockRejectedValueOnce(new Error("socket closed"));

  await expect(resendPendingDeletePrompt()).resolves.toBeUndefined();
});
