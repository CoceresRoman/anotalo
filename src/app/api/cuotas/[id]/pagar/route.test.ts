import { NextRequest } from "next/server";
import { beforeEach, expect, test } from "vitest";
import db from "../../../../../lib/db";
import { toArgentinaDateString } from "../../../../../lib/timezone";
import { POST } from "./route";

// Same rationale as src/app/api/cuotas/route.test.ts.
beforeEach(async () => {
  await db.recurringPayment.deleteMany();
  await db.expense.deleteMany();
  await db.note.deleteMany();
  await db.recurringItem.deleteMany();
});

const currentYearMonth = toArgentinaDateString(new Date()).slice(0, 7);

function buildRequest(id: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/cuotas/${id}/pagar`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

async function seedItem({
  name = "cuota de prueba",
  amountCents = 10000,
  totalInstallments = null as number | null,
  startInstallment = 1,
  startYearMonth = currentYearMonth,
  groupId = null as string | null,
}) {
  return db.recurringItem.create({
    data: { name, amountCents, totalInstallments, startInstallment, startYearMonth, groupId },
  });
}

test("POST /api/cuotas/:id/pagar creates a Note+Expense for the item's amount and a RecurringPayment linking them", async () => {
  const item = await seedItem({ amountCents: 50000, name: "gimnasio" });

  const res = await POST(buildRequest(item.id), { params: { id: item.id } });
  const body = await res.json();

  expect(res.status).toBe(201);
  expect(typeof body.expenseId).toBe("string");

  const expense = await db.expense.findUnique({ where: { id: body.expenseId }, include: { note: true } });
  expect(expense?.amountCents).toBe(50000);
  expect(expense?.note.rawText).toBe("gimnasio");
  expect(expense?.note.type).toBe("gasto");

  const payment = await db.recurringPayment.findUnique({
    where: { itemId_yearMonth: { itemId: item.id, yearMonth: currentYearMonth } },
  });
  expect(payment?.noteId).toBe(expense?.noteId);
});

test("POST /api/cuotas/:id/pagar with an amountCents override uses that amount instead of the item's own", async () => {
  const item = await seedItem({ amountCents: 50000 });

  const res = await POST(buildRequest(item.id, { amountCents: 99000 }), { params: { id: item.id } });
  const body = await res.json();

  expect(res.status).toBe(201);
  const expense = await db.expense.findUnique({ where: { id: body.expenseId } });
  expect(expense?.amountCents).toBe(99000);
});

test("POST /api/cuotas/:id/pagar returns 409 when the item is not active this month", async () => {
  // startYearMonth far in the past with totalInstallments already exceeded
  // by the current month.
  const item = await seedItem({ startYearMonth: "2000-01", totalInstallments: 1, startInstallment: 1 });

  const res = await POST(buildRequest(item.id), { params: { id: item.id } });

  expect(res.status).toBe(409);
  expect(await db.recurringPayment.findMany({ where: { itemId: item.id } })).toHaveLength(0);
});

test("POST /api/cuotas/:id/pagar returns 409 when the item is already paid this month", async () => {
  const item = await seedItem({});
  const first = await POST(buildRequest(item.id), { params: { id: item.id } });
  expect(first.status).toBe(201);

  const second = await POST(buildRequest(item.id), { params: { id: item.id } });

  expect(second.status).toBe(409);
  const payments = await db.recurringPayment.findMany({ where: { itemId: item.id } });
  expect(payments).toHaveLength(1);
});

test("POST /api/cuotas/:id/pagar returns 404 for a non-existent id", async () => {
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

// Final-review finding: cuota-payment gastos used to get category: null and
// show up under "Sin categoría" in the Gastos breakdown.
test("POST /api/cuotas/:id/pagar files the created Expense under the 'cuotas' category", async () => {
  const item = await seedItem({});

  const res = await POST(buildRequest(item.id), { params: { id: item.id } });
  const body = await res.json();

  const expense = await db.expense.findUnique({ where: { id: body.expenseId } });
  expect(expense?.category).toBe("cuotas");
});

// Final-review finding: the "already paid this month" pre-check runs outside
// the transaction, so a double-click (or web+WhatsApp race) could land a
// competing RecurringPayment between that check and the create — the
// @@unique([itemId, yearMonth]) create then threw P2002 (a 500) instead of
// the clean 409. Simulated by creating the competing payment right before the
// transaction runs (raceBeforeFirstTransaction).
test("POST /api/cuotas/:id/pagar returns 409 (not 500) when a competing payment lands between the pre-check and the create", async () => {
  const item = await seedItem({});

  const spy = raceBeforeFirstTransaction(async () => {
    const note = await db.note.create({
      data: { rawText: "pago concurrente", source: "text", type: "gasto", whatsappMessageId: `web:race-${item.id}` },
    });
    await db.expense.create({ data: { noteId: note.id, amountCents: 10000, occurredAt: new Date() } });
    await db.recurringPayment.create({ data: { itemId: item.id, yearMonth: currentYearMonth, noteId: note.id } });
  });

  const res = await POST(buildRequest(item.id), { params: { id: item.id } });
  spy.mockRestore();

  expect(res.status).toBe(409);
  expect(await db.recurringPayment.count({ where: { itemId: item.id } })).toBe(1);
  // The losing transaction rolled back: only the competing payment's Note/Expense exist.
  expect(await db.expense.count()).toBe(1);
  expect(await db.note.count()).toBe(1);
});
