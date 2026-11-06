import { NextRequest, NextResponse } from "next/server";
import { config } from "../../../lib/config";
import db from "../../../lib/db";
import { argentinaMonthRange } from "../../../lib/timezone";

// Bucket key used in `byCategory` for expenses with no category assigned.
// `Expense.category` is a plain nullable String (sqlite has no enum
// support), so this is just a grouping convenience, not a fixed category.
// Not exported: Next.js route files only allow specific exports (GET,
// POST, etc. and a few config options) — see src/app/gastos/page.tsx for
// the UI's own copy of this same key.
const NO_CATEGORY_KEY = "sin_categoria";

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

  const expenses = await db.expense.findMany({
    where: { occurredAt: { gte: range.start, lt: range.end } },
    include: { note: true },
    orderBy: { occurredAt: "desc" },
  });

  let totalCents = 0;
  const byCategory: Record<string, number> = {};
  const items = expenses.map((expense) => {
    // Only pesos are summed. Other currencies are listed with their
    // own label but never converted or added to the peso totals.
    if (expense.currency === config.defaultCurrency) {
      totalCents += expense.amountCents;
      const key = expense.category ?? NO_CATEGORY_KEY;
      byCategory[key] = (byCategory[key] ?? 0) + expense.amountCents;
    }

    return {
      id: expense.id,
      rawText: expense.note.rawText,
      amountCents: expense.amountCents,
      category: expense.category,
      currency: expense.currency,
      occurredAt: expense.occurredAt,
    };
  });

  // defaultCurrency/locale let the "use client" gastos page format amounts
  // correctly without importing config.ts itself (process.env isn't
  // inlined into the browser bundle — see src/lib/money.ts).
  return NextResponse.json({
    totalCents,
    byCategory,
    items,
    defaultCurrency: config.defaultCurrency,
    locale: config.locale,
  });
}
