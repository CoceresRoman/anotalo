import { NextRequest, NextResponse } from "next/server";
import { config } from "../../../lib/config";
import db from "../../../lib/db";
import { argentinaMonthRange } from "../../../lib/timezone";

function parseMonthParam(month: string | null): { start: Date; end: Date } | null {
  if (!month) return null;
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1; // Date months are 0-based.
  if (monthIndex < 0 || monthIndex > 11) return null;

  // Argentina calendar month: "2026-10" is Oct 1 00:00 ART up to (not
  // including) Nov 1 00:00 ART — not UTC midnights, and never the server's
  // own local timezone.
  return argentinaMonthRange(year, monthIndex);
}

export async function GET(request: NextRequest) {
  const month = request.nextUrl.searchParams.get("month");
  const range = parseMonthParam(month);

  if (!range) {
    return NextResponse.json(
      { error: "Missing or malformed 'month' query param, expected YYYY-MM" },
      { status: 400 }
    );
  }

  // Ahorros is the one money concept in this app that's a running,
  // cumulative balance rather than something that resets every calendar
  // month (unlike Sueldo/Otros ingresos/Gastos/Cuotas) — so
  // totalAcumuladoCents deliberately has NO date filter at all: it sums
  // every Saving row ever recorded (deposits positive, any future
  // withdrawals negative). This is the number the user cares about for
  // "can I afford to save up for X". It IS filtered by currency, though:
  // only the default currency adds to totals (same as mesCents below) —
  // a USD deposit summed as if it were pesos would make the total meaningless.
  const totalAcumulado = await db.saving.aggregate({
    _sum: { amountCents: true },
    where: { currency: config.defaultCurrency },
  });

  const savings = await db.saving.findMany({
    where: { occurredAt: { gte: range.start, lt: range.end } },
    include: { note: true },
    orderBy: { occurredAt: "desc" },
  });

  let mesCents = 0;
  const items = savings.map((saving) => {
    // Only pesos are summed into mesCents (same invariant as
    // /api/ingresos and /api/gastos). Other currencies are listed with
    // their own label but never added to mesCents.
    if (saving.currency === config.defaultCurrency) {
      mesCents += saving.amountCents;
    }

    return {
      id: saving.id,
      rawText: saving.note.rawText,
      amountCents: saving.amountCents,
      currency: saving.currency,
      occurredAt: saving.occurredAt,
    };
  });

  // defaultCurrency/locale let the "use client" ahorros page format
  // amounts correctly without importing config.ts itself (process.env
  // isn't inlined into the browser bundle — see src/lib/money.ts).
  return NextResponse.json({
    totalAcumuladoCents: totalAcumulado._sum.amountCents ?? 0,
    mesCents,
    items,
    defaultCurrency: config.defaultCurrency,
    locale: config.locale,
  });
}
