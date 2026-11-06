import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import db from "../../../lib/db";

export async function GET(_request: NextRequest) {
  const groups = await db.recurringGroup.findMany();

  const result = groups.map((group) => ({ id: group.id, name: group.name }));

  return NextResponse.json(result);
}

const postSchema = z.object({
  name: z.string(),
});

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsed = postSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const created = await db.recurringGroup.create({ data: parsed.data });

  return NextResponse.json(created, { status: 201 });
}
