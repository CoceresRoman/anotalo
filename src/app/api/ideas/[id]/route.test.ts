import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, expect, test } from "vitest";
import db from "../../../../lib/db";
import { DELETE } from "./route";

// Each test seeds its own fixtures, so the table must be empty before every
// test runs — same pattern as src/app/api/gastos/[id]/route.test.ts.
beforeEach(async () => {
  await db.expense.deleteMany();
  await db.note.deleteMany();
});

// Local helper, same pattern as src/app/api/gastos/[id]/route.test.ts.
function buildRequest({ method = "DELETE" }: { method?: string } = {}): NextRequest {
  return new NextRequest("http://localhost/api/ideas/some-id", { method });
}

async function seedIdea({ rawText = "idea de prueba" }: { rawText?: string } = {}) {
  return db.note.create({
    data: {
      rawText,
      source: "text",
      type: "idea",
      whatsappMessageId: randomUUID(),
    },
  });
}

async function seedExpenseNote({ rawText = "gasto de prueba" }: { rawText?: string } = {}) {
  const note = await db.note.create({
    data: {
      rawText,
      source: "text",
      type: "gasto",
      whatsappMessageId: randomUUID(),
    },
  });
  await db.expense.create({
    data: {
      noteId: note.id,
      amountCents: 100000,
      category: null,
      occurredAt: note.createdAt,
    },
  });
  return note;
}

test("DELETE /api/ideas/:id removes the idea", async () => {
  const note = await seedIdea({ rawText: "app para libros" });
  const res = await DELETE(buildRequest(), { params: { id: note.id } });
  expect(res.status).toBe(204);
  expect(await db.note.findUnique({ where: { id: note.id } })).toBeNull();
});

test("DELETE /api/ideas/:id returns 404 for a non-existent id", async () => {
  const res = await DELETE(buildRequest(), { params: { id: "does-not-exist" } });
  expect(res.status).toBe(404);
});

test("DELETE /api/ideas/:id returns 404 for a note that isn't an idea (e.g. a gasto)", async () => {
  const note = await seedExpenseNote();
  const res = await DELETE(buildRequest(), { params: { id: note.id } });
  expect(res.status).toBe(404);
  expect(await db.note.findUnique({ where: { id: note.id } })).not.toBeNull();
});
