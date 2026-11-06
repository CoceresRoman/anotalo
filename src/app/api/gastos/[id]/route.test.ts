import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, expect, test } from "vitest";
import db from "../../../../lib/db";
import { DELETE, PATCH } from "./route";

// Keep each test's fixtures isolated from the others (same rationale as
// src/app/api/gastos/route.test.ts).
beforeEach(async () => {
  await db.expense.deleteMany();
  await db.note.deleteMany();
});

// Local helpers, same pattern as src/app/api/auth/login/route.test.ts.
function buildRequest({
  method = "PATCH",
  body,
}: {
  method?: "PATCH" | "DELETE";
  body?: unknown;
} = {}): NextRequest {
  return new NextRequest("http://localhost/api/gastos/some-id", {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function seedExpense({
  amountCents,
  category,
  occurredAt = "2026-10-05",
  rawText = "gasto de prueba",
}: {
  amountCents: number;
  category: string | null;
  occurredAt?: string;
  rawText?: string;
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
      occurredAt: new Date(occurredAt),
    },
  });
}

test("PATCH /api/gastos/:id updates category and amount", async () => {
  const expense = await seedExpense({ amountCents: 100000, category: null });

  const res = await PATCH(
    buildRequest({ method: "PATCH", body: { amountCents: 150000, category: "Comida" } }),
    { params: { id: expense.id } }
  );

  expect(res.status).toBe(200);
  const updated = await db.expense.findUnique({ where: { id: expense.id } });
  expect(updated?.amountCents).toBe(150000);
  expect(updated?.category).toBe("Comida");
});

test("PATCH /api/gastos/:id can set category back to null", async () => {
  const expense = await seedExpense({ amountCents: 100000, category: "comida" });

  const res = await PATCH(buildRequest({ body: { category: null } }), {
    params: { id: expense.id },
  });

  expect(res.status).toBe(200);
  const updated = await db.expense.findUnique({ where: { id: expense.id } });
  expect(updated?.category).toBeNull();
  expect(updated?.amountCents).toBe(100000);
});

test("PATCH /api/gastos/:id returns 404 for a non-existent expense", async () => {
  const res = await PATCH(buildRequest({ body: { amountCents: 1000 } }), {
    params: { id: "does-not-exist" },
  });

  expect(res.status).toBe(404);
});

test("PATCH /api/gastos/:id returns 400 for an invalid body", async () => {
  const expense = await seedExpense({ amountCents: 100000, category: null });

  const res = await PATCH(buildRequest({ body: { amountCents: "not-a-number" } }), {
    params: { id: expense.id },
  });

  expect(res.status).toBe(400);
});

// "cuotas" is written only by cuotas.ts's payItem/payGroup,
// never settable through this API — a direct PATCH (bypassing the
// dropdown, which never offers it either) must still be rejected here.
test("PATCH /api/gastos/:id rejects setting category to 'cuotas'", async () => {
  const expense = await seedExpense({ amountCents: 100000, category: null });

  const res = await PATCH(buildRequest({ body: { category: "cuotas" } }), {
    params: { id: expense.id },
  });

  expect(res.status).toBe(400);
  const unchanged = await db.expense.findUnique({ where: { id: expense.id } });
  expect(unchanged?.category).toBeNull();
});

test("PATCH /api/gastos/:id still accepts a valid fixed category", async () => {
  const expense = await seedExpense({ amountCents: 100000, category: null });

  const res = await PATCH(buildRequest({ body: { category: "Salud" } }), {
    params: { id: expense.id },
  });

  expect(res.status).toBe(200);
  const updated = await db.expense.findUnique({ where: { id: expense.id } });
  expect(updated?.category).toBe("Salud");
});

test("DELETE /api/gastos/:id removes the expense and its note", async () => {
  const expense = await seedExpense({ amountCents: 100000, category: "comida" });

  const res = await DELETE(buildRequest({ method: "DELETE" }), {
    params: { id: expense.id },
  });

  expect(res.status).toBe(204);
  expect(await db.expense.findUnique({ where: { id: expense.id } })).toBeNull();
  expect(await db.note.findUnique({ where: { id: expense.noteId } })).toBeNull();
});

test("DELETE /api/gastos/:id returns 404 for a non-existent id", async () => {
  const res = await DELETE(buildRequest({ method: "DELETE" }), {
    params: { id: "does-not-exist" },
  });

  expect(res.status).toBe(404);
});
