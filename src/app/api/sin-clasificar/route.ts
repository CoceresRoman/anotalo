import { NextRequest, NextResponse } from "next/server";
import db from "../../../lib/db";

// Forces this route to be rendered per-request under `next start`. Without
// this, `next build` statically prerenders it (its GET handler never reads
// `request`), which would freeze the response at build time and serve stale
// data forever in production.
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest) {
  const notes = await db.note.findMany({
    where: { type: "no_identificado" },
    orderBy: { createdAt: "desc" },
  });

  const items = notes.map((note) => ({
    id: note.id,
    rawText: note.rawText,
    source: note.source,
    createdAt: note.createdAt,
  }));

  return NextResponse.json({ items });
}
