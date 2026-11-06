import { randomUUID } from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";
import db from "./db";

// Only ../lib/calendar's deleteCalendarEvent is mocked — noteDeletion.ts's
// own logic (looking the note up with its reminder, deciding whether
// Calendar needs to be touched, and the $transaction that removes
// Reminder + Note together) runs for real against the test DB.
const mockDeleteCalendarEvent = vi.hoisted(() => vi.fn());

vi.mock("./calendar", () => ({ deleteCalendarEvent: mockDeleteCalendarEvent }));

import { deleteNoteCascading } from "./noteDeletion";

async function seedNote({
  type = "idea",
  rawText = "nota de prueba",
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
  await db.recurringPayment.deleteMany();
  await db.expense.deleteMany();
  await db.income.deleteMany();
  await db.saving.deleteMany();
  await db.reminder.deleteMany();
  await db.note.deleteMany();
  await db.recurringItem.deleteMany();
  await db.recurringGroup.deleteMany();
  mockDeleteCalendarEvent.mockReset();
});

test("deletes an idea note with no reminder, never touches Calendar", async () => {
  const note = await seedNote({ type: "idea" });

  const result = await deleteNoteCascading(note.id);

  expect(result).toBe("deleted");
  expect(await db.note.findUnique({ where: { id: note.id } })).toBeNull();
  expect(mockDeleteCalendarEvent).not.toHaveBeenCalled();
});

test("deletes a recordatorio with no calendarEventId, never touches Calendar", async () => {
  const note = await seedNote({ type: "recordatorio" });
  await db.reminder.create({
    data: {
      noteId: note.id,
      parsedDatetime: new Date("2026-11-04T15:00:00-03:00"),
      status: "awaiting_confirmation",
      calendarEventId: null,
    },
  });

  const result = await deleteNoteCascading(note.id);

  expect(result).toBe("deleted");
  expect(await db.reminder.findUnique({ where: { noteId: note.id } })).toBeNull();
  expect(await db.note.findUnique({ where: { id: note.id } })).toBeNull();
  expect(mockDeleteCalendarEvent).not.toHaveBeenCalled();
});

test("deletes a recordatorio with a calendarEventId: calls deleteCalendarEvent then removes reminder and note", async () => {
  const note = await seedNote({ type: "recordatorio" });
  await db.reminder.create({
    data: {
      noteId: note.id,
      parsedDatetime: new Date("2026-11-04T15:00:00-03:00"),
      status: "confirmed",
      calendarEventId: "evt-abc",
    },
  });
  mockDeleteCalendarEvent.mockResolvedValueOnce("deleted");

  const result = await deleteNoteCascading(note.id);

  expect(result).toBe("deleted");
  expect(mockDeleteCalendarEvent).toHaveBeenCalledWith("evt-abc");
  expect(await db.reminder.findUnique({ where: { noteId: note.id } })).toBeNull();
  expect(await db.note.findUnique({ where: { id: note.id } })).toBeNull();
});

test("deleteCalendarEvent resolving 'already_gone' still deletes the note", async () => {
  const note = await seedNote({ type: "recordatorio" });
  await db.reminder.create({
    data: {
      noteId: note.id,
      parsedDatetime: new Date("2026-11-04T15:00:00-03:00"),
      status: "confirmed",
      calendarEventId: "evt-gone",
    },
  });
  mockDeleteCalendarEvent.mockResolvedValueOnce("already_gone");

  const result = await deleteNoteCascading(note.id);

  expect(result).toBe("deleted");
  expect(await db.reminder.findUnique({ where: { noteId: note.id } })).toBeNull();
  expect(await db.note.findUnique({ where: { id: note.id } })).toBeNull();
});

test("deleteCalendarEvent throwing aborts the whole delete: note and reminder stay", async () => {
  const note = await seedNote({ type: "recordatorio" });
  await db.reminder.create({
    data: {
      noteId: note.id,
      parsedDatetime: new Date("2026-11-04T15:00:00-03:00"),
      status: "confirmed",
      calendarEventId: "evt-abc",
    },
  });
  mockDeleteCalendarEvent.mockRejectedValueOnce(new Error("network"));

  const result = await deleteNoteCascading(note.id);

  expect(result).toBe("calendar_delete_failed");
  expect(await db.note.findUnique({ where: { id: note.id } })).not.toBeNull();
  expect(await db.reminder.findUnique({ where: { noteId: note.id } })).not.toBeNull();
});

