import { NextRequest, NextResponse } from "next/server";
import db from "../../../lib/db";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q");

  const notes = await db.note.findMany({
    where: {
      type: "idea",
      ...(q ? { rawText: { contains: q } } : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  const items = notes.map((note) => ({
    id: note.id,
    rawText: note.rawText,
    createdAt: note.createdAt,
  }));

  return NextResponse.json({ items });
}
