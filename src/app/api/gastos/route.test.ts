import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, expect, test } from "vitest";
import db from "../../../lib/db";
import { GET } from "./route";

// Expense has a required FK to Note, so clear it first. Each test seeds its
// own fixtures, so the table must be empty before every test runs — tests
// in this file all target the same "2026-10" month and would otherwise
// pollute each other's totals.
beforeEach(async () => {
  await db.expense.deleteMany();
  await db.note.deleteMany();
});

// Local helpers, same pattern as src/app/api/auth/login/route.test.ts.
function buildRequest({
  url = "http://localhost/api/gastos",
}: {
  url?: string;
} = {}): NextRequest {
  const fullUrl = url.startsWith("http") ? url : `http://localhost${url}`;
  return new NextRequest(fullUrl);
}

// Date-only fixtures ("2026-10-05") are pinned to noon Argentina time:
// month boundaries are Argentina midnights, and a bare "2026-10-01"
// would be UTC midnight, i.e. still Sep 30 in Argentina.
function toInstant(occurredAt: string): Date {
  return new Date(occurredAt.includes("T") ? occurredAt : `${occurredAt}T12:00:00-03:00`);
}

async function seedExpense({
  amountCents,
  category,
  occurredAt,
  rawText = "gasto de prueba",
  currency,
}: {
  amountCents: number;
  category: string | null;
  occurredAt: string;
  rawText?: string;
  currency?: string;
}) {
  const note = await db.note.create({
    data: {
      rawText,
      source: "text",
      type: "gasto",
      whatsappMessageId: randomUUID(),
    },
  });
  return db.expense.create({
    data: {
      noteId: note.id,
      amountCents,
      category,
      occurredAt: toInstant(occurredAt),
      ...(currency ? { currency } : {}),
    },
  });
}

test("GET /api/gastos returns total and per-category totals for the given month", async () => {
  await seedExpense({ amountCents: 300000, category: "comida", occurredAt: "2026-10-05" });
  await seedExpense({ amountCents: 510000, category: "transporte", occurredAt: "2026-10-06" });

  const res = await GET(buildRequest({ url: "/api/gastos?month=2026-10" }));
  const body = await res.json();

  expect(body.totalCents).toBe(810000);
  expect(body.byCategory).toEqual({ comida: 300000, transporte: 510000 });
});

test("GET /api/gastos excludes expenses outside the requested month", async () => {
  await seedExpense({ amountCents: 100000, category: "comida", occurredAt: "2026-09-30" });
  await seedExpense({ amountCents: 200000, category: "comida", occurredAt: "2026-10-01" });
  await seedExpense({ amountCents: 300000, category: "comida", occurredAt: "2026-11-01" });

  const res = await GET(buildRequest({ url: "/api/gastos?month=2026-10" }));
  const body = await res.json();

  expect(body.totalCents).toBe(200000);
});

test("GET /api/gastos returns items with rawText from the joined Note", async () => {
  await seedExpense({
    amountCents: 320000,
    category: "comida",
    occurredAt: "2026-10-05",
    rawText: "cafe con leche",
  });

  const res = await GET(buildRequest({ url: "/api/gastos?month=2026-10" }));
  const body = await res.json();

  expect(body.items).toHaveLength(1);
  expect(body.items[0]).toMatchObject({
    rawText: "cafe con leche",
    amountCents: 320000,
    category: "comida",
  });
});

test("GET /api/gastos groups null-category expenses under a single bucket", async () => {
  await seedExpense({ amountCents: 100000, category: null, occurredAt: "2026-10-05" });
  await seedExpense({ amountCents: 50000, category: null, occurredAt: "2026-10-06" });

  const res = await GET(buildRequest({ url: "/api/gastos?month=2026-10" }));
  const body = await res.json();

  expect(body.totalCents).toBe(150000);
  expect(Object.values(body.byCategory).reduce((a: number, b) => a + (b as number), 0)).toBe(150000);
});

test("GET /api/gastos returns 400 for a missing or malformed month param", async () => {
  const resMissing = await GET(buildRequest({ url: "/api/gastos" }));
  expect(resMissing.status).toBe(400);

  const resMalformed = await GET(buildRequest({ url: "/api/gastos?month=not-a-month" }));
  expect(resMalformed.status).toBe(400);
});

// Month boundaries are Argentina midnights, not UTC (or the server's
// local) midnights — on a UTC server an expense at 23:00 on Oct 31 in
// Argentina (02:00Z Nov 1) used to land in November.
test("GET /api/gastos buckets expenses by Argentina calendar month, regardless of the server's timezone", async () => {
  const originalTz = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    await seedExpense({ amountCents: 100, category: "a", occurredAt: "2026-10-31T23:00:00-03:00" });
    await seedExpense({ amountCents: 200, category: "b", occurredAt: "2026-10-01T00:30:00-03:00" });
    await seedExpense({ amountCents: 400, category: "c", occurredAt: "2026-09-30T23:30:00-03:00" });
    await seedExpense({ amountCents: 800, category: "d", occurredAt: "2026-11-01T00:00:00-03:00" });

    const body = await (await GET(buildRequest({ url: "/api/gastos?month=2026-10" }))).json();

    expect(body.totalCents).toBe(300);
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

// Amounts in another currency are stored and listed, never summed into
// the peso totals (spec Non-goals: no multi-currency conversion).
test("GET /api/gastos only sums ARS expenses into the totals, but still lists non-ARS ones with their currency", async () => {
  await seedExpense({ amountCents: 300000, category: "comida", occurredAt: "2026-10-05" });
  await seedExpense({
    amountCents: 5000,
    category: "suscripciones",
    occurredAt: "2026-10-06",
    currency: "USD",
    rawText: "netflix u$s 50",
  });

  const body = await (await GET(buildRequest({ url: "/api/gastos?month=2026-10" }))).json();

  expect(body.totalCents).toBe(300000);
  expect(body.byCategory).toEqual({ comida: 300000 });
  expect(body.items).toHaveLength(2);
  const usd = body.items.find((i: { rawText: string }) => i.rawText === "netflix u$s 50");
  expect(usd).toMatchObject({ amountCents: 5000, currency: "USD" });
  expect(body.items.find((i: { rawText: string }) => i.rawText !== "netflix u$s 50").currency).toBe("ARS");
});
