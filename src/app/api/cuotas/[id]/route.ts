import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import db from "../../../../lib/db";

// Same rules as POST /api/cuotas (src/app/api/cuotas/route.ts).
const YEAR_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const patchSchema = z.object({
  name: z.string().optional(),
  amountCents: z.number().int().positive().optional(),
  totalInstallments: z.number().int().nullable().optional(),
  startInstallment: z.number().int().positive().optional(),
  startYearMonth: z.string().regex(YEAR_MONTH_PATTERN).optional(),
  groupId: z.string().nullable().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const existing = await db.recurringItem.findUnique({ where: { id: params.id } });
  if (!existing) {
    return NextResponse.json({ error: "RecurringItem not found" }, { status: 404 });
  }

  // Checked up front so a nonexistent group is a clean 400 instead of a raw
  // FK-constraint 500 from the update below (null still means "ungroup").
  if (parsed.data.groupId !== undefined && parsed.data.groupId !== null) {
    const group = await db.recurringGroup.findUnique({ where: { id: parsed.data.groupId } });
    if (!group) {
      return NextResponse.json({ error: "RecurringGroup not found" }, { status: 400 });
    }
  }

  const updated = await db.recurringItem.update({
    where: { id: params.id },
    data: parsed.data,
  });

  return NextResponse.json(updated, { status: 200 });
}

// No onDelete: Cascade on RecurringPayment.itemId (prisma/schema.prisma),
// so a plain recurringItem.delete would throw on the FK if the item has
// historical payments. Delete those RecurringPayment rows first, inside a
// $transaction with the item delete — this never touches Expense/Note,
// which must survive as real gasto history even after the cuota
// definition is gone (only the "this expense came from that cuota" link
// is lost).
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const existing = await db.recurringItem.findUnique({ where: { id: params.id } });
  if (!existing) {
    return NextResponse.json({ error: "RecurringItem not found" }, { status: 404 });
  }

  await db.$transaction([
    db.recurringPayment.deleteMany({ where: { itemId: params.id } }),
    db.recurringItem.delete({ where: { id: params.id } }),
  ]);

  return new NextResponse(null, { status: 204 });
}
