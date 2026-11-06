import { NextRequest, NextResponse } from "next/server";
import { getPendingCuotaNamesForMonth } from "../../../../lib/cuotas";
import { toArgentinaDateString } from "../../../../lib/timezone";
import { sendSelfMessage } from "../../../../lib/whatsapp/connection";

// Same reasoning as src/app/api/dashboard/route.ts's own `dynamic` export:
// this route reads request.nextUrl.searchParams and process.env.CRON_SECRET
// on every call, so `next build` must never statically prerender it.
export const dynamic = "force-dynamic";

// Called by system cron on the VM (deploy/README.md), not by a logged-in
// browser — there's no session cookie to check (and middleware.ts excludes
// this path from that check entirely), so a shared secret in the query
// string is the only auth here. Exact string match against CRON_SECRET;
// a missing/unset env var or a missing/mismatched param both -> 401, and
// sendSelfMessage must never be reached in either case.
export async function GET(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get("secret");
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Current Argentina calendar month — same convention as
  // payItem/payGroup (src/lib/cuotas.ts) and the dashboard route.
  const yearMonth = toArgentinaDateString(new Date()).slice(0, 7);
  const names = await getPendingCuotaNamesForMonth(yearMonth);

  // Never send an empty WhatsApp message — nothing
  // pending just means nothing to remind about this month.
  if (names.length === 0) {
    return NextResponse.json({ sent: false });
  }

  const message = `Cuotas pendientes este mes:\n${names.map((name) => `- ${name}`).join("\n")}`;
  await sendSelfMessage(message);

  return NextResponse.json({ sent: true, count: names.length });
}
