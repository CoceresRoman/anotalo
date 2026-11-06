import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import db from "../../../../lib/db";
import { deleteNoteCascading } from "../../../../lib/noteDeletion";

// No isSalary-equivalent field on Saving — amountCents is the only
// user-editable value (currency/occurredAt aren't edited from the web UI,
// same as ingresos).
const patchSchema = z.object({
  amountCents: z.number().int().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const existing = await db.saving.findUnique({ where: { id: params.id } });
  if (!existing) {
    return NextResponse.json({ error: "Saving not found" }, { status: 404 });
  }

  const updated = await db.saving.update({
    where: { id: params.id },
    data: parsed.data,
  });

  return NextResponse.json(updated, { status: 200 });
}

// An ahorro never has a Reminder/Calendar event attached to its Note, so
// deleteNoteCascading's "calendar_delete_failed" outcome can never happen
// here — unlike recordatorios/[id], this never needs to branch on it.
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const existing = await db.saving.findUnique({ where: { id: params.id } });
  if (!existing) {
    return NextResponse.json({ error: "Saving not found" }, { status: 404 });
  }

  await deleteNoteCascading(existing.noteId);

  return new NextResponse(null, { status: 204 });
}
