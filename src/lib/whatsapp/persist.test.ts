import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { config } from "../config";
import db from "../db";

// The reminder queue's prompt-sending step is mocked so these
// tests assert persist.ts's own contract: the Note and its Reminder row are
// written atomically, and only then is the queue nudged. reminderRowData
// (the pure row builder with the date guards) stays real.
const mockPromptNextIfIdle = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./reminders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reminders")>()),
  promptNextIfIdle: mockPromptNextIfIdle,
}));

import { persistClassifiedNote } from "./persist";

// Expense/Reminder both have a required FK to Note, so clear them first —
// same pattern as src/app/api/sin-clasificar/[id]/route.test.ts.
beforeEach(async () => {
  // Date-only fake (timers stay real for Prisma) so the fixtures' Nov 2026
  // datetimes stay in the future (past datetimes are rejected).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
  await db.expense.deleteMany();
  await db.income.deleteMany();
  await db.saving.deleteMany();
  await db.reminder.deleteMany();
  await db.note.deleteMany();
  mockPromptNextIfIdle.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

test("persistClassifiedNote creates a Note and its Expense row for a gasto classification", async () => {
  const note = await persistClassifiedNote(
    { intent: "capture", noteType: "gasto", amountCents: 320000, category: "comida" },
    "compré un café, 3200 pesos",
    "text",
    "wa-123"
  );

  expect(note.type).toBe("gasto");
  expect(note.rawText).toBe("compré un café, 3200 pesos");
  expect(note.source).toBe("text");
  expect(note.whatsappMessageId).toBe("wa-123");

  const expense = await db.expense.findUnique({ where: { noteId: note.id } });
  expect(expense?.amountCents).toBe(320000);
  expect(expense?.category).toBe("comida");
});

test("persistClassifiedNote defaults amountCents to 0 and category to null when missing on a gasto classification", async () => {
  const note = await persistClassifiedNote(
    { intent: "capture", noteType: "gasto" },
    "compré algo pero no sé cuánto",
    "audio",
    "wa-456"
  );

  const expense = await db.expense.findUnique({ where: { noteId: note.id } });
  expect(expense?.amountCents).toBe(0);
  expect(expense?.category).toBeNull();
});

test("persistClassifiedNote creates only the Note row for an idea classification", async () => {
  const note = await persistClassifiedNote(
    { intent: "capture", noteType: "idea" },
    "una idea genial para el finde",
    "text",
    "wa-idea"
  );

  expect(note.type).toBe("idea");
  expect(await db.expense.findUnique({ where: { noteId: note.id } })).toBeNull();
  expect(await db.reminder.findUnique({ where: { noteId: note.id } })).toBeNull();
  expect(mockPromptNextIfIdle).not.toHaveBeenCalled();
});

test("persistClassifiedNote creates only the Note row for a no_identificado classification", async () => {
  const note = await persistClassifiedNote(
    { intent: "capture", noteType: "no_identificado" },
    "algo raro e incomprensible",
    "audio",
    "wa-noid"
  );

  expect(note.type).toBe("no_identificado");
  expect(await db.expense.findUnique({ where: { noteId: note.id } })).toBeNull();
  expect(await db.reminder.findUnique({ where: { noteId: note.id } })).toBeNull();
  expect(mockPromptNextIfIdle).not.toHaveBeenCalled();
});

test("persistClassifiedNote accepts source 'image' and persists Note.source as 'image'", async () => {
  const note = await persistClassifiedNote(
    { intent: "capture", noteType: "no_identificado" },
    "[imagen]",
    "image",
    "wa-image"
  );

  expect(note.source).toBe("image");
  expect(note.type).toBe("no_identificado");
});

test("persistClassifiedNote creates the Note and its queued Reminder row together, then nudges the confirmation queue", async () => {
  const note = await persistClassifiedNote(
    { intent: "capture", noteType: "recordatorio", parsedDatetime: "2026-11-04T10:00:00-03:00" },
    "turno con el dentista el miércoles",
    "text",
    "wa-789"
  );

  expect(note.type).toBe("recordatorio");
  const reminder = await db.reminder.findUnique({ where: { noteId: note.id } });
  expect(reminder?.status).toBe("queued");
  expect(reminder?.parsedDatetime).toEqual(new Date("2026-11-04T10:00:00-03:00"));
  expect(mockPromptNextIfIdle).toHaveBeenCalledTimes(1);
});

test("persistClassifiedNote creates an ambiguous_no_date Reminder when the classification has no datetime", async () => {
  const note = await persistClassifiedNote(
    { intent: "capture", noteType: "recordatorio" },
    "recordame algo, no sé cuándo",
    "text",
    "wa-no-date"
  );

  const reminder = await db.reminder.findUnique({ where: { noteId: note.id } });
  expect(reminder?.status).toBe("ambiguous_no_date");
  expect(reminder?.parsedDatetime).toBeNull();
});

// An invalid datetime string must never become an Invalid Date at a
// Prisma .create() (which used to throw *after* the Note was committed,
// leaving an orphan "recordatorio" Note with no Reminder, invisible in every
// view and un-retriable because idempotency blocked a retry).
test("persistClassifiedNote never passes an invalid datetime to Prisma: the reminder becomes ambiguous_no_date", async () => {
  const note = await persistClassifiedNote(
    { intent: "capture", noteType: "recordatorio", parsedDatetime: "el viernes a la tarde" },
    "recordame el viernes a la tarde",
    "text",
    "wa-bad-date"
  );

  const reminder = await db.reminder.findUnique({ where: { noteId: note.id } });
  expect(reminder?.status).toBe("ambiguous_no_date");
  expect(reminder?.parsedDatetime).toBeNull();
});

// Note + Expense are one transaction — a failure writing the Expense
// (here: an amount too large for SQLite's 32-bit Int column, which zod's
// .int() happily accepts from the LLM) rolls the Note back too.
test("persistClassifiedNote rolls back the Note when its Expense row fails to write (no orphaned 'gasto' Note)", async () => {
  await expect(
    persistClassifiedNote(
      { intent: "capture", noteType: "gasto", amountCents: 2 ** 40, category: "comida" },
      "gasté una fortuna",
      "text",
      "wa-orphan"
    )
  ).rejects.toThrow();

  expect(await db.note.findUnique({ where: { whatsappMessageId: "wa-orphan" } })).toBeNull();
  expect(await db.expense.count()).toBe(0);
});

test("persistClassifiedNote stores a gasto's currency, defaulting to ARS", async () => {
  const ars = await persistClassifiedNote(
    { intent: "capture", noteType: "gasto", amountCents: 100, category: "comida" },
    "café 1 peso",
    "text",
    "wa-ars"
  );
  const usd = await persistClassifiedNote(
    { intent: "capture", noteType: "gasto", amountCents: 5000, category: "suscripciones", currency: "USD" },
    "netflix u$s 50",
    "text",
    "wa-usd"
  );

  expect((await db.expense.findUnique({ where: { noteId: ars.id } }))?.currency).toBe("ARS");
  expect((await db.expense.findUnique({ where: { noteId: usd.id } }))?.currency).toBe("USD");
});

// Same behavior as the test above, but asserting it against the configured
// default (config.defaultCurrency) rather than the "ARS" literal — this is
// the regression that must keep passing once persist.ts stops hardcoding
// "ARS" and reads config.defaultCurrency instead.
test("persistClassifiedNote still defaults to ARS when classify didn't return a currency", async () => {
  const note = await persistClassifiedNote(
    { intent: "capture", noteType: "gasto", amountCents: 100, category: "comida" },
    "café 1 peso",
    "text",
    "wa-default-currency"
  );

  const expense = await db.expense.findUnique({ where: { noteId: note.id } });
  expect(expense?.currency).toBe(config.defaultCurrency);
});

test("persistClassifiedNote creates a Note and its Income row for an ingreso classification", async () => {
  const note = await persistClassifiedNote(
    { intent: "capture", noteType: "ingreso", amountCents: 150000000, isSalary: true },
    "cobré el sueldo, 1500000 pesos",
    "text",
    "wa-sueldo"
  );

  expect(note.type).toBe("ingreso");
  const income = await db.income.findUnique({ where: { noteId: note.id } });
  expect(income?.amountCents).toBe(150000000);
  expect(income?.isSalary).toBe(true);
});

test("persistClassifiedNote defaults isSalary to false and amountCents to 0 when missing on an ingreso classification", async () => {
  const note = await persistClassifiedNote(
    { intent: "capture", noteType: "ingreso" },
    "me devolvieron plata, no sé cuánto",
    "audio",
    "wa-ingreso-default"
  );

  const income = await db.income.findUnique({ where: { noteId: note.id } });
  expect(income?.amountCents).toBe(0);
  expect(income?.isSalary).toBe(false);
});

test("persistClassifiedNote stores an ingreso's currency, defaulting to ARS", async () => {
  const ars = await persistClassifiedNote(
    { intent: "capture", noteType: "ingreso", amountCents: 100, isSalary: false },
    "me devolvieron 1 peso",
    "text",
    "wa-ingreso-ars"
  );
  const usd = await persistClassifiedNote(
    { intent: "capture", noteType: "ingreso", amountCents: 5000, isSalary: false, currency: "USD" },
    "me pagaron u$s 50",
    "text",
    "wa-ingreso-usd"
  );

  expect((await db.income.findUnique({ where: { noteId: ars.id } }))?.currency).toBe("ARS");
  expect((await db.income.findUnique({ where: { noteId: usd.id } }))?.currency).toBe("USD");
});

// Note + Income are one transaction — a failure writing the Income row
// (an amount too large for SQLite's 32-bit Int column) rolls the Note back.
test("persistClassifiedNote rolls back the Note when its Income row fails to write (no orphaned 'ingreso' Note)", async () => {
  await expect(
    persistClassifiedNote(
      { intent: "capture", noteType: "ingreso", amountCents: 2 ** 40, isSalary: false },
      "me pagaron una fortuna",
      "text",
      "wa-ingreso-orphan"
    )
  ).rejects.toThrow();

  expect(await db.note.findUnique({ where: { whatsappMessageId: "wa-ingreso-orphan" } })).toBeNull();
  expect(await db.income.count()).toBe(0);
});

test("persistClassifiedNote: noteType ahorro crea una fila Saving con el monto", async () => {
  const note = await persistClassifiedNote(
    { intent: "capture", noteType: "ahorro", amountCents: 20_000_000 },
    "aparté 200000",
    "text",
    randomUUID()
  );

  expect(note.type).toBe("ahorro");
  const saving = await db.saving.findUnique({ where: { noteId: note.id } });
  expect(saving?.amountCents).toBe(20_000_000);
});

test("persistClassifiedNote defaults amountCents to 0 when missing on an ahorro classification", async () => {
  const note = await persistClassifiedNote(
    { intent: "capture", noteType: "ahorro" },
    "aparté plata, no sé cuánto",
    "audio",
    randomUUID()
  );

  const saving = await db.saving.findUnique({ where: { noteId: note.id } });
  expect(saving?.amountCents).toBe(0);
});

test("persistClassifiedNote stores an ahorro's currency, defaulting to ARS", async () => {
  const ars = await persistClassifiedNote(
    { intent: "capture", noteType: "ahorro", amountCents: 100 },
    "aparté 1 peso",
    "text",
    randomUUID()
  );
  const usd = await persistClassifiedNote(
    { intent: "capture", noteType: "ahorro", amountCents: 5000, currency: "USD" },
    "aparté u$s 50",
    "text",
    randomUUID()
  );

  expect((await db.saving.findUnique({ where: { noteId: ars.id } }))?.currency).toBe("ARS");
  expect((await db.saving.findUnique({ where: { noteId: usd.id } }))?.currency).toBe("USD");
});

// Note + Saving are one transaction — a failure writing the Saving row
// (an amount too large for SQLite's 32-bit Int column) rolls the Note back.
test("persistClassifiedNote rolls back the Note when its Saving row fails to write (no orphaned 'ahorro' Note)", async () => {
  await expect(
    persistClassifiedNote(
      { intent: "capture", noteType: "ahorro", amountCents: 2 ** 40 },
      "aparté una fortuna",
      "text",
      "wa-ahorro-orphan"
    )
  ).rejects.toThrow();

  expect(await db.note.findUnique({ where: { whatsappMessageId: "wa-ahorro-orphan" } })).toBeNull();
  expect(await db.saving.count()).toBe(0);
});

test("persistClassifiedNote defaults a missing noteType to no_identificado", async () => {
  const note = await persistClassifiedNote({ intent: "capture" }, "sin tipo", "text", "wa-no-type");
  expect(note.type).toBe("no_identificado");
});
