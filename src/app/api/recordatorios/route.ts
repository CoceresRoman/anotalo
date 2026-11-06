import { NextRequest, NextResponse } from "next/server";
import db from "../../../lib/db";

// Forces this route to be rendered per-request under `next start`. Without
// this, `next build` statically prerenders it (its GET handler never reads
// `request`), which would freeze the response at build time and serve stale
// data forever in production.
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest) {
  const reminders = await db.reminder.findMany({
    include: { note: true },
    orderBy: { createdAt: "desc" },
  });

  const items = reminders.map((reminder) => ({
    id: reminder.id,
    rawText: reminder.note.rawText,
    parsedDatetime: reminder.parsedDatetime,
    status: reminder.status,
    calendarEventId: reminder.calendarEventId,
  }));

  return NextResponse.json({ items });
}
