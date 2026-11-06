import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, expect, test } from "vitest";
import db from "../../../lib/db";
import { GET } from "./route";

// Income has a required FK to Note, so clear it first. Each test seeds its
// own fixtures, so the table must be empty before every test runs — same
// pattern as src/app/api/gastos/route.test.ts.
beforeEach(async () => {
  await db.income.deleteMany();
  await db.note.deleteMany();
});

// Local helpers, same pattern as src/app/api/gastos/route.test.ts.
function buildRequest({
  url = "http://localhost/api/ingresos",
}: {
  url?: string;
} = {}): NextRequest {
  const fullUrl = url.startsWith("http") ? url : `http://localhost${url}`;
  return new NextRequest(fullUrl);
}

// Date-only fixtures ("2026-10-05") are pinned to noon Argentina time: month
// boundaries are Argentina midnights, and a bare "2026-10-01" would be
// UTC midnight, i.e. still Sep 30 in Argentina.
function toInstant(occurredAt: string): Date {
  return new Date(occurredAt.includes("T") ? occurredAt : `${occurredAt}T12:00:00-03:00`);
}

async function seedIncome({
  amountCents,
  isSalary,
  occurredAt,
  rawText = "ingreso de prueba",
  currency,
}: {
  amountCents: number;
  isSalary: boolean;
  occurredAt: string;
  rawText?: string;
  currency?: string;
}) {
  const note = await db.note.create({
    data: {
      rawText,
      source: "text",
      type: "ingreso",
      whatsappMessageId: randomUUID(),
    },
  });
  return db.income.create({
    data: {
      noteId: note.id,
      amountCents,
      isSalary,
      occurredAt: toInstant(occurredAt),
      ...(currency ? { currency } : {}),
    },
  });
}

test("GET /api/ingresos sums sueldo and otros ingresos separately for the given month", async () => {
  await seedIncome({ amountCents: 500000, isSalary: true, occurredAt: "2026-10-05" });
  await seedIncome({ amountCents: 300000, isSalary: true, occurredAt: "2026-10-10" });
  await seedIncome({ amountCents: 100000, isSalary: false, occurredAt: "2026-10-15" });

  const res = await GET(buildRequest({ url: "/api/ingresos?month=2026-10" }));
  const body = await res.json();

  expect(body.sueldoCents).toBe(800000);
  expect(body.otrosIngresosCents).toBe(100000);
  expect(body.items).toHaveLength(3);
});

test("GET /api/ingresos excludes income outside the requested month", async () => {
  await seedIncome({ amountCents: 100000, isSalary: true, occurredAt: "2026-09-30" });
  await seedIncome({ amountCents: 200000, isSalary: true, occurredAt: "2026-10-01" });
  await seedIncome({ amountCents: 300000, isSalary: false, occurredAt: "2026-11-01" });

  const res = await GET(buildRequest({ url: "/api/ingresos?month=2026-10" }));
  const body = await res.json();

  expect(body.sueldoCents).toBe(200000);
  expect(body.otrosIngresosCents).toBe(0);
  expect(body.items).toHaveLength(1);
});

test("GET /api/ingresos returns 400 for a missing or malformed month param", async () => {
  const resMissing = await GET(buildRequest({ url: "/api/ingresos" }));
  expect(resMissing.status).toBe(400);

  const resMalformed = await GET(buildRequest({ url: "/api/ingresos?month=not-a-month" }));
  expect(resMalformed.status).toBe(400);
});

test("GET /api/ingresos returns items with rawText, isSalary and currency from the joined Note", async () => {
  await seedIncome({
    amountCents: 500000,
    isSalary: true,
    occurredAt: "2026-10-05",
    rawText: "sueldo octubre",
  });

  const res = await GET(buildRequest({ url: "/api/ingresos?month=2026-10" }));
  const body = await res.json();

  expect(body.items).toHaveLength(1);
  expect(body.items[0]).toMatchObject({
    rawText: "sueldo octubre",
    amountCents: 500000,
    isSalary: true,
    currency: "ARS",
  });
});

// No multi-currency
// conversion anywhere new — sueldo/otros ingresos are assumed ARS,
// consistent with how gastos already works (only ARS is summed into the
// totals; another currency is listed but never summed). Same pattern as
// src/app/api/gastos/route.test.ts's "only sums ARS expenses..." test.
test("GET /api/ingresos only sums ARS income into sueldoCents/otrosIngresosCents, but still lists non-ARS ones with their currency", async () => {
  await seedIncome({ amountCents: 500000, isSalary: true, occurredAt: "2026-10-05" });
  await seedIncome({
    amountCents: 10000,
    isSalary: false,
    occurredAt: "2026-10-06",
    currency: "USD",
    rawText: "regalo u$s 100",
  });

  const res = await GET(buildRequest({ url: "/api/ingresos?month=2026-10" }));
  const body = await res.json();

  expect(body.sueldoCents).toBe(500000);
  expect(body.otrosIngresosCents).toBe(0);
  expect(body.items).toHaveLength(2);
  const usd = body.items.find((i: { rawText: string }) => i.rawText === "regalo u$s 100");
  expect(usd).toMatchObject({ amountCents: 10000, currency: "USD", isSalary: false });
  expect(
    body.items.find((i: { rawText: string }) => i.rawText !== "regalo u$s 100").currency
  ).toBe("ARS");
});
