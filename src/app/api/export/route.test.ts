import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, expect, test } from "vitest";
import db from "../../../lib/db";
import { GET } from "./route";

// Expense and Income both have a required FK to Note, so clear them first.
// Each test seeds its own fixtures, so the tables must be empty before
// every test runs — same pattern as src/app/api/gastos/route.test.ts.
beforeEach(async () => {
  await db.expense.deleteMany();
  await db.income.deleteMany();
  await db.note.deleteMany();
});

// Local helpers, same pattern as src/app/api/gastos/route.test.ts.
function buildRequest({
  url = "http://localhost/api/export",
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

function parseCsv(csv: string): string[][] {
  // The fixtures below never put a comma/newline in a field, so a naive
  // split is enough here (the brief explicitly allows this for the test).
  return csv
    .trim()
    .split("\n")
    .map((line) => line.split(","));
}

test("GET /api/export returns a CSV with one row per expense/income for the given month", async () => {
  await seedExpense({
    amountCents: 320000,
    category: "comida",
    occurredAt: "2026-10-05",
    rawText: "cafe con leche",
  });
  await seedExpense({
    amountCents: 500,
    category: "suscripciones",
    occurredAt: "2026-10-06",
    currency: "USD",
    rawText: "netflix u$s 5",
  });
  await seedIncome({
    amountCents: 1000000,
    isSalary: true,
    occurredAt: "2026-10-10",
    rawText: "sueldo octubre",
  });
  // Different month: must be excluded.
  await seedExpense({ amountCents: 100000, category: "comida", occurredAt: "2026-11-01" });

  const res = await GET(buildRequest({ url: "/api/export?month=2026-10" }));

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^text\/csv/);
  expect(res.headers.get("content-disposition")).toContain("2026-10");

  const csv = await res.text();
  const rows = parseCsv(csv);

  expect(rows[0]).toEqual(["fecha", "tipo", "categoria", "moneda", "monto", "texto"]);
  expect(rows).toHaveLength(4); // header + 3 rows

  const dataRows = rows.slice(1);

  const arsGasto = dataRows.find((r) => r[5] === "cafe con leche");
  expect(arsGasto).toBeDefined();
  expect(arsGasto).toEqual([arsGasto![0], "gasto", "comida", "ARS", "3200.00", "cafe con leche"]);

  const usdGasto = dataRows.find((r) => r[5] === "netflix u$s 5");
  expect(usdGasto).toBeDefined();
  expect(usdGasto).toEqual([usdGasto![0], "gasto", "suscripciones", "USD", "5.00", "netflix u$s 5"]);

  const ingreso = dataRows.find((r) => r[5] === "sueldo octubre");
  expect(ingreso).toBeDefined();
  expect(ingreso).toEqual([ingreso![0], "ingreso", "", "ARS", "10000.00", "sueldo octubre"]);
});

test("GET /api/export quotes a texto field that contains a comma", async () => {
  await seedExpense({
    amountCents: 100000,
    category: "comida",
    occurredAt: "2026-10-05",
    rawText: "pan, leche y huevos",
  });

  const res = await GET(buildRequest({ url: "/api/export?month=2026-10" }));
  const csv = await res.text();
  const lines = csv.trim().split("\n");

  expect(lines[1]).toContain('"pan, leche y huevos"');
});

// `texto` is the raw WhatsApp message and routinely has accented/ñ chars.
// Without a UTF-8 BOM, Excel on Windows (opening a downloaded .csv by
// double-click) doesn't reliably auto-detect UTF-8 and renders those as
// mojibake. Asserted on the raw bytes (not res.text()): the WHATWG
// encoding spec has utf-8 decoding strip a leading BOM from the decoded
// string, so `res.text()` would never show it even if it's on the wire.
test("GET /api/export prepends a UTF-8 BOM to the raw CSV bytes", async () => {
  await seedExpense({ amountCents: 100000, category: "comida", occurredAt: "2026-10-05" });

  const res = await GET(buildRequest({ url: "/api/export?month=2026-10" }));
  const bytes = new Uint8Array(await res.arrayBuffer());

  // UTF-8 BOM (U+FEFF) is the 3-byte sequence EF BB BF.
  expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);

  // ignoreBOM defaults to false: the decoder detects and strips the BOM,
  // so the decoded text itself starts right at the header.
  const decoded = new TextDecoder("utf-8").decode(bytes);
  expect(decoded.startsWith("fecha,tipo,categoria,moneda,monto,texto")).toBe(true);
});

test("GET /api/export returns 400 for a missing or malformed month param", async () => {
  const resMissing = await GET(buildRequest({ url: "/api/export" }));
  expect(resMissing.status).toBe(400);

  const resMalformed = await GET(buildRequest({ url: "/api/export?month=not-a-month" }));
  expect(resMalformed.status).toBe(400);
});
