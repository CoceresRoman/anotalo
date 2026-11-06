import { NextRequest } from "next/server";
import { beforeEach, expect, test } from "vitest";
import db from "../../../../lib/db";
import { DELETE, PATCH } from "./route";

beforeEach(async () => {
  await db.recurringPayment.deleteMany();
  await db.expense.deleteMany();
  await db.note.deleteMany();
  await db.recurringItem.deleteMany();
  await db.recurringGroup.deleteMany();
});

function buildPatchRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/agrupadores/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function buildDeleteRequest(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/agrupadores/${id}`, { method: "DELETE" });
}

test("PATCH /api/agrupadores/:id renames a group", async () => {
  const group = await db.recurringGroup.create({ data: { name: "Tarjeta Visa" } });

  const res = await PATCH(buildPatchRequest(group.id, { name: "Tarjeta Visa Platinum" }), {
    params: { id: group.id },
  });
  const body = await res.json();

  expect(res.status).toBe(200);
  expect(body.name).toBe("Tarjeta Visa Platinum");

  const updated = await db.recurringGroup.findUnique({ where: { id: group.id } });
  expect(updated?.name).toBe("Tarjeta Visa Platinum");
});

test("PATCH /api/agrupadores/:id returns 404 for a non-existent id", async () => {
  const res = await PATCH(buildPatchRequest("does-not-exist", { name: "x" }), {
    params: { id: "does-not-exist" },
  });

  expect(res.status).toBe(404);
});

test("DELETE /api/agrupadores/:id removes an empty group", async () => {
  const group = await db.recurringGroup.create({ data: { name: "Tarjeta Visa" } });

  const res = await DELETE(buildDeleteRequest(group.id), { params: { id: group.id } });

  expect(res.status).toBe(204);
  const deleted = await db.recurringGroup.findUnique({ where: { id: group.id } });
  expect(deleted).toBeNull();
});

test("DELETE /api/agrupadores/:id returns 409 when it still has items", async () => {
  const group = await db.recurringGroup.create({ data: { name: "Tarjeta Visa" } });
  await db.recurringItem.create({
    data: {
      name: "cuota de prueba",
      amountCents: 10000,
      totalInstallments: null,
      startInstallment: 1,
      startYearMonth: "2026-01",
      groupId: group.id,
    },
  });

  const res = await DELETE(buildDeleteRequest(group.id), { params: { id: group.id } });

  expect(res.status).toBe(409);
  const stillThere = await db.recurringGroup.findUnique({ where: { id: group.id } });
  expect(stillThere).not.toBeNull();
});

test("DELETE /api/agrupadores/:id returns 404 for a non-existent id", async () => {
  const res = await DELETE(buildDeleteRequest("does-not-exist"), { params: { id: "does-not-exist" } });

  expect(res.status).toBe(404);
});
