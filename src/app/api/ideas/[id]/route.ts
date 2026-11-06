import { NextRequest, NextResponse } from "next/server";
import db from "../../../../lib/db";

// An idea note never has a Reminder (or Expense) row, so this never needs
// deleteNoteCascading — that helper's Calendar-aware cascade only
// matters for recordatorios. A plain db.note.delete is enough here.
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const note = await db.note.findUnique({ where: { id: params.id } });

  // 404 both when the id doesn't exist and when it exists but isn't an
  // idea (e.g. a gasto) — this endpoint must never delete the wrong type.
  if (!note || note.type !== "idea") {
    return NextResponse.json({ error: "Idea not found" }, { status: 404 });
  }

  await db.note.delete({ where: { id: note.id } });

  return new NextResponse(null, { status: 204 });
}
