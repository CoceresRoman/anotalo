import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import db from "../db";

// End-to-end through the REAL router -> reminders state machine -> persist
// path. Only the outside world is mocked: the LLM (classify/query), Whisper,
// the WhatsApp send, and Google Calendar. These are the anti-goal scenarios
// from the final whole-branch review traced across module boundaries.
const mockClassifyMessage = vi.hoisted(() => vi.fn());
const mockTranscribeAudio = vi.hoisted(() => vi.fn());
const mockAnswerQuery = vi.hoisted(() => vi.fn());
const mockSendSelfMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCreateCalendarEvent = vi.hoisted(() => vi.fn().mockResolvedValue("evt-1"));
// Defaults to true so these end-to-end tests keep exercising the
// "Calendar is configured" path unchanged (same default as
// reminders.test.ts, which added this mock first).
const mockIsGoogleCalendarConfigured = vi.hoisted(() => vi.fn().mockReturnValue(true));

vi.mock("./classify", () => ({ classifyMessage: mockClassifyMessage }));
vi.mock("./transcribe", () => ({ transcribeAudio: mockTranscribeAudio }));
vi.mock("./query", () => ({ answerQuery: mockAnswerQuery }));
vi.mock("./connection", () => ({ sendSelfMessage: mockSendSelfMessage }));
vi.mock("../calendar", () => ({
  createCalendarEvent: mockCreateCalendarEvent,
  isGoogleCalendarConfigured: mockIsGoogleCalendarConfigured,
}));

import { enqueueReminder } from "./reminders";
import { handleIncomingMessage } from "./router";

async function seedPendingReminder(rawText = "turno con el dentista") {
  const note = await db.note.create({
    data: { rawText, source: "text", type: "recordatorio", whatsappMessageId: randomUUID() },
  });
  await enqueueReminder(note.id, new Date("2026-11-04T15:00:00-03:00"));
  const reminder = await db.reminder.findUniqueOrThrow({ where: { noteId: note.id } });
  expect(reminder.status).toBe("awaiting_confirmation");
  return reminder;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
  await db.processedMessage.deleteMany();
  await db.expense.deleteMany();
  await db.reminder.deleteMany();
  await db.note.deleteMany();
  mockClassifyMessage.mockReset();
  mockTranscribeAudio.mockReset();
  mockAnswerQuery.mockReset();
  mockSendSelfMessage.mockReset().mockResolvedValue(undefined);
  mockCreateCalendarEvent.mockReset().mockResolvedValue("evt-1");
});

afterEach(() => {
  vi.useRealTimers();
});

test("'café 3200' arriving while a reminder awaits confirmation creates its Expense AND re-sends the confirmation prompt", async () => {
  const reminder = await seedPendingReminder();
  mockSendSelfMessage.mockClear();
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
  expect(note?.expense?.currency).toBe("ARS");
  expect(mockSendSelfMessage).toHaveBeenCalledTimes(1);
  expect(mockSendSelfMessage).toHaveBeenCalledWith(
    'Entendí: "turno con el dentista" para el 04/11/2026 a las 15:00, ¿va? (respondé sí/no)'
  );
  // The pending reminder is untouched and no event was created.
  expect((await db.reminder.findUnique({ where: { id: reminder.id } }))?.status).toBe("awaiting_confirmation");
  expect(mockCreateCalendarEvent).not.toHaveBeenCalled();
});

test("A new recordatorio arriving while another is pending is persisted and queued; the pending prompt is re-sent, and the new one is prompted after 'sí'", async () => {
  await seedPendingReminder("primero");
  mockSendSelfMessage.mockClear();
  mockClassifyMessage.mockResolvedValueOnce({
    intent: "capture",
    noteType: "recordatorio",
    parsedDatetime: "2026-11-06T09:00:00-03:00",
  });

  await handleIncomingMessage("recordame el viernes a las 9 llamar al banco", "wa-second", "text");

  const second = await db.note.findUnique({ where: { whatsappMessageId: "wa-second" }, include: { reminder: true } });
  expect(second?.reminder?.status).toBe("queued");
  expect(mockSendSelfMessage).toHaveBeenCalledTimes(1);
  expect(mockSendSelfMessage).toHaveBeenLastCalledWith(expect.stringContaining('"primero"'));

  await handleIncomingMessage("sí", "wa-yes", "text");
  expect(mockCreateCalendarEvent).toHaveBeenCalledTimes(1);
  expect(mockCreateCalendarEvent).toHaveBeenCalledWith("primero", new Date("2026-11-04T15:00:00-03:00"));
  expect(mockSendSelfMessage).toHaveBeenLastCalledWith(
    'Entendí: "recordame el viernes a las 9 llamar al banco" para el 06/11/2026 a las 09:00, ¿va? (respondé sí/no)'
  );
});

