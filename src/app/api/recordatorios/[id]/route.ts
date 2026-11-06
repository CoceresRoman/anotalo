import { NextRequest, NextResponse } from "next/server";
import db from "../../../../lib/db";
import { deleteNoteCascading } from "../../../../lib/noteDeletion";
import { PENDING_CONFIRMATION_STATUSES } from "../../../../lib/reminders";

// GET /api/recordatorios maps reminder.id (not note.id) as the public id,
// so this route's :id param is a Reminder id too — look it up here and
// hand its noteId (not the route param itself) to deleteNoteCascading,
// which owns the Calendar-delete/transaction ordering.
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const reminder = await db.reminder.findUnique({ where: { id: params.id } });

  if (!reminder) {
    return NextResponse.json({ error: "Reminder not found" }, { status: 404 });
  }

  // A reminder still awaiting_confirmation/confirming has no stable
  // target to delete yet — deleting it mid-"confirming" (Calendar write in
  // flight) can orphan a Calendar event, and deleting an
  // "awaiting_confirmation" one leaves its WhatsApp yes/no prompt open.
  if (PENDING_CONFIRMATION_STATUSES.includes(reminder.status)) {
    return NextResponse.json({ error: "Reminder is pending confirmation" }, { status: 409 });
  }

  const result = await deleteNoteCascading(reminder.noteId);

  if (result === "calendar_delete_failed") {
    return NextResponse.json(
      { error: "Failed to delete the associated Calendar event" },
      { status: 502 }
    );
  }

  return new NextResponse(null, { status: 204 });
}
