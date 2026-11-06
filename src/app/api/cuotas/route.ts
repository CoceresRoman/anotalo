import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { config } from "../../../lib/config";
import db from "../../../lib/db";
import { installmentNumberFor, isActiveInMonth } from "../../../lib/cuotas";

function parseMonthParam(month: string | null): string | null {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return null;
  return month;
}

export async function GET(request: NextRequest) {
  const month = parseMonthParam(request.nextUrl.searchParams.get("month"));

  if (!month) {
    return NextResponse.json(
      { error: "Missing or malformed 'month' query param, expected YYYY-MM" },
      { status: 400 }
    );
  }

  const items = await db.recurringItem.findMany({
    include: {
      payments: {
        where: { yearMonth: month },
        include: { note: { include: { expense: true } } },
      },
    },
  });

  const result = items.map((item) => ({
    id: item.id,
    name: item.name,
    amountCents: item.amountCents,
    totalInstallments: item.totalInstallments,
    currentInstallment: installmentNumberFor(item, month),
    groupId: item.groupId,
    active: isActiveInMonth(item, month),
    paidExpenseId: item.payments[0]?.note.expense?.id ?? null,
  }));

  // defaultCurrency/locale let the "use client" cuotas page format amounts
  // correctly without importing config.ts itself (process.env isn't
  // inlined into the browser bundle — see src/lib/money.ts). RecurringItem
  // has no currency field of its own (schema.prisma) — its amountCents is
  // always in the app's default currency — so this is the only currency
  // info that response needs.
  return NextResponse.json({ items: result, defaultCurrency: config.defaultCurrency, locale: config.locale });
}

// "YYYY-MM" with a real month (01-12): a malformed startYearMonth turns the
// month-diff math in src/lib/cuotas.ts into NaN, which makes an indefinite
// item count as active in every month forever.
const YEAR_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const postSchema = z.object({
  name: z.string(),
  amountCents: z.number().int().positive(),
  totalInstallments: z.number().int().nullable(),
  startInstallment: z.number().int().positive().optional().default(1),
  startYearMonth: z.string().regex(YEAR_MONTH_PATTERN),
  groupId: z.string().nullable(),
});

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsed = postSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // Checked up front so a nonexistent group is a clean 400 instead of a raw
  // FK-constraint 500 from the create below.
  if (parsed.data.groupId !== null) {
    const group = await db.recurringGroup.findUnique({ where: { id: parsed.data.groupId } });
    if (!group) {
      return NextResponse.json({ error: "RecurringGroup not found" }, { status: 400 });
    }
  }

  const created = await db.recurringItem.create({ data: parsed.data });

  return NextResponse.json(created, { status: 201 });
}
