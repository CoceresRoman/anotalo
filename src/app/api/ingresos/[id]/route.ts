import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import db from "../../../../lib/db";
import { deleteNoteCascading } from "../../../../lib/noteDeletion";

const patchSchema = z.object({
  amountCents: z.number().int().optional(),
  isSalary: z.boolean().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const existing = await db.income.findUnique({ where: { id: params.id } });
  if (!existing) {
    return NextResponse.json({ error: "Income not found" }, { status: 404 });
  }

  const updated = await db.income.update({
    where: { id: params.id },
    data: parsed.data,
  });

  return NextResponse.json(updated, { status: 200 });
}

// An ingreso never has a Reminder/Calendar event attached to its Note, so
// deleteNoteCascading's "calendar_delete_failed" outcome can never happen
// here — unlike recordatorios/[id], this never needs to branch on it.
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const existing = await db.income.findUnique({ where: { id: params.id } });
  if (!existing) {
    return NextResponse.json({ error: "Income not found" }, { status: 404 });
  }

  await deleteNoteCascading(existing.noteId);

  return new NextResponse(null, { status: 204 });
}
