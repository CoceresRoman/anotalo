import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import db from "../../../../lib/db";
import { EXPENSE_CATEGORIES } from "../../../../lib/expenseCategories";
import { deleteNoteCascading } from "../../../../lib/noteDeletion";

const patchSchema = z.object({
  amountCents: z.number().int().optional(),
  // "cuotas" is never a valid value here — it's written
  // only by cuotas.ts's payItem/payGroup — so a direct PATCH with it (the
  // the dropdown never offers it either) is rejected at the API layer.
  category: z.enum(EXPENSE_CATEGORIES).nullable().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const existing = await db.expense.findUnique({ where: { id: params.id } });
  if (!existing) {
    return NextResponse.json({ error: "Expense not found" }, { status: 404 });
  }

  const updated = await db.expense.update({
    where: { id: params.id },
    data: parsed.data,
  });

  return NextResponse.json(updated, { status: 200 });
}

// A gasto never has a Reminder/Calendar event attached to its Note, so
// deleteNoteCascading's "calendar_delete_failed" outcome can never happen
// here — unlike recordatorios/[id], this never needs to branch on it.
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const existing = await db.expense.findUnique({ where: { id: params.id } });
  if (!existing) {
    return NextResponse.json({ error: "Expense not found" }, { status: 404 });
  }

  await deleteNoteCascading(existing.noteId);

  return new NextResponse(null, { status: 204 });
}
