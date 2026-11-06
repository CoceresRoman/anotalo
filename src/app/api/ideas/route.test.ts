import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, expect, test } from "vitest";
import db from "../../../lib/db";
import { GET } from "./route";

// Each test seeds its own fixtures, so the table must be empty before every
// test runs — same pattern as src/app/api/gastos/route.test.ts.
beforeEach(async () => {
  await db.note.deleteMany();
});

// Local helper, same pattern as src/app/api/gastos/route.test.ts.
function buildRequest({ url = "http://localhost/api/ideas" }: { url?: string } = {}): NextRequest {
  const fullUrl = url.startsWith("http") ? url : `http://localhost${url}`;
  return new NextRequest(fullUrl);
}

async function seedNote({ type, rawText }: { type: string; rawText: string }) {
  return db.note.create({
    data: {
      rawText,
      source: "text",
      type,
      whatsappMessageId: randomUUID(),
    },
  });
}

test("GET /api/ideas?q=curso returns only ideas whose text matches", async () => {
  await seedNote({ type: "idea", rawText: "armar un curso corto" });
  await seedNote({ type: "idea", rawText: "probar ese plugin" });
  const res = await GET(buildRequest({ url: "/api/ideas?q=curso" }));
  const body = await res.json();
  expect(body.items).toHaveLength(1);
  expect(body.items[0].rawText).toContain("curso");
});

test("GET /api/ideas with no q returns all ideas, most recent first", async () => {
  await seedNote({ type: "idea", rawText: "primera idea" });
  await seedNote({ type: "idea", rawText: "segunda idea" });

  const res = await GET(buildRequest({ url: "/api/ideas" }));
  const body = await res.json();

  expect(body.items).toHaveLength(2);
  expect(body.items[0].rawText).toBe("segunda idea");
  expect(body.items[1].rawText).toBe("primera idea");
});

test("GET /api/ideas excludes notes that are not type idea", async () => {
  await seedNote({ type: "idea", rawText: "una idea" });
  await seedNote({ type: "gasto", rawText: "un gasto" });
  await seedNote({ type: "recordatorio", rawText: "un recordatorio" });

  const res = await GET(buildRequest({ url: "/api/ideas" }));
  const body = await res.json();

  expect(body.items).toHaveLength(1);
  expect(body.items[0].rawText).toBe("una idea");
});

test("GET /api/ideas items only expose id, rawText, createdAt", async () => {
  await seedNote({ type: "idea", rawText: "idea con forma" });

  const res = await GET(buildRequest({ url: "/api/ideas" }));
  const body = await res.json();

  expect(body.items).toHaveLength(1);
  expect(Object.keys(body.items[0]).sort()).toEqual(["createdAt", "id", "rawText"]);
});
