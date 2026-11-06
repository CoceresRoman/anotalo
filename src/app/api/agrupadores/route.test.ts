import { NextRequest } from "next/server";
import { beforeEach, expect, test } from "vitest";
import db from "../../../lib/db";
import { GET, POST } from "./route";

// Each test seeds its own fixtures, so every table involved must be empty
// before every test runs (same rationale as src/app/api/cuotas/route.test.ts).
beforeEach(async () => {
  await db.recurringPayment.deleteMany();
  await db.expense.deleteMany();
  await db.note.deleteMany();
  await db.recurringItem.deleteMany();
  await db.recurringGroup.deleteMany();
});

function buildGetRequest(): NextRequest {
  return new NextRequest("http://localhost/api/agrupadores");
}

function buildPostRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/agrupadores", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /api/agrupadores creates a group", async () => {
  const res = await POST(buildPostRequest({ name: "Tarjeta Mastercard" }));
  const body = await res.json();

  expect(res.status).toBe(201);
  expect(body).toMatchObject({ name: "Tarjeta Mastercard" });
  expect(typeof body.id).toBe("string");

  const created = await db.recurringGroup.findUnique({ where: { id: body.id } });
  expect(created).not.toBeNull();
});

test("GET /api/agrupadores lists all groups", async () => {
  await db.recurringGroup.create({ data: { name: "Tarjeta Visa" } });
  await db.recurringGroup.create({ data: { name: "Tarjeta Mastercard" } });

  const res = await GET(buildGetRequest());
  const body = await res.json();

  expect(body).toHaveLength(2);
  const names = body.map((g: { name: string }) => g.name).sort();
  expect(names).toEqual(["Tarjeta Mastercard", "Tarjeta Visa"]);
  for (const g of body) {
    expect(typeof g.id).toBe("string");
    expect(typeof g.name).toBe("string");
  }
});
