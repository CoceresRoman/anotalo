import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import db from "../../../../lib/db";

const patchSchema = z.object({
  name: z.string(),
});

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const existing = await db.recurringGroup.findUnique({ where: { id: params.id } });
  if (!existing) {
    return NextResponse.json({ error: "RecurringGroup not found" }, { status: 404 });
  }

  const updated = await db.recurringGroup.update({
    where: { id: params.id },
    data: parsed.data,
  });

  return NextResponse.json(updated, { status: 200 });
}

// Never delete a group that still has RecurringItems hanging off it — the
// user has to ungroup or delete them first (brief: "nunca borrar un
// agrupador con cuotas colgando").
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const existing = await db.recurringGroup.findUnique({ where: { id: params.id } });
  if (!existing) {
    return NextResponse.json({ error: "RecurringGroup not found" }, { status: 404 });
  }

  const itemCount = await db.recurringItem.count({ where: { groupId: params.id } });
  if (itemCount > 0) {
    return NextResponse.json({ error: "RecurringGroup still has items" }, { status: 409 });
  }

  await db.recurringGroup.delete({ where: { id: params.id } });

  return new NextResponse(null, { status: 204 });
}
