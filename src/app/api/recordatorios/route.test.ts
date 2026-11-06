import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, expect, test } from "vitest";
import db from "../../../lib/db";
import { GET } from "./route";

// Reminder has a required FK to Note, so clear it first. Each test seeds its
// own fixtures, so the table must be empty before every test runs — same
// pattern as src/app/api/gastos/route.test.ts.
beforeEach(async () => {
  await db.reminder.deleteMany();
  await db.note.deleteMany();
});

// Local helper, same pattern as src/app/api/gastos/route.test.ts.
function buildRequest({
  url = "http://localhost/api/recordatorios",
}: { url?: string } = {}): NextRequest {
  const fullUrl = url.startsWith("http") ? url : `http://localhost${url}`;
  return new NextRequest(fullUrl);
}

async function seedReminder({
  status,
  calendarEventId,
  parsedDatetime,
  rawText = "recordatorio de prueba",
}: {
  status: string;
  calendarEventId: string | null;
  parsedDatetime: string | null;
  rawText?: string;
}) {
  const note = await db.note.create({
    data: {
      rawText,
      source: "text",
      type: "recordatorio",
      whatsappMessageId: randomUUID(),
    },
  });
  return db.reminder.create({
    data: {
      noteId: note.id,
      status,
      calendarEventId,
      parsedDatetime: parsedDatetime ? new Date(parsedDatetime) : null,
    },
  });
}

test("GET /api/recordatorios returns reminders with their sync status", async () => {
  await seedReminder({ status: "confirmed", calendarEventId: "evt1", parsedDatetime: "2026-10-31T15:00:00Z" });
  await seedReminder({ status: "ambiguous_no_date", calendarEventId: null, parsedDatetime: null });
  const res = await GET(buildRequest({ url: "/api/recordatorios" }));
  const body = await res.json();
  expect(body.items).toHaveLength(2);
  expect(body.items.find((i: any) => i.status === "confirmed").calendarEventId).toBe("evt1");
});

test("GET /api/recordatorios orders reminders most-recent-first", async () => {
  await seedReminder({
    status: "queued",
    calendarEventId: null,
    parsedDatetime: null,
    rawText: "primer recordatorio",
  });
  await seedReminder({
    status: "queued",
    calendarEventId: null,
    parsedDatetime: null,
    rawText: "segundo recordatorio",
  });

  const res = await GET(buildRequest());
  const body = await res.json();

  expect(body.items).toHaveLength(2);
  expect(body.items[0].rawText).toBe("segundo recordatorio");
  expect(body.items[1].rawText).toBe("primer recordatorio");
});

test("GET /api/recordatorios items expose rawText from the joined Note", async () => {
  await seedReminder({
    status: "confirmed",
    calendarEventId: "evt2",
    parsedDatetime: "2026-11-04T10:00:00Z",
    rawText: "turno con el dentista",
  });

  const res = await GET(buildRequest());
  const body = await res.json();

  expect(body.items).toHaveLength(1);
  expect(body.items[0]).toMatchObject({
    rawText: "turno con el dentista",
    status: "confirmed",
    calendarEventId: "evt2",
  });
  expect(new Date(body.items[0].parsedDatetime).toISOString()).toBe("2026-11-04T10:00:00.000Z");
});

test("GET /api/recordatorios items only expose id, rawText, parsedDatetime, status, calendarEventId", async () => {
  await seedReminder({ status: "queued", calendarEventId: null, parsedDatetime: null });

  const res = await GET(buildRequest());
  const body = await res.json();

  expect(body.items).toHaveLength(1);
  expect(Object.keys(body.items[0]).sort()).toEqual(
    ["calendarEventId", "id", "parsedDatetime", "rawText", "status"].sort()
  );
});
