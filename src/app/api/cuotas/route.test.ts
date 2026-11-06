import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, expect, test } from "vitest";
import db from "../../../lib/db";
import { GET, POST } from "./route";

// Each test seeds its own fixtures, so every table involved must be empty
// before every test runs (same rationale as src/app/api/gastos/route.test.ts).
// Order matters: RecurringPayment/Expense have FKs into Note/RecurringItem.
beforeEach(async () => {
  await db.recurringPayment.deleteMany();
  await db.expense.deleteMany();
  await db.note.deleteMany();
  await db.recurringItem.deleteMany();
  await db.recurringGroup.deleteMany();
});

function buildGetRequest(url = "/api/cuotas"): NextRequest {
  const fullUrl = url.startsWith("http") ? url : `http://localhost${url}`;
  return new NextRequest(fullUrl);
}

function buildPostRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/cuotas", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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
  await db.recurringPayment.create({ data: { itemId, yearMonth, noteId: note.id } });
  return expense;
}

test("GET /api/cuotas lists only items active in the requested month, with currentInstallment and active computed", async () => {
  const active = await seedItem({
    name: "activa",
    totalInstallments: null,
    startInstallment: 1,
    startYearMonth: "2026-01",
  });
  const finished = await seedItem({
    name: "terminada",
    totalInstallments: 3,
    startInstallment: 1,
    startYearMonth: "2026-01",
  });

  const res = await GET(buildGetRequest("/api/cuotas?month=2026-06"));
  const body = await res.json();

  expect(body.items).toHaveLength(2);
  const activeItem = body.items.find((i: { id: string }) => i.id === active.id);
  const finishedItem = body.items.find((i: { id: string }) => i.id === finished.id);
  expect(activeItem.active).toBe(true);
  expect(activeItem.currentInstallment).toBe(6);
  expect(finishedItem.active).toBe(false);
  expect(finishedItem.currentInstallment).toBe(6);
});

test("GET /api/cuotas marks paidExpenseId when a RecurringPayment exists for that item and month", async () => {
  const item = await seedItem({ startYearMonth: "2026-01" });
  const expense = await seedPaymentFor(item.id, "2026-06");

  const res = await GET(buildGetRequest("/api/cuotas?month=2026-06"));
  const body = await res.json();

  expect(body.items[0].paidExpenseId).toBe(expense.id);
});

test("GET /api/cuotas marks paidExpenseId null when there is no payment for that month", async () => {
  await seedItem({ startYearMonth: "2026-01" });

  const res = await GET(buildGetRequest("/api/cuotas?month=2026-06"));
  const body = await res.json();

  expect(body.items[0].paidExpenseId).toBeNull();
});

test("POST /api/cuotas creates a RecurringItem with the given fields", async () => {
  const res = await POST(
    buildPostRequest({
      name: "compra en 12 cuotas",
      amountCents: 500000,
      totalInstallments: 12,
      startInstallment: 5,
      startYearMonth: "2026-06",
      groupId: null,
    })
  );
  const body = await res.json();

  expect(res.status).toBe(201);
  expect(body).toMatchObject({
    name: "compra en 12 cuotas",
    amountCents: 500000,
    totalInstallments: 12,
    startInstallment: 5,
    startYearMonth: "2026-06",
    groupId: null,
  });
  const created = await db.recurringItem.findUnique({ where: { id: body.id } });
  expect(created).not.toBeNull();
});

test("POST /api/cuotas defaults startInstallment to 1 when omitted", async () => {
  const res = await POST(
    buildPostRequest({
      name: "suscripcion",
      amountCents: 100000,
      totalInstallments: null,
      startYearMonth: "2026-06",
      groupId: null,
    })
  );
  const body = await res.json();

  expect(res.status).toBe(201);
  expect(body.startInstallment).toBe(1);
});

// Final-review finding: loose POST validation. A malformed startYearMonth
// made an indefinite item "active forever" (NaN in the month-diff math),
// zero/negative amounts and installments were accepted, and a nonexistent
// groupId surfaced as a raw FK-constraint 500.
const validPostBody = {
  name: "cuota",
  amountCents: 100000,
  totalInstallments: null,
  startYearMonth: "2026-06",
  groupId: null,
};

test.each([
  ["a malformed startYearMonth", { startYearMonth: "junio" }],
  ["a startYearMonth with an out-of-range month", { startYearMonth: "2026-13" }],
  ["a zero amountCents", { amountCents: 0 }],
  ["a negative amountCents", { amountCents: -500 }],
  ["a zero startInstallment", { startInstallment: 0 }],
  ["a negative startInstallment", { startInstallment: -1 }],
])("POST /api/cuotas rejects %s with 400 and creates nothing", async (_label, override) => {
  const res = await POST(buildPostRequest({ ...validPostBody, ...override }));

  expect(res.status).toBe(400);
  expect(await db.recurringItem.count()).toBe(0);
});

test("POST /api/cuotas returns 400 (not a FK 500) for a nonexistent groupId", async () => {
  const res = await POST(buildPostRequest({ ...validPostBody, groupId: "does-not-exist" }));

  expect(res.status).toBe(400);
  expect(await db.recurringItem.count()).toBe(0);
});

test("POST /api/cuotas accepts an existing groupId", async () => {
  const group = await db.recurringGroup.create({ data: { name: "Tarjeta" } });

  const res = await POST(buildPostRequest({ ...validPostBody, groupId: group.id }));

  expect(res.status).toBe(201);
  expect((await res.json()).groupId).toBe(group.id);
});