test("A Calendar failure on 'sí' is reported over WhatsApp and a later 'sí' retries it", async () => {
  const reminder = await seedPendingReminder();
  mockSendSelfMessage.mockClear();
  mockCreateCalendarEvent.mockRejectedValueOnce(new Error("Calendar API 503"));
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  await handleIncomingMessage("sí", "wa-yes-1", "text");

  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining("No pude crear el evento"));
  expect((await db.reminder.findUnique({ where: { id: reminder.id } }))?.status).toBe("awaiting_confirmation");
  // The "sí" itself is never turned into a note.
  expect(await db.note.findUnique({ where: { whatsappMessageId: "wa-yes-1" } })).toBeNull();

  await handleIncomingMessage("sí", "wa-yes-2", "text");
  const after = await db.reminder.findUnique({ where: { id: reminder.id } });
  expect(after?.status).toBe("confirmed");
  expect(after?.calendarEventId).toBe("evt-1");
  errorSpy.mockRestore();
});

test("Replaying the same confirmation reply (same waMessageId) never confirms a second, later-prompted reminder", async () => {
  await seedPendingReminder("primero");
  const secondNote = await db.note.create({
    data: { rawText: "segundo", source: "text", type: "recordatorio", whatsappMessageId: randomUUID() },
  });
  await enqueueReminder(secondNote.id, new Date("2026-11-05T10:00:00-03:00"));

  await handleIncomingMessage("sí", "wa-yes-replayed", "text");
  // The second reminder is now the one awaiting confirmation; a redelivery
  // of the very same "sí" must not be read as confirming it.
  await handleIncomingMessage("sí", "wa-yes-replayed", "text");

  expect(mockCreateCalendarEvent).toHaveBeenCalledTimes(1);
  expect((await db.reminder.findUnique({ where: { noteId: secondNote.id } }))?.status).toBe(
    "awaiting_confirmation"
  );
});

test("The same capture delivered twice creates one Note", async () => {
  mockClassifyMessage.mockResolvedValue({ intent: "capture", noteType: "idea" });

  await handleIncomingMessage("una idea", "wa-cap-dup", "text");
  await handleIncomingMessage("una idea", "wa-cap-dup", "text");

  expect(await db.note.count({ where: { whatsappMessageId: "wa-cap-dup" } })).toBe(1);
  expect(mockClassifyMessage).toHaveBeenCalledTimes(1);
});

test("Two different 'sí' messages processed concurrently create exactly one Calendar event", async () => {
  await seedPendingReminder();
  mockCreateCalendarEvent.mockImplementation(
    () => new Promise((resolve) => setTimeout(() => resolve("evt-once"), 30))
  );
  // Depending on scheduling, the losing reply may only be looked at after
  // the reminder is fully resolved — then it's an ordinary message with
  // nothing pending and gets classified like any other.
  mockClassifyMessage.mockResolvedValue({ intent: "capture", noteType: "no_identificado" });

  await Promise.all([
    handleIncomingMessage("sí", "wa-yes-a", "text"),
    handleIncomingMessage("dale", "wa-yes-b", "text"),
  ]);

  expect(mockCreateCalendarEvent).toHaveBeenCalledTimes(1);
});

test("An audio whose download failed (no buffer) is persisted as a no_identificado placeholder even while a reminder is pending, and never confirms it", async () => {
  const reminder = await seedPendingReminder();

  await handleIncomingMessage(null, "wa-audio-lost", "audio", undefined);

  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-audio-lost" } });
  expect(note?.type).toBe("no_identificado");
  expect(note?.rawText).toBe("[audio no transcribible]");
  expect((await db.reminder.findUnique({ where: { id: reminder.id } }))?.status).toBe("awaiting_confirmation");
  expect(mockCreateCalendarEvent).not.toHaveBeenCalled();
});

// Prefix-only matching would turn these ordinary messages into a confirm
// (Calendar event the user never approved) or a reject (reminder discarded AND
// the message itself never saved). They must instead be classified and
// persisted like any other message, with the open prompt re-sent.
test.each([
  "si llueve llevar paraguas",
  "ok comprar leche",
  "dale que va: cena con Juan el viernes",
  "no olvidar pagar la luz",
  "mal día, gasté 5000 en taxi",
])("a message that only STARTS with a yes/no word (%s) is saved as a note, never confirms/rejects the pending reminder", async (text) => {
  const reminder = await seedPendingReminder();
  mockSendSelfMessage.mockClear();
  mockClassifyMessage.mockResolvedValueOnce({ intent: "capture", noteType: "idea" });

  await handleIncomingMessage(text, "wa-prefix", "text");

  expect(mockCreateCalendarEvent).not.toHaveBeenCalled();
  expect(mockClassifyMessage).toHaveBeenCalledWith(text, expect.any(String));
  const note = await db.note.findUnique({ where: { whatsappMessageId: "wa-prefix" } });
  expect(note?.rawText).toBe(text);
  expect((await db.reminder.findUnique({ where: { id: reminder.id } }))?.status).toBe("awaiting_confirmation");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining("¿va? (respondé sí/no)"));
});
