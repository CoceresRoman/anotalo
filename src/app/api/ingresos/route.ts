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

  const incomes = await db.income.findMany({
    where: { occurredAt: { gte: range.start, lt: range.end } },
    include: { note: true },
    orderBy: { occurredAt: "desc" },
  });

  let sueldoCents = 0;
  let otrosIngresosCents = 0;
  const items = incomes.map((income) => {
    // Only pesos are summed (same invariant as /api/gastos). Other
    // currencies are listed with their own label but never converted or
    // added to sueldoCents/otrosIngresosCents.
    if (income.currency === config.defaultCurrency) {
      if (income.isSalary) {
        sueldoCents += income.amountCents;
      } else {
        otrosIngresosCents += income.amountCents;
      }
    }

    return {
      id: income.id,
      rawText: income.note.rawText,
      amountCents: income.amountCents,
      isSalary: income.isSalary,
      currency: income.currency,
      occurredAt: income.occurredAt,
    };
  });

  // defaultCurrency/locale let the "use client" ingresos page format
  // amounts correctly without importing config.ts itself (process.env
  // isn't inlined into the browser bundle — see src/lib/money.ts).
  return NextResponse.json({
    sueldoCents,
    otrosIngresosCents,
    items,
    defaultCurrency: config.defaultCurrency,
    locale: config.locale,
  });
}
