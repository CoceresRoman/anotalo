import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, expect, test } from "vitest";
import db from "../../../../lib/db";
import { DELETE, PATCH } from "./route";

// Each test seeds its own fixtures, so the table must be empty before every
// test runs — same pattern as src/app/api/ingresos/[id]/route.test.ts.
beforeEach(async () => {
  await db.saving.deleteMany();
  await db.note.deleteMany();
});

// Local helpers, same pattern as src/app/api/ingresos/[id]/route.test.ts.
function buildRequest({
  method = "PATCH",
  body,
}: {
  method?: "PATCH" | "DELETE";
  body?: unknown;
} = {}): NextRequest {
  return new NextRequest("http://localhost/api/ahorros/some-id", {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function seedSaving({
  amountCents,
  occurredAt = "2026-10-05",
  rawText = "ahorro de prueba",
}: {
  amountCents: number;
  occurredAt?: string;
  rawText?: string;
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
      occurredAt: new Date(occurredAt),
    },
  });
}

test("PATCH /api/ahorros/:id updates amountCents", async () => {
  const saving = await seedSaving({ amountCents: 100000 });

  const res = await PATCH(buildRequest({ method: "PATCH", body: { amountCents: 150000 } }), {
    params: { id: saving.id },
  });

  expect(res.status).toBe(200);
  const updated = await db.saving.findUnique({ where: { id: saving.id } });
  expect(updated?.amountCents).toBe(150000);
});

test("PATCH /api/ahorros/:id returns 404 for a non-existent id", async () => {
  const res = await PATCH(buildRequest({ body: { amountCents: 1000 } }), {
    params: { id: "does-not-exist" },
  });

  expect(res.status).toBe(404);
});

test("PATCH /api/ahorros/:id returns 400 for an invalid body", async () => {
  const saving = await seedSaving({ amountCents: 100000 });

  const res = await PATCH(buildRequest({ body: { amountCents: "not-a-number" } }), {
    params: { id: saving.id },
  });

  expect(res.status).toBe(400);
});

test("DELETE /api/ahorros/:id removes the saving and its note", async () => {
  const saving = await seedSaving({ amountCents: 100000 });

  const res = await DELETE(buildRequest({ method: "DELETE" }), {
    params: { id: saving.id },
  });

  expect(res.status).toBe(204);
  expect(await db.saving.findUnique({ where: { id: saving.id } })).toBeNull();
  expect(await db.note.findUnique({ where: { id: saving.noteId } })).toBeNull();
});

test("DELETE /api/ahorros/:id returns 404 for a non-existent id", async () => {
  const res = await DELETE(buildRequest({ method: "DELETE" }), {
    params: { id: "does-not-exist" },
  });

  expect(res.status).toBe(404);
});
