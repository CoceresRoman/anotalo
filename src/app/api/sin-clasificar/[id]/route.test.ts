import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import db from "../../../../lib/db";

// enqueueReminder does its own Reminder.create *and* may send a
// real WhatsApp confirmation prompt via sendSelfMessage — mocked here so
// this route's own contract (it flips Note.type, then hands off to
// enqueueReminder with the right args) is tested in isolation from the
// queueing/confirmation state machine, which reminders.test.ts owns. Same
// pattern as src/lib/whatsapp/persist.test.ts.
const mockEnqueueReminder = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../../../lib/whatsapp/reminders", () => ({ enqueueReminder: mockEnqueueReminder }));

import { PATCH } from "./route";

// Expense/Income/Reminder all have a required FK to Note, so clear them first.
// Each test seeds its own fixtures — same pattern as
// src/app/api/gastos/[id]/route.test.ts.
beforeEach(async () => {
  // Date-only fake (Prisma unaffected): keeps the fixtures' Nov 2026
  // datetimes in the future, since past datetimes are rejected.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
  await db.expense.deleteMany();
  await db.income.deleteMany();
  await db.saving.deleteMany();
  await db.reminder.deleteMany();
  await db.note.deleteMany();
  mockEnqueueReminder.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// Local helpers, same pattern as src/app/api/gastos/[id]/route.test.ts.
function buildRequest({
  method = "PATCH",
  body,
}: {
  method?: string;
  body?: unknown;
} = {}): NextRequest {
  return new NextRequest("http://localhost/api/sin-clasificar/some-id", {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function seedNote({
  rawText = "nota de prueba",
  type = "no_identificado",
}: {
  rawText?: string;
  type?: string;
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

test("PATCH /api/sin-clasificar/:id with type=gasto moves the note and creates its Expense row", async () => {
  const note = await seedNote({ rawText: "compré algo por 5000" });

  const res = await PATCH(
    buildRequest({ method: "PATCH", body: { type: "gasto", amountCents: 500000, category: null } }),
    { params: { id: note.id } }
  );

  expect(res.status).toBe(200);
  const updated = await db.note.findUnique({ where: { id: note.id }, include: { expense: true } });
  expect(updated?.type).toBe("gasto");
  expect(updated?.expense?.amountCents).toBe(500000);
  expect(updated?.expense?.category).toBeNull();
});

test("PATCH /api/sin-clasificar/:id with type=idea moves the note without creating Expense or Reminder rows", async () => {
  const note = await seedNote({ rawText: "una idea suelta" });

  const res = await PATCH(buildRequest({ body: { type: "idea" } }), {
    params: { id: note.id },
  });

  expect(res.status).toBe(200);
  const updated = await db.note.findUnique({
    where: { id: note.id },
    include: { expense: true, reminder: true },
  });
  expect(updated?.type).toBe("idea");
  expect(updated?.expense).toBeNull();
  expect(updated?.reminder).toBeNull();
});

test("PATCH /api/sin-clasificar/:id with type=recordatorio flips the note's type and hands off to enqueueReminder with the parsed datetime", async () => {
  const note = await seedNote({ rawText: "turno con el dentista" });

  const res = await PATCH(
    buildRequest({ body: { type: "recordatorio", parsedDatetime: "2026-11-04T10:00:00Z" } }),
    { params: { id: note.id } }
  );

  expect(res.status).toBe(200);
  const updated = await db.note.findUnique({ where: { id: note.id } });
  expect(updated?.type).toBe("recordatorio");
  expect(mockEnqueueReminder).toHaveBeenCalledTimes(1);
  expect(mockEnqueueReminder).toHaveBeenCalledWith(note.id, new Date("2026-11-04T10:00:00Z"));
  // This endpoint must not create the Reminder row itself anymore — that's
  // entirely enqueueReminder's job now.
  expect(await db.reminder.findUnique({ where: { noteId: note.id } })).toBeNull();
});

test("PATCH /api/sin-clasificar/:id with type=recordatorio and no parsedDatetime calls enqueueReminder with null", async () => {
  const note = await seedNote({ rawText: "recordame algo" });

  const res = await PATCH(buildRequest({ body: { type: "recordatorio" } }), {
    params: { id: note.id },
  });

  expect(res.status).toBe(200);
  const updated = await db.note.findUnique({ where: { id: note.id } });
  expect(updated?.type).toBe("recordatorio");
  expect(mockEnqueueReminder).toHaveBeenCalledWith(note.id, null);
});

test("PATCH /api/sin-clasificar/:id returns 404 for a non-existent note", async () => {
  const res = await PATCH(buildRequest({ body: { type: "idea" } }), {
    params: { id: "does-not-exist" },
  });

  expect(res.status).toBe(404);
});

test("PATCH /api/sin-clasificar/:id returns 400 for an invalid type", async () => {
  const note = await seedNote();

  const res = await PATCH(buildRequest({ body: { type: "no_identificado" } }), {
    params: { id: note.id },
  });

  expect(res.status).toBe(400);
});

test("PATCH /api/sin-clasificar/:id returns 400 when type=gasto is missing amountCents", async () => {
  const note = await seedNote();

  const res = await PATCH(buildRequest({ body: { type: "gasto" } }), {
    params: { id: note.id },
  });

  expect(res.status).toBe(400);
});

test("PATCH /api/sin-clasificar/:id returns 409 instead of crashing on a same-type double PATCH", async () => {
  const note = await seedNote({ rawText: "compré algo por 5000" });

  const first = await PATCH(
    buildRequest({ body: { type: "gasto", amountCents: 500000, category: null } }),
    { params: { id: note.id } }
  );
  expect(first.status).toBe(200);

  // Expense.noteId is @unique, so without the no_identificado guard this
  // second PATCH would hit an unhandled Prisma P2002 instead of a clean 409.
  const second = await PATCH(
    buildRequest({ body: { type: "gasto", amountCents: 999999, category: null } }),
    { params: { id: note.id } }
  );
  expect(second.status).toBe(409);

  // The original Expense row must be untouched by the rejected second call.
  const updated = await db.note.findUnique({ where: { id: note.id }, include: { expense: true } });
  expect(updated?.expense?.amountCents).toBe(500000);
});

test("PATCH /api/sin-clasificar/:id returns 409 instead of leaving a stale row on a cross-type double PATCH", async () => {
  const note = await seedNote({ rawText: "compré algo por 5000" });

  const first = await PATCH(
    buildRequest({ body: { type: "gasto", amountCents: 500000, category: null } }),
    { params: { id: note.id } }
  );
  expect(first.status).toBe(200);

  // Without the guard, this would succeed, flip Note.type to "idea", and
  // leave the Expense row from the first PATCH behind — a note that
  // displays as an Idea but still silently counts toward Gastos totals.
  const second = await PATCH(buildRequest({ body: { type: "idea" } }), {
    params: { id: note.id },
  });
  expect(second.status).toBe(409);

  const updated = await db.note.findUnique({ where: { id: note.id }, include: { expense: true } });
  expect(updated?.type).toBe("gasto");
  expect(updated?.expense?.amountCents).toBe(500000);
});

// A datetime that doesn't parse, or is in the past, is rejected
// before anything is written — previously an unparseable one flipped
// Note.type to "recordatorio" and then crashed on an Invalid Date at
// Reminder.create, leaving an orphaned recordatorio with no Reminder row.
for (const [label, parsedDatetime] of [
  ["an unparseable", "mañana a la tarde"],
  ["a past", "2026-10-01T10:00:00-03:00"],
] as const) {
  test(`PATCH /api/sin-clasificar/:id returns 400 for ${label} parsedDatetime and leaves the note untouched`, async () => {
    const note = await seedNote({ rawText: "turno" });

    const res = await PATCH(buildRequest({ body: { type: "recordatorio", parsedDatetime } }), {
      params: { id: note.id },
    });

    expect(res.status).toBe(400);
    expect((await db.note.findUnique({ where: { id: note.id } }))?.type).toBe("no_identificado");
    expect(mockEnqueueReminder).not.toHaveBeenCalled();
  });
}

test("PATCH /api/sin-clasificar/:id with type=ingreso moves the note and creates its Income row", async () => {
  const note = await seedNote({ rawText: "cobré el sueldo 250000" });

  const res = await PATCH(
    buildRequest({ body: { type: "ingreso", amountCents: 25000000, isSalary: true } }),
    { params: { id: note.id } }
  );

  expect(res.status).toBe(200);
  const updated = await db.note.findUnique({ where: { id: note.id }, include: { income: true } });
  expect(updated?.type).toBe("ingreso");
  expect(updated?.income?.amountCents).toBe(25000000);
  expect(updated?.income?.isSalary).toBe(true);
  expect(updated?.income?.occurredAt.getTime()).toBe(note.createdAt.getTime());
});

test("PATCH /api/sin-clasificar/:id returns 400 when type=ingreso is missing amountCents", async () => {
  const note = await seedNote();

  const res = await PATCH(buildRequest({ body: { type: "ingreso", isSalary: false } }), {
    params: { id: note.id },
  });

  expect(res.status).toBe(400);
  expect((await db.note.findUnique({ where: { id: note.id } }))?.type).toBe("no_identificado");
  expect(await db.income.findUnique({ where: { noteId: note.id } })).toBeNull();
});

test("PATCH /api/sin-clasificar/:id with type=ingreso and no isSalary key defaults Income.isSalary to false", async () => {
  const note = await seedNote({ rawText: "transferencia de un cliente" });

  const res = await PATCH(buildRequest({ body: { type: "ingreso", amountCents: 150000 } }), {
    params: { id: note.id },
  });

  expect(res.status).toBe(200);
  const income = await db.income.findUnique({ where: { noteId: note.id } });
  expect(income?.isSalary).toBe(false);
});

test("PATCH /api/sin-clasificar/:id with type=ahorro moves the note and creates its Saving row", async () => {
  const note = await seedNote({ rawText: "aparté 200000 este mes" });

  const res = await PATCH(buildRequest({ body: { type: "ahorro", amountCents: 20000000 } }), {
    params: { id: note.id },
  });

  expect(res.status).toBe(200);
  const updated = await db.note.findUnique({ where: { id: note.id }, include: { saving: true } });
  expect(updated?.type).toBe("ahorro");
  expect(updated?.saving?.amountCents).toBe(20000000);
  expect(updated?.saving?.occurredAt.getTime()).toBe(note.createdAt.getTime());
});

test("PATCH /api/sin-clasificar/:id returns 400 when type=ahorro is missing amountCents", async () => {
  const note = await seedNote();

  const res = await PATCH(buildRequest({ body: { type: "ahorro" } }), {
    params: { id: note.id },
  });

  expect(res.status).toBe(400);
  expect((await db.note.findUnique({ where: { id: note.id } }))?.type).toBe("no_identificado");
  expect(await db.saving.findUnique({ where: { noteId: note.id } })).toBeNull();
});