test("a noteId that doesn't exist is a harmless no-op returning 'deleted'", async () => {
  const result = await deleteNoteCascading("does-not-exist");

  expect(result).toBe("deleted");
  expect(mockDeleteCalendarEvent).not.toHaveBeenCalled();
});

test("deletes a gasto note together with its Expense row", async () => {
  const note = await seedNote({ type: "gasto" });
  await db.expense.create({
    data: {
      noteId: note.id,
      amountCents: 500000,
      category: "comida",
      occurredAt: new Date("2026-10-30T12:00:00-03:00"),
    },
  });

  const result = await deleteNoteCascading(note.id);

  expect(result).toBe("deleted");
  expect(await db.expense.findUnique({ where: { noteId: note.id } })).toBeNull();
  expect(await db.note.findUnique({ where: { id: note.id } })).toBeNull();
});

test("deletes an ingreso note together with its Income row", async () => {
  const note = await seedNote({ type: "ingreso" });
  await db.income.create({
    data: {
      noteId: note.id,
      amountCents: 1000000,
      isSalary: true,
      occurredAt: new Date("2026-10-30T12:00:00-03:00"),
    },
  });

  const result = await deleteNoteCascading(note.id);

  expect(result).toBe("deleted");
  expect(await db.income.findUnique({ where: { noteId: note.id } })).toBeNull();
  expect(await db.note.findUnique({ where: { id: note.id } })).toBeNull();
});

test("deletes an ahorro note together with its Saving row", async () => {
  const note = await seedNote({ type: "ahorro" });
  await db.saving.create({
    data: {
      noteId: note.id,
      amountCents: 1000000,
      occurredAt: new Date("2026-10-30T12:00:00-03:00"),
    },
  });

  const result = await deleteNoteCascading(note.id);

  expect(result).toBe("deleted");
  expect(await db.saving.findUnique({ where: { noteId: note.id } })).toBeNull();
  expect(await db.note.findUnique({ where: { id: note.id } })).toBeNull();
});

test("deleting a gasto note created by a cuota payment also deletes its RecurringPayment row(s)", async () => {
  const item = await db.recurringItem.create({
    data: {
      name: "Netflix",
      amountCents: 450000,
      startYearMonth: "2026-10",
    },
  });
  const note = await seedNote({ type: "gasto" });
  await db.expense.create({
    data: {
      noteId: note.id,
      amountCents: 450000,
      occurredAt: new Date("2026-10-30T12:00:00-03:00"),
    },
  });
  await db.recurringPayment.create({
    data: { itemId: item.id, yearMonth: "2026-10", noteId: note.id },
  });

  const result = await deleteNoteCascading(note.id);

  expect(result).toBe("deleted");
  expect(await db.note.findUnique({ where: { id: note.id } })).toBeNull();
  expect(await db.recurringPayment.findMany({ where: { noteId: note.id } })).toEqual([]);
});

test("deleting the single combined gasto note of a grouped cuota payment deletes ALL RecurringPayment rows that share that note", async () => {
  const group = await db.recurringGroup.create({ data: { name: "Tarjeta Visa" } });
  const itemA = await db.recurringItem.create({
    data: {
      name: "Heladera",
      amountCents: 1200000,
      groupId: group.id,
      startYearMonth: "2026-10",
    },
  });
  const itemB = await db.recurringItem.create({
    data: {
      name: "Celular",
      amountCents: 800000,
      groupId: group.id,
      startYearMonth: "2026-10",
    },
  });
  const note = await seedNote({ type: "gasto" });
  await db.expense.create({
    data: {
      noteId: note.id,
      amountCents: 2000000,
      occurredAt: new Date("2026-10-30T12:00:00-03:00"),
    },
  });
  await db.recurringPayment.create({
    data: { itemId: itemA.id, yearMonth: "2026-10", noteId: note.id },
  });
  await db.recurringPayment.create({
    data: { itemId: itemB.id, yearMonth: "2026-10", noteId: note.id },
  });

  const result = await deleteNoteCascading(note.id);

  expect(result).toBe("deleted");
  expect(await db.note.findUnique({ where: { id: note.id } })).toBeNull();
  expect(await db.recurringPayment.findMany({ where: { noteId: note.id } })).toEqual([]);
});
