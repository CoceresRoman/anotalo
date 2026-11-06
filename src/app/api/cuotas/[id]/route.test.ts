import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, expect, test } from "vitest";
import db from "../../../../lib/db";
import { DELETE, PATCH } from "./route";

// Same rationale as src/app/api/cuotas/route.test.ts.
beforeEach(async () => {
  await db.recurringPayment.deleteMany();
  await db.expense.deleteMany();
  await db.note.deleteMany();
  await db.recurringItem.deleteMany();
  await db.recurringGroup.deleteMany();
});

function buildRequest({
  method = "PATCH",
  body,
}: {
  method?: "PATCH" | "DELETE";
  body?: unknown;
} = {}): NextRequest {
  return new NextRequest("http://localhost/api/cuotas/some-id", {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function seedItem({
  name = "cuota de prueba",
  amountCents = 10000,
  totalInstallments = null as number | null,
  startInstallment = 1,
  startYearMonth = "2026-01",
  groupId = null as string | null,
}) {
  return db.recurringItem.create({
    data: { name, amountCents, totalInstallments, startInstallment, startYearMonth, groupId },
  });
}

async function seedPaymentFor(itemId: string, yearMonth: string, amountCents = 10000) {
  const note = await db.note.create({
    data: { rawText: "pago de prueba", source: "text", type: "gasto", whatsappMessageId: randomUUID() },
  });
  const expense = await db.expense.create({
    data: { noteId: note.id, amountCents, occurredAt: new Date() },
  });
  const payment = await db.recurringPayment.create({ data: { itemId, yearMonth, noteId: note.id } });
  return { note, expense, payment };
}

test("PATCH /api/cuotas/:id updates the given fields", async () => {
  const item = await seedItem({ name: "original", amountCents: 1000 });

  const res = await PATCH(buildRequest({ body: { name: "renombrada", amountCents: 2000 } }), {
    params: { id: item.id },
  });

  expect(res.status).toBe(200);
  const updated = await db.recurringItem.findUnique({ where: { id: item.id } });
  expect(updated?.name).toBe("renombrada");
  expect(updated?.amountCents).toBe(2000);
});

test("PATCH /api/cuotas/:id returns 404 for a non-existent id", async () => {
  const res = await PATCH(buildRequest({ body: { name: "x" } }), {
    params: { id: "does-not-exist" },
  });

  expect(res.status).toBe(404);
});

test("DELETE /api/cuotas/:id removes the item definition", async () => {
  const item = await seedItem({});

  const res = await DELETE(buildRequest({ method: "DELETE" }), { params: { id: item.id } });

  expect(res.status).toBe(204);
  expect(await db.recurringItem.findUnique({ where: { id: item.id } })).toBeNull();
});

test("DELETE /api/cuotas/:id returns 404 for a non-existent id", async () => {
  const res = await DELETE(buildRequest({ method: "DELETE" }), {
    params: { id: "does-not-exist" },
  });

  expect(res.status).toBe(404);
});

test("DELETE /api/cuotas/:id removes its RecurringPayment rows but never the Note/Expense they pointed to", async () => {
  const item = await seedItem({ startYearMonth: "2026-01" });
  const { note, expense, payment } = await seedPaymentFor(item.id, "2026-03");

  const res = await DELETE(buildRequest({ method: "DELETE" }), { params: { id: item.id } });

  expect(res.status).toBe(204);
  expect(await db.recurringItem.findUnique({ where: { id: item.id } })).toBeNull();
  expect(await db.recurringPayment.findUnique({ where: { id: payment.id } })).toBeNull();
  // The historical gasto survives intact: deleting the cuota definition
  // only drops the "this expense came from that cuota" link, never the
  // expense/note themselves.
  expect(await db.note.findUnique({ where: { id: note.id } })).not.toBeNull();
  expect(await db.expense.findUnique({ where: { id: expense.id } })).not.toBeNull();
});

// Final-review finding: loose PATCH validation (same rules as POST).
test.each([
  ["a malformed startYearMonth", { startYearMonth: "2026/06" }],
  ["a zero amountCents", { amountCents: 0 }],
  ["a negative amountCents", { amountCents: -1 }],
  ["a zero startInstallment", { startInstallment: 0 }],
])("PATCH /api/cuotas/:id rejects %s with 400 and leaves the item unchanged", async (_label, body) => {
  const item = await seedItem({ amountCents: 10000 });

  const res = await PATCH(buildRequest({ body }), { params: { id: item.id } });

  expect(res.status).toBe(400);
  const after = await db.recurringItem.findUnique({ where: { id: item.id } });
  expect(after).toEqual(item);
});

test("PATCH /api/cuotas/:id returns 400 (not a FK 500) for a nonexistent groupId", async () => {
  const item = await seedItem({});

  const res = await PATCH(buildRequest({ body: { groupId: "does-not-exist" } }), { params: { id: item.id } });

  expect(res.status).toBe(400);
  expect((await db.recurringItem.findUnique({ where: { id: item.id } }))?.groupId).toBeNull();
});

test("PATCH /api/cuotas/:id accepts an existing groupId, and groupId: null still ungroups", async () => {
  const group = await db.recurringGroup.create({ data: { name: "Tarjeta" } });
  const item = await seedItem({});

  const grouped = await PATCH(buildRequest({ body: { groupId: group.id } }), { params: { id: item.id } });
  expect(grouped.status).toBe(200);
  expect((await grouped.json()).groupId).toBe(group.id);

  const ungrouped = await PATCH(buildRequest({ body: { groupId: null } }), { params: { id: item.id } });
  expect(ungrouped.status).toBe(200);
  expect((await ungrouped.json()).groupId).toBeNull();
});
