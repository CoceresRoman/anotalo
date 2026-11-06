import { NextRequest } from "next/server";
import { beforeEach, expect, test } from "vitest";
import db from "../../../../../lib/db";
import { toArgentinaDateString } from "../../../../../lib/timezone";
import { POST } from "./route";

// Same rationale as src/app/api/cuotas/[id]/pagar/route.test.ts.
beforeEach(async () => {
  await db.recurringPayment.deleteMany();
  await db.expense.deleteMany();
  await db.note.deleteMany();
  await db.recurringItem.deleteMany();
  await db.recurringGroup.deleteMany();
});

const currentYearMonth = toArgentinaDateString(new Date()).slice(0, 7);

function buildRequest(id: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/agrupadores/${id}/pagar`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

async function seedGroup(name = "Tarjeta Mastercard") {
  return db.recurringGroup.create({ data: { name } });
}

async function seedItem({
  groupId,
  name = "cuota de prueba",
  amountCents = 10000,
  totalInstallments = null as number | null,
  startInstallment = 1,
  startYearMonth = currentYearMonth,
}: {
  groupId: string | null;
  name?: string;
  amountCents?: number;
  totalInstallments?: number | null;
  startInstallment?: number;
  startYearMonth?: string;
}) {
  return db.recurringItem.create({
    data: { name, amountCents, totalInstallments, startInstallment, startYearMonth, groupId },
  });
}

async function seedPaymentFor(itemId: string, yearMonth: string, amountCents = 10000) {
  const note = await db.note.create({
    data: { rawText: "pago de prueba", source: "text", type: "gasto", whatsappMessageId: `web:${itemId}-${yearMonth}` },
  });
  const expense = await db.expense.create({
    data: { noteId: note.id, amountCents, occurredAt: new Date() },
  });
  await db.recurringPayment.create({ data: { itemId, yearMonth, noteId: note.id } });
  return expense;
}

test("POST /api/agrupadores/:id/pagar pays every active, unpaid item under the group this month with ONE combined Note+Expense", async () => {
  const group = await seedGroup();
  const item1 = await seedItem({ groupId: group.id, name: "cuota 1", amountCents: 10000 });
  const item2 = await seedItem({ groupId: group.id, name: "cuota 2", amountCents: 25000 });

  const res = await POST(buildRequest(group.id), { params: { id: group.id } });
  const body = await res.json();

  expect(res.status).toBe(201);
  expect(typeof body.expenseId).toBe("string");
  expect(new Set(body.itemIds)).toEqual(new Set([item1.id, item2.id]));

  const expense = await db.expense.findUnique({ where: { id: body.expenseId }, include: { note: true } });
  expect(expense?.amountCents).toBe(35000);
  expect(expense?.note.rawText).toBe(group.name);
  expect(expense?.note.type).toBe("gasto");

  const payment1 = await db.recurringPayment.findUnique({
    where: { itemId_yearMonth: { itemId: item1.id, yearMonth: currentYearMonth } },
  });
  const payment2 = await db.recurringPayment.findUnique({
    where: { itemId_yearMonth: { itemId: item2.id, yearMonth: currentYearMonth } },
  });
  expect(payment1?.noteId).toBe(expense?.noteId);
  expect(payment2?.noteId).toBe(expense?.noteId);
  expect(payment1?.noteId).toBe(payment2?.noteId);
});

test("POST /api/agrupadores/:id/pagar with an amountCents override uses that amount for the combined Expense instead of the computed sum", async () => {
  const group = await seedGroup();
  await seedItem({ groupId: group.id, name: "cuota 1", amountCents: 10000 });
  await seedItem({ groupId: group.id, name: "cuota 2", amountCents: 25000 });

  const res = await POST(buildRequest(group.id, { amountCents: 99000 }), { params: { id: group.id } });
  const body = await res.json();

  expect(res.status).toBe(201);
  const expense = await db.expense.findUnique({ where: { id: body.expenseId } });
  expect(expense?.amountCents).toBe(99000);
});

test("POST /api/agrupadores/:id/pagar skips items already paid this month, without double counting them", async () => {
  const group = await seedGroup();
  const paidItem = await seedItem({ groupId: group.id, name: "ya pagada", amountCents: 10000 });
  const unpaidItem = await seedItem({ groupId: group.id, name: "sin pagar", amountCents: 25000 });
  await seedPaymentFor(paidItem.id, currentYearMonth, 10000);

  const res = await POST(buildRequest(group.id), { params: { id: group.id } });
  const body = await res.json();

  expect(res.status).toBe(201);
  expect(body.itemIds).toEqual([unpaidItem.id]);

  const expense = await db.expense.findUnique({ where: { id: body.expenseId } });
  expect(expense?.amountCents).toBe(25000);

  const payments = await db.recurringPayment.findMany({ where: { itemId: paidItem.id } });
  expect(payments).toHaveLength(1);
});

test("POST /api/agrupadores/:id/pagar skips items that are not active this month, without double counting them", async () => {
  const group = await seedGroup();
  // Finished cuota: startYearMonth far in the past with totalInstallments
  // already exceeded by the current month, so isActiveInMonth is false.
  const inactiveItem = await seedItem({
    groupId: group.id,
    name: "ya terminada",
    amountCents: 10000,
    startYearMonth: "2000-01",
    totalInstallments: 1,
    startInstallment: 1,
  });
  const activeItem = await seedItem({ groupId: group.id, name: "activa", amountCents: 25000 });

  const res = await POST(buildRequest(group.id), { params: { id: group.id } });
  const body = await res.json();

  expect(res.status).toBe(201);
  expect(body.itemIds).toEqual([activeItem.id]);

  const expense = await db.expense.findUnique({ where: { id: body.expenseId } });
  expect(expense?.amountCents).toBe(25000);

  const payments = await db.recurringPayment.findMany({ where: { itemId: inactiveItem.id } });
  expect(payments).toHaveLength(0);
});

test("POST /api/agrupadores/:id/pagar returns 409 when there is nothing active and unpaid under the group this month", async () => {
  const group = await seedGroup();
  const item = await seedItem({ groupId: group.id });
  await seedPaymentFor(item.id, currentYearMonth);

  const res = await POST(buildRequest(group.id), { params: { id: group.id } });

  expect(res.status).toBe(409);
});

test("POST /api/agrupadores/:id/pagar returns 409 when there are no items under the group at all", async () => {
  const group = await seedGroup();

  const res = await POST(buildRequest(group.id), { params: { id: group.id } });

  expect(res.status).toBe(409);
});

test("POST /api/agrupadores/:id/pagar returns 404 for a non-existent group id", async () => {
  const res = await POST(buildRequest("does-not-exist"), { params: { id: "does-not-exist" } });

  expect(res.status).toBe(404);
});

// Simulates a competing RecurringPayment landing between payItem/payGroup's
// "already paid this month?" pre-check and their transaction: the FIRST
// db.$transaction call creates that competing payment right before running
// the real transaction; later calls (e.g. payGroup's recompute) go straight
// to the real one. Patched by plain assignment and restored by assigning the
// original back, instead of vi.spyOn + mockRestore: PrismaClient is a Proxy,
// and mockRestore leaves the patched method undefined for every later test.
function raceBeforeFirstTransaction(seedCompetingPayment: () => Promise<unknown>): { mockRestore: () => void } {
  const client = db as unknown as { $transaction: (...args: unknown[]) => Promise<unknown> };
  const original = client.$transaction;
  let first = true;
  client.$transaction = async (...args: unknown[]) => {
    if (first) {
      first = false;
      await seedCompetingPayment();
    }
    return original.apply(db, args);
  };
  return {
    mockRestore: () => {
      client.$transaction = original;
    },
  };
}

// Final-review finding: cuota-payment gastos used to get category: null.
test("POST /api/agrupadores/:id/pagar files the combined Expense under the 'cuotas' category", async () => {
  const group = await seedGroup();
  await seedItem({ groupId: group.id });

  const res = await POST(buildRequest(group.id), { params: { id: group.id } });
  const body = await res.json();

  const expense = await db.expense.findUnique({ where: { id: body.expenseId } });
  expect(expense?.category).toBe("cuotas");
});

// Final-review finding: a competing payment for one of the group's items
// landing between the per-item pre-check and the transaction used to throw
// P2002 (a 500). Now the whole attempt rolls back and is recomputed once,
// paying only what is still unpaid.
test("POST /api/agrupadores/:id/pagar recovers from a competing item payment landing between the pre-check and the create, paying only the rest", async () => {
  const group = await seedGroup();
  const raced = await seedItem({ groupId: group.id, name: "a", amountCents: 10000 });
  const other = await seedItem({ groupId: group.id, name: "b", amountCents: 25000 });

  const spy = raceBeforeFirstTransaction(() => seedPaymentFor(raced.id, currentYearMonth));

  const res = await POST(buildRequest(group.id), { params: { id: group.id } });
  spy.mockRestore();
  const body = await res.json();

  expect(res.status).toBe(201);
  expect(body.itemIds).toEqual([other.id]);
  const expense = await db.expense.findUnique({ where: { id: body.expenseId } });
  expect(expense?.amountCents).toBe(25000);
  expect(await db.recurringPayment.count()).toBe(2);
  // Competing payment's Expense + this one; the rolled-back attempt left nothing behind.
  expect(await db.expense.count()).toBe(2);
});

test("POST /api/agrupadores/:id/pagar returns 409 (not 500) when a competing payment covers the group's only payable item", async () => {
  const group = await seedGroup();
  const only = await seedItem({ groupId: group.id });

  const spy = raceBeforeFirstTransaction(() => seedPaymentFor(only.id, currentYearMonth));

  const res = await POST(buildRequest(group.id), { params: { id: group.id } });
  spy.mockRestore();

  expect(res.status).toBe(409);
  expect(await db.expense.count()).toBe(1);
});
