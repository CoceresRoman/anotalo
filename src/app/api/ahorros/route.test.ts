import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, expect, test } from "vitest";
import db from "../../../lib/db";
import { GET } from "./route";

// Saving has a required FK to Note, so clear it first. Each test seeds its
// own fixtures, so the table must be empty before every test runs — same
// pattern as src/app/api/ingresos/route.test.ts.
beforeEach(async () => {
  await db.saving.deleteMany();
  await db.note.deleteMany();
});

// Local helpers, same pattern as src/app/api/ingresos/route.test.ts.
function buildRequest({
  url = "http://localhost/api/ahorros",
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

async function seedSaving({
  amountCents,
  occurredAt,
  rawText = "ahorro de prueba",
  currency,
}: {
  amountCents: number;
  occurredAt: string;
  rawText?: string;
  currency?: string;
}) {
  const note = await db.note.create({
    data: {
      rawText,
      source: "text",
      type: "ahorro",
      whatsappMessageId: randomUUID(),
    },
  });
  return db.saving.create({
    data: {
      noteId: note.id,
      amountCents,
      occurredAt: toInstant(occurredAt),
      ...(currency ? { currency } : {}),
    },
  });
}

test("GET /api/ahorros returns totalAcumuladoCents summing ALL savings regardless of month, but mesCents/items only the requested month", async () => {
  await seedSaving({ amountCents: 500000, occurredAt: "2026-09-05", rawText: "ahorro setiembre" });
  await seedSaving({ amountCents: 300000, occurredAt: "2026-10-10", rawText: "ahorro octubre" });

  const res = await GET(buildRequest({ url: "/api/ahorros?month=2026-10" }));
  const body = await res.json();

  // Total acumulado: both months, no date filter.
  expect(body.totalAcumuladoCents).toBe(800000);
  // Mes-filtered: only October.
  expect(body.mesCents).toBe(300000);
  expect(body.items).toHaveLength(1);
  expect(body.items[0]).toMatchObject({ rawText: "ahorro octubre", amountCents: 300000 });
});

test("GET /api/ahorros's totalAcumuladoCents nets out a negative (withdrawal) row from a different month", async () => {
  await seedSaving({ amountCents: 1000000, occurredAt: "2026-09-05", rawText: "deposito" });
  await seedSaving({ amountCents: -200000, occurredAt: "2026-09-20", rawText: "retiro" });
  await seedSaving({ amountCents: 100000, occurredAt: "2026-10-10", rawText: "ahorro octubre" });

  const res = await GET(buildRequest({ url: "/api/ahorros?month=2026-10" }));
  const body = await res.json();

  expect(body.totalAcumuladoCents).toBe(900000);
  expect(body.mesCents).toBe(100000);
  expect(body.items).toHaveLength(1);
});

test("GET /api/ahorros excludes savings outside the requested month from mesCents/items", async () => {
  await seedSaving({ amountCents: 100000, occurredAt: "2026-09-30" });
  await seedSaving({ amountCents: 200000, occurredAt: "2026-10-01" });
  await seedSaving({ amountCents: 300000, occurredAt: "2026-11-01" });

  const res = await GET(buildRequest({ url: "/api/ahorros?month=2026-10" }));
  const body = await res.json();

  expect(body.mesCents).toBe(200000);
  expect(body.items).toHaveLength(1);
  expect(body.totalAcumuladoCents).toBe(600000);
});

test("GET /api/ahorros returns 400 for a missing or malformed month param", async () => {
  const resMissing = await GET(buildRequest({ url: "/api/ahorros" }));
  expect(resMissing.status).toBe(400);

  const resMalformed = await GET(buildRequest({ url: "/api/ahorros?month=not-a-month" }));
  expect(resMalformed.status).toBe(400);
});

test("GET /api/ahorros returns items with rawText, amountCents and currency from the joined Note", async () => {
  await seedSaving({ amountCents: 500000, occurredAt: "2026-10-05", rawText: "ahorro octubre" });

  const res = await GET(buildRequest({ url: "/api/ahorros?month=2026-10" }));
  const body = await res.json();

  expect(body.items).toHaveLength(1);
  expect(body.items[0]).toMatchObject({
    rawText: "ahorro octubre",
    amountCents: 500000,
    currency: "ARS",
  });
});

// Same invariant as /api/ingresos and /api/gastos: only ARS is summed
// into mesCents; another currency is listed but never summed.
test("GET /api/ahorros only sums ARS savings into mesCents, but still lists non-ARS ones with their currency", async () => {
  await seedSaving({ amountCents: 500000, occurredAt: "2026-10-05" });
  await seedSaving({
    amountCents: 10000,
    occurredAt: "2026-10-06",
    currency: "USD",
    rawText: "ahorro u$s 100",
  });

  const res = await GET(buildRequest({ url: "/api/ahorros?month=2026-10" }));
  const body = await res.json();

  expect(body.mesCents).toBe(500000);
  expect(body.items).toHaveLength(2);
  const usd = body.items.find((i: { rawText: string }) => i.rawText === "ahorro u$s 100");
  expect(usd).toMatchObject({ amountCents: 10000, currency: "USD" });
});

// The same rule applies to the acumulado total too (spec: "solo la moneda default suma
// a los totales") — no date filter, but a USD row from any month must never
// be added to a pesos total.
test("GET /api/ahorros's totalAcumuladoCents only sums default-currency savings, across all months", async () => {
  await seedSaving({ amountCents: 500000, occurredAt: "2026-09-05" });
  await seedSaving({ amountCents: 300000, occurredAt: "2026-10-05" });
  await seedSaving({ amountCents: 10000, occurredAt: "2026-09-06", currency: "USD" });
  await seedSaving({ amountCents: 20000, occurredAt: "2026-10-06", currency: "USD" });

  const res = await GET(buildRequest({ url: "/api/ahorros?month=2026-10" }));
  const body = await res.json();

  expect(body.totalAcumuladoCents).toBe(800000);
});
