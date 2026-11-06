import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import db from "../db";

// enqueueReminder/handleConfirmationReply's only two external dependencies:
// sendSelfMessage (real WhatsApp send) and createCalendarEvent
// (this task's own calendar.ts, real Google Calendar API call) — both
// mocked so these tests assert the queueing/confirmation state machine
// itself, never touching WhatsApp or Google.
const mockSendSelfMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCreateCalendarEvent = vi.hoisted(() => vi.fn().mockResolvedValue("evt-default"));
// Defaults to true so every pre-existing test below (written before the
// made Calendar optional) keeps exercising the "Calendar is configured"
// path unchanged; only the new tests below flip it to false.
const mockIsGoogleCalendarConfigured = vi.hoisted(() => vi.fn().mockReturnValue(true));

vi.mock("./connection", () => ({ sendSelfMessage: mockSendSelfMessage }));
vi.mock("../calendar", () => ({
  createCalendarEvent: mockCreateCalendarEvent,
  isGoogleCalendarConfigured: mockIsGoogleCalendarConfigured,
}));

import {
  enqueueReminder,
  handleConfirmationReply,
  resendPendingPrompt,
  resumeReminderQueue,
} from "./reminders";

async function seedNote({
  type = "recordatorio",
  rawText = "turno con el dentista",
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

let originalTz: string | undefined;

beforeEach(async () => {
  // Only Date is faked (timers stay real so Prisma isn't affected): pins
  // "now" so the fixtures' late-Oct/early-Nov 2026 datetimes stay in the
  // future — enqueueReminder rejects past datetimes.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
  originalTz = process.env.TZ;
  await db.expense.deleteMany();
  await db.pendingDeletion.deleteMany();
  await db.pendingCuotaPayment.deleteMany();
  await db.pendingPurchaseSimulation.deleteMany();
  await db.reminder.deleteMany();
  await db.note.deleteMany();
  mockSendSelfMessage.mockReset().mockResolvedValue(undefined);
  mockCreateCalendarEvent.mockReset().mockResolvedValue("evt-default");
  mockIsGoogleCalendarConfigured.mockReset().mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

test("enqueueReminder sends a confirmation prompt immediately when nothing else is pending", async () => {
  const note = await seedNote({ type: "recordatorio", rawText: "turno con el dentista" });

  await enqueueReminder(note.id, new Date("2026-10-31T15:00:00Z"));

  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining("31/10"));
  const reminder = await db.reminder.findUnique({ where: { noteId: note.id } });
  expect(reminder?.status).toBe("awaiting_confirmation");
});

test("enqueueReminder creates an ambiguous_no_date Reminder and never prompts when parsedDatetime is null", async () => {
  const note = await seedNote({ rawText: "recordame algo" });

  await enqueueReminder(note.id, null);

  const reminder = await db.reminder.findUnique({ where: { noteId: note.id } });
  expect(reminder?.status).toBe("ambiguous_no_date");
  expect(reminder?.parsedDatetime).toBeNull();
  expect(mockSendSelfMessage).not.toHaveBeenCalled();
});

test("a second reminder created while the first awaits confirmation stays queued, and is prompted only after the first resolves", async () => {
  const note1 = await seedNote({ type: "recordatorio" });
  const note2 = await seedNote({ type: "recordatorio" });

  await enqueueReminder(note1.id, new Date("2026-10-31T15:00:00Z"));
  await enqueueReminder(note2.id, new Date("2026-11-04T10:00:00Z"));

  const reminder2Before = await db.reminder.findUnique({ where: { noteId: note2.id } });
  expect(reminder2Before?.status).toBe("queued");
  // Only one sendSelfMessage so far (the first reminder's prompt) — the
  // second must not get its own prompt while the first is still pending.
  expect(mockSendSelfMessage).toHaveBeenCalledTimes(1);

  await handleConfirmationReply("sí");

  const reminder2After = await db.reminder.findUnique({ where: { noteId: note2.id } });
  expect(reminder2After?.status).toBe("awaiting_confirmation");
  expect(mockSendSelfMessage).toHaveBeenCalledTimes(2);
  expect(mockSendSelfMessage).toHaveBeenNthCalledWith(2, expect.stringContaining("04/11"));
});

test("handleConfirmationReply returns no_pending when nothing is awaiting confirmation", async () => {
  const result = await handleConfirmationReply("sí");
  expect(result).toBe("no_pending");
  expect(mockCreateCalendarEvent).not.toHaveBeenCalled();
});

test("handleConfirmationReply confirms on 'sí', creates the Calendar event, and stores its id", async () => {
  const note = await seedNote({ rawText: "turno con el dentista" });
  mockCreateCalendarEvent.mockResolvedValueOnce("evt-abc");
  await enqueueReminder(note.id, new Date("2026-10-31T15:00:00Z"));

  const result = await handleConfirmationReply("sí");

  expect(result).toBe("confirmed");
  expect(mockCreateCalendarEvent).toHaveBeenCalledWith(
    "turno con el dentista",
    new Date("2026-10-31T15:00:00Z")
  );
  const reminder = await db.reminder.findUnique({ where: { noteId: note.id } });
  expect(reminder?.status).toBe("confirmed");
  expect(reminder?.calendarEventId).toBe("evt-abc");
});

test("handleConfirmationReply accepts other confirm synonyms (dale, correcto, ok), case-insensitively", async () => {
  for (const [reply, rawText] of [
    ["dale", "nota 1"],
    ["Correcto", "nota 2"],
    ["OK", "nota 3"],
  ] as const) {
    const note = await seedNote({ rawText });
    await enqueueReminder(note.id, new Date("2026-10-31T15:00:00Z"));
    const result = await handleConfirmationReply(reply);
    expect(result).toBe("confirmed");
  }
});

// A fresh clone with no GOOGLE_CLIENT_ID/SECRET must
// never get stuck in a createCalendarEvent retry loop just because nobody
// set up Calendar credentials yet — confirming still works, it just skips
// Calendar entirely (and skips the short-lived "confirming" status too).
test("confirming a reminder without Google credentials never calls createCalendarEvent, saves it directly as confirmed, and tells the user it wasn't synced", async () => {
  const note = await seedNote({ rawText: "turno con el dentista" });
  await enqueueReminder(note.id, new Date("2026-10-31T15:00:00Z"));
  mockIsGoogleCalendarConfigured.mockReturnValue(false);
  mockSendSelfMessage.mockClear();

  const result = await handleConfirmationReply("sí");

  expect(result).toBe("confirmed_no_calendar");
  expect(mockCreateCalendarEvent).not.toHaveBeenCalled();
  const reminder = await db.reminder.findUnique({ where: { noteId: note.id } });
  expect(reminder?.status).toBe("confirmed");
  expect(reminder?.calendarEventId).toBeNull();
  expect(mockSendSelfMessage).toHaveBeenCalledTimes(1);
  const notice = mockSendSelfMessage.mock.calls[0]![0] as string;
  expect(notice).toContain("turno con el dentista");
});

// Regression: with credentials configured, behavior is exactly as before
// this task (Calendar is still called, outcome is still "confirmed").
test("confirming a reminder with Google credentials still calls createCalendarEvent as before", async () => {
  const note = await seedNote({ rawText: "turno con el dentista" });
  mockCreateCalendarEvent.mockResolvedValueOnce("evt-ok");
  await enqueueReminder(note.id, new Date("2026-10-31T15:00:00Z"));
  mockIsGoogleCalendarConfigured.mockReturnValue(true);

  const result = await handleConfirmationReply("sí");

  expect(result).toBe("confirmed");
  expect(mockCreateCalendarEvent).toHaveBeenCalledTimes(1);
  const reminder = await db.reminder.findUnique({ where: { noteId: note.id } });
  expect(reminder?.status).toBe("confirmed");
  expect(reminder?.calendarEventId).toBe("evt-ok");
});

test("handleConfirmationReply rejects on 'no', never creates a Calendar event, and the anti-goal holds: no event without explicit confirmation", async () => {
  const note = await seedNote({ rawText: "turno con el dentista" });
  await enqueueReminder(note.id, new Date("2026-10-31T15:00:00Z"));

  const result = await handleConfirmationReply("no");

  expect(result).toBe("rejected");
  expect(mockCreateCalendarEvent).not.toHaveBeenCalled();
  const reminder = await db.reminder.findUnique({ where: { noteId: note.id } });
  expect(reminder?.status).toBe("rejected");
  expect(reminder?.calendarEventId).toBeNull();
});

test("handleConfirmationReply accepts other reject synonyms (mal, incorrecto), case-insensitively", async () => {
  for (const [reply, rawText] of [
    ["Mal", "nota 1"],
    ["incorrecto", "nota 2"],
  ] as const) {
    const note = await seedNote({ rawText });
    await enqueueReminder(note.id, new Date("2026-10-31T15:00:00Z"));
    const result = await handleConfirmationReply(reply);
    expect(result).toBe("rejected");
  }
});

// An unrecognized reply is NOT an answer to the prompt — it's a new
// message that the router must still classify/persist. handleConfirmationReply
// therefore only reports "unrecognized" and leaves the reminder untouched;
// the router re-sends the prompt (via resendPendingPrompt) *after* the
// message itself has been persisted.
test("handleConfirmationReply leaves the reminder awaiting_confirmation and sends nothing on an unrecognized reply; resendPendingPrompt re-sends the same prompt", async () => {
  const note = await seedNote({ rawText: "turno con el dentista" });
  await enqueueReminder(note.id, new Date("2026-10-31T15:00:00Z"));
  mockSendSelfMessage.mockClear();

  const result = await handleConfirmationReply("ehh no entiendo qué me preguntás");

  expect(result).toBe("unrecognized");
  expect(mockSendSelfMessage).not.toHaveBeenCalled();
  expect(mockCreateCalendarEvent).not.toHaveBeenCalled();
  const reminder = await db.reminder.findUnique({ where: { noteId: note.id } });
  expect(reminder?.status).toBe("awaiting_confirmation");

  await resendPendingPrompt();
  expect(mockSendSelfMessage).toHaveBeenCalledTimes(1);
  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining("31/10/2026"));
});

test("handleConfirmationReply never creates a Calendar event for a reply that merely contains 'sí' mid-sentence (anchored match only)", async () => {
  const note = await seedNote({ rawText: "turno con el dentista" });
  await enqueueReminder(note.id, new Date("2026-10-31T15:00:00Z"));

  // Not a bare yes/no either (the whole message must be the token): it
  // falls through to "unrecognized" — saved as a note, prompt re-sent.
  const result = await handleConfirmationReply("no sé si va");

  expect(result).toBe("unrecognized");
  expect(mockCreateCalendarEvent).not.toHaveBeenCalled();
});

test("handleConfirmationReply does NOT treat 'ok2' or 'dale_algo' as confirm (digits/underscore right after the word are not a boundary, matching the brief's \\b exactly)", async () => {
  const note1 = await seedNote({ rawText: "nota ok2" });
  await enqueueReminder(note1.id, new Date("2026-10-31T15:00:00Z"));
  const resultOk2 = await handleConfirmationReply("ok2");
  expect(resultOk2).toBe("unrecognized");
  expect(mockCreateCalendarEvent).not.toHaveBeenCalled();

  // Resolve it (so the next enqueueReminder's prompt isn't swallowed by
  // this still-pending one) before checking the second case.
  await handleConfirmationReply("no");

  const note2 = await seedNote({ rawText: "nota dale_algo" });
  await enqueueReminder(note2.id, new Date("2026-10-31T15:00:00Z"));
  const resultDaleUnderscore = await handleConfirmationReply("dale_algo");
  expect(resultDaleUnderscore).toBe("unrecognized");
  expect(mockCreateCalendarEvent).not.toHaveBeenCalled();
});

test("two concurrent enqueueReminder calls never leave more than one reminder awaiting_confirmation (atomic claim under concurrency)", async () => {
  // Dispatched together via Promise.all (not one awaited before the next
  // starts) to actually exercise the race window a plain "check if anyone
  // is awaiting, then separately act" sequence would have — this is the
  // scenario from the task review: enqueueReminder is called both from the
  // sequential WhatsApp message loop AND from a separate HTTP route
  // (src/app/api/sin-clasificar/[id]/route.ts) that isn't serialized
  // against it, so two overlapping calls are a real possibility, not just
  // a theoretical one.
  const note1 = await seedNote({ type: "recordatorio", rawText: "primero" });
  const note2 = await seedNote({ type: "recordatorio", rawText: "segundo" });

  await Promise.all([
    enqueueReminder(note1.id, new Date("2026-10-31T15:00:00Z")),
    enqueueReminder(note2.id, new Date("2026-11-04T10:00:00Z")),
  ]);

  const reminders = await db.reminder.findMany();
  const awaiting = reminders.filter((r) => r.status === "awaiting_confirmation");
  const queued = reminders.filter((r) => r.status === "queued");

  // Exactly one of the two wins the race (whichever is nondeterministic —
  // that's fine); the invariant under test is that it's never both and
  // never neither.
  expect(awaiting).toHaveLength(1);
  expect(queued).toHaveLength(1);
  expect(mockSendSelfMessage).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// Final-review fixes
// ---------------------------------------------------------------------------

// The prompt names the reminder, carries the full year, and renders
// Argentina wall-clock time even when the server's own clock is UTC (the
// production VM) or anything else — today's suite used to run only on a
// machine already in ART, which is how the local-clock bug shipped.
for (const tz of ["UTC", "Asia/Tokyo", "America/Argentina/Buenos_Aires"]) {
  test(`the confirmation prompt identifies the reminder and shows Argentina time with the year (server TZ=${tz})`, async () => {
    process.env.TZ = tz;
    const note = await seedNote({ rawText: "turno con el dentista" });

    await enqueueReminder(note.id, new Date("2026-11-04T15:00:00-03:00"));

    expect(mockSendSelfMessage).toHaveBeenCalledWith(
      'Entendí: "turno con el dentista" para el 04/11/2026 a las 15:00, ¿va? (respondé sí/no)'
    );
  });
}

test("A Calendar write failure on 'sí' tells the user by WhatsApp and leaves the reminder retryable (back to awaiting_confirmation)", async () => {
  const note = await seedNote({ rawText: "turno con el dentista" });
  await enqueueReminder(note.id, new Date("2026-11-04T15:00:00-03:00"));
  mockSendSelfMessage.mockClear();
  mockCreateCalendarEvent.mockRejectedValueOnce(new Error("invalid_grant"));

  const result = await handleConfirmationReply("sí");

  expect(result).toBe("calendar_failed");
  const reminder = await db.reminder.findUnique({ where: { noteId: note.id } });
  expect(reminder?.status).toBe("awaiting_confirmation");
  expect(reminder?.calendarEventId).toBeNull();
  expect(mockSendSelfMessage).toHaveBeenCalledTimes(1);
  const failureMessage = mockSendSelfMessage.mock.calls[0]![0] as string;
  expect(failureMessage).toContain("No pude crear el evento");
  expect(failureMessage).toContain("turno con el dentista");
  expect(failureMessage).toContain("invalid_grant");

  // Retry: a later "sí" (Calendar healthy again) confirms it for real.
  mockCreateCalendarEvent.mockResolvedValueOnce("evt-retry");
  expect(await handleConfirmationReply("sí")).toBe("confirmed");
  const after = await db.reminder.findUnique({ where: { noteId: note.id } });
  expect(after?.status).toBe("confirmed");
  expect(after?.calendarEventId).toBe("evt-retry");
});

test("A Calendar failure still resolves cleanly even if the failure notice itself can't be sent", async () => {
  const note = await seedNote();
  await enqueueReminder(note.id, new Date("2026-11-04T15:00:00-03:00"));
  mockCreateCalendarEvent.mockRejectedValueOnce(new Error("calendar down"));
  mockSendSelfMessage.mockRejectedValueOnce(new Error("socket closed"));

  await expect(handleConfirmationReply("sí")).resolves.toBe("calendar_failed");
  const reminder = await db.reminder.findUnique({ where: { noteId: note.id } });
  expect(reminder?.status).toBe("awaiting_confirmation");
});

test("Two concurrent 'sí' replies for the same pending reminder create exactly one Calendar event", async () => {
  const note = await seedNote();
  await enqueueReminder(note.id, new Date("2026-11-04T15:00:00-03:00"));
  // A slow Calendar call widens the race window the old ordering
  // (create the event first, claim afterwards) was vulnerable to.
  mockCreateCalendarEvent.mockImplementation(
    () => new Promise((resolve) => setTimeout(() => resolve("evt-once"), 30))
  );

  const results = await Promise.all([handleConfirmationReply("sí"), handleConfirmationReply("dale")]);

  expect(mockCreateCalendarEvent).toHaveBeenCalledTimes(1);
  expect(results.filter((r) => r === "confirmed")).toHaveLength(1);
  // The loser either lost the atomic claim / saw it mid-confirmation
  // ("already_resolved") or, if scheduled late enough, found nothing
  // pending at all — never a second Calendar call either way.
  expect(results.filter((r) => r === "already_resolved" || r === "no_pending")).toHaveLength(1);
  const reminder = await db.reminder.findUnique({ where: { noteId: note.id } });
  expect(reminder?.status).toBe("confirmed");
  expect(reminder?.calendarEventId).toBe("evt-once");
});

test("A reminder enqueued while another is mid-confirmation (Calendar call in flight) is NOT prompted until that one resolves", async () => {
  const note1 = await seedNote({ rawText: "primero" });
  const note2 = await seedNote({ rawText: "segundo" });
  await enqueueReminder(note1.id, new Date("2026-11-04T15:00:00-03:00"));
  let finishCalendar: (id: string) => void = () => {};
  mockCreateCalendarEvent.mockImplementationOnce(
    () => new Promise<string>((resolve) => (finishCalendar = resolve))
  );

  const confirming = handleConfirmationReply("sí");
  await vi.waitFor(() => expect(mockCreateCalendarEvent).toHaveBeenCalledTimes(1));
  mockSendSelfMessage.mockClear();

  await enqueueReminder(note2.id, new Date("2026-11-05T10:00:00-03:00"));
  expect((await db.reminder.findUnique({ where: { noteId: note2.id } }))?.status).toBe("queued");
  expect(mockSendSelfMessage).not.toHaveBeenCalled();

  finishCalendar("evt-1");
  expect(await confirming).toBe("confirmed");
  expect((await db.reminder.findUnique({ where: { noteId: note2.id } }))?.status).toBe(
    "awaiting_confirmation"
  );
  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining('"segundo"'));
});

test("enqueueReminder treats a past datetime as having no usable date (ambiguous_no_date, never prompted)", async () => {
  const note = await seedNote();

  await enqueueReminder(note.id, new Date("2026-10-20T15:00:00-03:00"));

  const reminder = await db.reminder.findUnique({ where: { noteId: note.id } });
  expect(reminder?.status).toBe("ambiguous_no_date");
  expect(reminder?.parsedDatetime).toBeNull();
  expect(mockSendSelfMessage).not.toHaveBeenCalled();
});

test("enqueueReminder never hands an Invalid Date to Prisma", async () => {
  const note = await seedNote();

  await enqueueReminder(note.id, new Date("not a date"));

  const reminder = await db.reminder.findUnique({ where: { noteId: note.id } });
  expect(reminder?.status).toBe("ambiguous_no_date");
  expect(reminder?.parsedDatetime).toBeNull();
});

test("enqueueReminder does not throw when the prompt can't be sent (e.g. WhatsApp disconnected); the reminder stays queued for later", async () => {
  const note = await seedNote();
  mockSendSelfMessage.mockRejectedValueOnce(new Error("not connected"));

  await expect(enqueueReminder(note.id, new Date("2026-11-04T15:00:00-03:00"))).resolves.toBeUndefined();

  const reminder = await db.reminder.findUnique({ where: { noteId: note.id } });
  expect(reminder?.status).toBe("queued");
});

test("resumeReminderQueue prompts a reminder stranded in 'queued' while the bot was disconnected", async () => {
  const note = await seedNote({ rawText: "creado desde la webapp" });
  mockSendSelfMessage.mockRejectedValueOnce(new Error("not connected"));
  await enqueueReminder(note.id, new Date("2026-11-04T15:00:00-03:00"));
  mockSendSelfMessage.mockClear();

  await resumeReminderQueue();

  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining('"creado desde la webapp"'));
  expect((await db.reminder.findUnique({ where: { noteId: note.id } }))?.status).toBe(
    "awaiting_confirmation"
  );
});

test("resumeReminderQueue recovers a reminder stuck mid-confirmation by a crash, back to awaiting_confirmation, and re-prompts it", async () => {
  const note = await seedNote({ rawText: "quedó colgado" });
  await db.reminder.create({
    data: {
      noteId: note.id,
      parsedDatetime: new Date("2026-11-04T15:00:00-03:00"),
      status: "confirming",
      calendarEventId: null,
    },
  });

  await resumeReminderQueue();

  expect((await db.reminder.findUnique({ where: { noteId: note.id } }))?.status).toBe(
    "awaiting_confirmation"
  );
  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining('"quedó colgado"'));
  expect(mockCreateCalendarEvent).not.toHaveBeenCalled();
});

// The confirm/reject match must cover the WHOLE trimmed message (only
// trailing punctuation/whitespace allowed), not just its first word:
// unaccented "si" ("if"), "ok", "dale", "no", "mal" all start ordinary
// sentences, and a prefix match would create a Calendar event (or discard
// the reminder) from a message that was never a reply.
test("a sentence that merely STARTS with a confirm word is never a confirm (no Calendar event)", async () => {
  const note = await seedNote({ rawText: "turno con el dentista" });
  await enqueueReminder(note.id, new Date("2026-10-31T15:00:00Z"));

  for (const text of [
    "si llueve llevar paraguas",
    "ok comprar leche",
    "dale que va: cena con Juan el viernes",
    "sí, pero a las 16",
  ]) {
    expect(await handleConfirmationReply(text), text).toBe("unrecognized");
  }
  expect(mockCreateCalendarEvent).not.toHaveBeenCalled();
  expect((await db.reminder.findUnique({ where: { noteId: note.id } }))?.status).toBe("awaiting_confirmation");
});

test("a sentence that merely STARTS with a reject word is never a reject (the reminder stays pending)", async () => {
  const note = await seedNote({ rawText: "turno con el dentista" });
  await enqueueReminder(note.id, new Date("2026-10-31T15:00:00Z"));

  for (const text of ["no olvidar pagar la luz", "mal día, gasté 5000 en taxi", "no sé si va"]) {
    expect(await handleConfirmationReply(text), text).toBe("unrecognized");
  }
  expect((await db.reminder.findUnique({ where: { noteId: note.id } }))?.status).toBe("awaiting_confirmation");
});

test("genuine short confirm replies, with or without trailing punctuation/whitespace, still confirm", async () => {
  const replies = ["sí", "sí.", "sí!", "si", "SI", "SÍ", "dale", "dale ", "  dale!! ", "correcto", "Correcto.", "ok", "OK!", "ok ?"];
  for (let i = 0; i < replies.length; i++) {
    const reply = replies[i];
    const note = await seedNote({ rawText: `nota ${i}` });
    await enqueueReminder(note.id, new Date("2026-10-31T15:00:00Z"));
    expect(await handleConfirmationReply(reply), JSON.stringify(reply)).toBe("confirmed");
  }
  expect(mockCreateCalendarEvent).toHaveBeenCalledTimes(replies.length);
});

test("genuine short reject replies, with or without trailing punctuation/whitespace, still reject", async () => {
  const replies = ["no", "no.", "No!", "no ", "mal", "Mal.", "incorrecto", "incorrecto!!", " NO "];
  for (let i = 0; i < replies.length; i++) {
    const reply = replies[i];
    const note = await seedNote({ rawText: `nota ${i}` });
    await enqueueReminder(note.id, new Date("2026-10-31T15:00:00Z"));
    expect(await handleConfirmationReply(reply), JSON.stringify(reply)).toBe("rejected");
  }
  expect(mockCreateCalendarEvent).not.toHaveBeenCalled();
});

// The "one pending confirmation of any kind at a time" invariant
// now spans both Reminder.status and PendingDeletion (deleteFlow.ts) — a
// queued reminder must not be promoted while a delete confirmation (or
// disambiguation) is open.
test("claimNextQueuedReminder (via enqueueReminder) does not promote a queued reminder while a PendingDeletion row exists", async () => {
  await db.pendingDeletion.create({
    data: { stage: "confirming", noteIds: JSON.stringify(["some-note-id"]) },
  });
  const note = await seedNote({ type: "recordatorio", rawText: "turno con el dentista" });

  await enqueueReminder(note.id, new Date("2026-10-31T15:00:00Z"));

  const reminder = await db.reminder.findUnique({ where: { noteId: note.id } });
  expect(reminder?.status).toBe("queued");
  expect(mockSendSelfMessage).not.toHaveBeenCalled();
});

// The "one pending confirmation of any kind at a time" invariant
// now also spans PendingCuotaPayment (cuotaPaymentFlow.ts) — a queued
// reminder must not be promoted while a cuota-payment disambiguation is
// open.
test("claimNextQueuedReminder (via enqueueReminder) does not promote a queued reminder while a PendingCuotaPayment row exists", async () => {
  await db.pendingCuotaPayment.create({
    data: { candidates: JSON.stringify([{ kind: "item", id: "some-item-id" }]), overrideAmountCents: null },
  });
  const note = await seedNote({ type: "recordatorio", rawText: "turno con el dentista" });

  await enqueueReminder(note.id, new Date("2026-10-31T15:00:00Z"));

  const reminder = await db.reminder.findUnique({ where: { noteId: note.id } });
  expect(reminder?.status).toBe("queued");
  expect(mockSendSelfMessage).not.toHaveBeenCalled();
});

// The "one pending confirmation of any
// kind at a time" invariant now also spans PendingPurchaseSimulation
// (purchaseFeasibilityFlow.ts) — a queued reminder must not be
// promoted while a purchase-feasibility question is still missing a field.
test("claimNextQueuedReminder (via enqueueReminder) does not promote a queued reminder while a PendingPurchaseSimulation row exists", async () => {
  await db.pendingPurchaseSimulation.create({
    data: { conversationText: "¿me conviene comprar una heladera?", missingField: "price" },
  });
  const note = await seedNote({ type: "recordatorio", rawText: "turno con el dentista" });

  await enqueueReminder(note.id, new Date("2026-10-31T15:00:00Z"));

  const reminder = await db.reminder.findUnique({ where: { noteId: note.id } });
  expect(reminder?.status).toBe("queued");
  expect(mockSendSelfMessage).not.toHaveBeenCalled();
});
