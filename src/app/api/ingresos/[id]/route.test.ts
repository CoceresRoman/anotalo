import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, expect, test } from "vitest";
import db from "../../../../lib/db";
import { DELETE, PATCH } from "./route";

// Each test seeds its own fixtures, so the table must be empty before every
// test runs — same pattern as src/app/api/gastos/[id]/route.test.ts.
beforeEach(async () => {
  await db.income.deleteMany();
  await db.note.deleteMany();
});

// Local helpers, same pattern as src/app/api/gastos/[id]/route.test.ts.
function buildRequest({
  method = "PATCH",
  body,
}: {
  method?: "PATCH" | "DELETE";
  body?: unknown;
} = {}): NextRequest {
  return new NextRequest("http://localhost/api/ingresos/some-id", {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function seedIncome({
  amountCents,
  isSalary,
  occurredAt = "2026-10-05",
  rawText = "ingreso de prueba",
}: {
  amountCents: number;
  isSalary: boolean;
  occurredAt?: string;
  rawText?: string;
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
      occurredAt: new Date(occurredAt),
    },
  });
}

test("PATCH /api/ingresos/:id updates amountCents and isSalary", async () => {
  const income = await seedIncome({ amountCents: 100000, isSalary: false });

  const res = await PATCH(
    buildRequest({ method: "PATCH", body: { amountCents: 150000, isSalary: true } }),
    { params: { id: income.id } }
  );

  expect(res.status).toBe(200);
  const updated = await db.income.findUnique({ where: { id: income.id } });
  expect(updated?.amountCents).toBe(150000);
  expect(updated?.isSalary).toBe(true);
});

test("PATCH /api/ingresos/:id returns 404 for a non-existent id", async () => {
  const res = await PATCH(buildRequest({ body: { amountCents: 1000 } }), {
    params: { id: "does-not-exist" },
  });

  expect(res.status).toBe(404);
});

test("PATCH /api/ingresos/:id returns 400 for an invalid body", async () => {
  const income = await seedIncome({ amountCents: 100000, isSalary: false });

  const res = await PATCH(buildRequest({ body: { amountCents: "not-a-number" } }), {
    params: { id: income.id },
  });

  expect(res.status).toBe(400);
});

test("DELETE /api/ingresos/:id removes the income and its note", async () => {
  const income = await seedIncome({ amountCents: 100000, isSalary: true });

  const res = await DELETE(buildRequest({ method: "DELETE" }), {
    params: { id: income.id },
  });

  expect(res.status).toBe(204);
  expect(await db.income.findUnique({ where: { id: income.id } })).toBeNull();
  expect(await db.note.findUnique({ where: { id: income.noteId } })).toBeNull();
});

test("DELETE /api/ingresos/:id returns 404 for a non-existent id", async () => {
  const res = await DELETE(buildRequest({ method: "DELETE" }), {
    params: { id: "does-not-exist" },
  });

  expect(res.status).toBe(404);
});
