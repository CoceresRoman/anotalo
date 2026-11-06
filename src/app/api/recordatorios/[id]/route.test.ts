import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, expect, test, vi } from "vitest";
import db from "../../../../lib/db";

// deleteNoteCascading owns the Calendar-delete/transaction
// ordering and is tested in isolation in src/lib/noteDeletion.test.ts —
// mocked here so this route's own contract (it looks up the Reminder,
// hands reminder.noteId to deleteNoteCascading, and maps the result to a
// status code) is tested independently. Same pattern as
// src/app/api/sin-clasificar/[id]/route.test.ts.
const mockDeleteNoteCascading = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/noteDeletion", () => ({ deleteNoteCascading: mockDeleteNoteCascading }));

import { DELETE } from "./route";

// Reminder has a required FK to Note, so clear it first. Each test seeds
// its own fixtures — same pattern as src/app/api/gastos/[id]/route.test.ts.
beforeEach(async () => {
  await db.reminder.deleteMany();
  await db.note.deleteMany();
  mockDeleteNoteCascading.mockReset();
});

// Local helper, same pattern as src/app/api/gastos/[id]/route.test.ts.
function buildRequest({ method = "DELETE" }: { method?: string } = {}): NextRequest {
  return new NextRequest("http://localhost/api/recordatorios/some-id", { method });
}

async function seedConfirmedReminder({
  rawText = "recordatorio de prueba",
}: { rawText?: string } = {}) {
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
      status: "confirmed",
      calendarEventId: "evt-abc",
      parsedDatetime: new Date("2026-11-04T15:00:00Z"),
    },
  });
}

test("DELETE /api/recordatorios/:id removes the reminder and its note", async () => {
  mockDeleteNoteCascading.mockResolvedValueOnce("deleted");
  const reminder = await seedConfirmedReminder();
  const res = await DELETE(buildRequest(), { params: { id: reminder.id } });
  expect(res.status).toBe(204);
  expect(mockDeleteNoteCascading).toHaveBeenCalledWith(reminder.noteId);
});

test("DELETE /api/recordatorios/:id returns 404 for a non-existent id", async () => {
  const res = await DELETE(buildRequest(), { params: { id: "does-not-exist" } });
  expect(res.status).toBe(404);
  expect(mockDeleteNoteCascading).not.toHaveBeenCalled();
});

test("DELETE /api/recordatorios/:id returns 502 when the Calendar delete fails, and nothing is removed", async () => {
  mockDeleteNoteCascading.mockResolvedValueOnce("calendar_delete_failed");
  const reminder = await seedConfirmedReminder();
  const res = await DELETE(buildRequest(), { params: { id: reminder.id } });
  expect(res.status).toBe(502);
  expect(await db.reminder.findUnique({ where: { id: reminder.id } })).not.toBeNull();
});

// A reminder still awaiting_confirmation/confirming has no stable
// target to delete yet (deleteMatch.ts and the dashboard route exclude it
// the same way) — deleting it mid-flight could orphan a Calendar event or
// leave a dangling WhatsApp yes/no prompt.
test("DELETE /api/recordatorios/:id returns 409 for a reminder pending confirmation and does not call deleteNoteCascading", async () => {
  const note = await db.note.create({
    data: {
      rawText: "turno con el dentista",
      source: "text",
      type: "recordatorio",
      whatsappMessageId: randomUUID(),
    },
  });
  const reminder = await db.reminder.create({
    data: {
      noteId: note.id,
      status: "awaiting_confirmation",
      calendarEventId: null,
      parsedDatetime: new Date("2026-11-04T15:00:00Z"),
    },
  });

  const res = await DELETE(buildRequest(), { params: { id: reminder.id } });

  expect(res.status).toBe(409);
  expect(mockDeleteNoteCascading).not.toHaveBeenCalled();
  expect(await db.reminder.findUnique({ where: { id: reminder.id } })).not.toBeNull();
});
