import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, expect, test } from "vitest";
import db from "../../../lib/db";
import { GET } from "./route";

// Each test seeds its own fixtures, so the table must be empty before every
// test runs — same pattern as src/app/api/ideas/route.test.ts.
beforeEach(async () => {
  await db.expense.deleteMany();
  await db.reminder.deleteMany();
  await db.note.deleteMany();
});

// Local helper, same pattern as src/app/api/gastos/route.test.ts.
function buildRequest({
  url = "http://localhost/api/sin-clasificar",
}: { url?: string } = {}): NextRequest {
  const fullUrl = url.startsWith("http") ? url : `http://localhost${url}`;
  return new NextRequest(fullUrl);
}

async function seedNote({
  type,
  rawText,
}: {
  type: string;
  rawText: string;
}) {
  return db.note.create({
    data: {
      rawText,
      source: "text",
      type,
      whatsappMessageId: randomUUID(),
    },
  });
}

test("GET /api/sin-clasificar returns only notes of type no_identificado", async () => {
  await seedNote({ type: "no_identificado", rawText: "no se entendió el audio" });
  await seedNote({ type: "idea", rawText: "una idea cualquiera" });

  const res = await GET(buildRequest({ url: "/api/sin-clasificar" }));
  const body = await res.json();

  expect(body.items).toHaveLength(1);
  expect(body.items[0].rawText).toBe("no se entendió el audio");
});

test("GET /api/sin-clasificar orders notes most-recent-first", async () => {
  await seedNote({ type: "no_identificado", rawText: "primera nota" });
  await seedNote({ type: "no_identificado", rawText: "segunda nota" });

  const res = await GET(buildRequest());
  const body = await res.json();

  expect(body.items).toHaveLength(2);
  expect(body.items[0].rawText).toBe("segunda nota");
  expect(body.items[1].rawText).toBe("primera nota");
});
