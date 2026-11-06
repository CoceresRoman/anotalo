import { NextRequest, NextResponse } from "next/server";
import { config } from "../../../lib/config";
import { isActiveInMonth } from "../../../lib/cuotas";
import db from "../../../lib/db";
import { PENDING_CONFIRMATION_STATUSES } from "../../../lib/reminders";
import { argentinaDateParts, argentinaDayBoundary, argentinaMonthRange, toArgentinaDateString } from "../../../lib/timezone";

// Forces this route to be rendered per-request under `next start`. Without
// this, `next build` statically prerenders it (its GET handler never reads
// `request`), which would freeze the response at build time and serve stale
// data forever in production.
export const dynamic = "force-dynamic";

// Same convention as src/app/api/gastos/route.ts's own NO_CATEGORY_KEY
// (mirrored here, not imported — route files only allow specific exports).
// Unlike /api/gastos, this response is presentational JSON, not an internal
// grouping key, so the human-readable label is used directly as the
// `category` string for the null bucket instead of a snake_case key.
const NO_CATEGORY_LABEL = "Sin categoría";

export async function GET(_request: NextRequest) {
  const now = new Date();

  // The current Argentina calendar month, not the server's local one — the
  // production VM runs in UTC, and now.getFullYear()/getMonth() would be
  // off by a month right around month boundaries (see src/lib/timezone.ts).
  const nowParts = argentinaDateParts(now);
  const monthRange = argentinaMonthRange(Number(nowParts.year), Number(nowParts.month) - 1);
  // "YYYY-MM", same slice-off-the-day convention already used by
  // src/app/(app)/cuotas/page.tsx's currentMonth() — the month a cuota
  // payment made right now would land in.
  const yearMonth = toArgentinaDateString(now).slice(0, 7);

  const [
    monthExpenseAgg,
    expensesByCategoryGroups,
    sueldoAgg,
    otrosIngresosAgg,
    ahorroTotalAgg,
    ahorroMesAgg,
    ideaCount,
    unclassifiedCount,
    activeReminderCount,
    recentNotes,
    cuotaItems,
  ] = await Promise.all([
      db.expense.aggregate({
        _sum: { amountCents: true },
        where: { currency: config.defaultCurrency, occurredAt: { gte: monthRange.start, lt: monthRange.end } },
      }),
      // Same where as monthExpenseAgg above, grouped by category — feeds
      // the dashboard's category breakdown chart.
      db.expense.groupBy({
        by: ["category"],
        _sum: { amountCents: true },
        where: { currency: config.defaultCurrency, occurredAt: { gte: monthRange.start, lt: monthRange.end } },
      }),
      // Same monthRange as monthExpenseAgg above — reused, not recomputed,
      // so a gasto from a previous month can never leak into this month's
      // sueldo/saldo.
      db.income.aggregate({
        _sum: { amountCents: true },
        where: { isSalary: true, currency: config.defaultCurrency, occurredAt: { gte: monthRange.start, lt: monthRange.end } },
      }),
      db.income.aggregate({
        _sum: { amountCents: true },
        where: { isSalary: false, currency: config.defaultCurrency, occurredAt: { gte: monthRange.start, lt: monthRange.end } },
      }),
      // Ahorros is the one money concept in this app that's a running,
      // cumulative balance rather than something that resets every
      // calendar month — same shape as /api/ahorros's totalAcumuladoCents:
      // deliberately NO date filter, so it sums every default-currency
      // Saving row ever recorded (deposits positive, withdrawals negative).
      // Only the currency filter applies (only the default currency
      // adds to totals, same as ahorroMesAgg right below).
      db.saving.aggregate({
        _sum: { amountCents: true },
        where: { currency: config.defaultCurrency },
      }),
      // Same monthRange as sueldoAgg/otrosIngresosAgg above — the net
      // (deposits and withdrawals) of just this month's Saving rows, which
      // is what saldoCents subtracts below.
      db.saving.aggregate({
        _sum: { amountCents: true },
        where: { currency: config.defaultCurrency, occurredAt: { gte: monthRange.start, lt: monthRange.end } },
      }),
      db.note.count({ where: { type: "idea" } }),
      db.note.count({ where: { type: "no_identificado" } }),
      db.reminder.count({
        where: {
          OR: [
            { status: { in: ["queued", "awaiting_confirmation", "confirming"] } },
            { status: "confirmed", parsedDatetime: { gt: now } },
          ],
        },
      }),
      db.note.findMany({
        include: { expense: true, reminder: true, income: true, saving: true },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
      db.recurringItem.findMany({
        include: {
          payments: { where: { yearMonth }, include: { note: { include: { expense: true } } } },
        },
      }),
    ]);

  const monthExpenseCents = monthExpenseAgg._sum.amountCents ?? 0;
  const sueldoCents = sueldoAgg._sum.amountCents ?? 0;
  const otrosIngresosCents = otrosIngresosAgg._sum.amountCents ?? 0;
  const ahorroTotalCents = ahorroTotalAgg._sum.amountCents ?? 0;
  // Net of this month's Saving rows (deposits minus withdrawals, since a
  // withdrawal is stored as a negative amountCents) — a positive net this
  // month REDUCES saldoCents because that money already left what's
  // spendable; a net withdrawal gives some of it back.
  const ahorroMesCents = ahorroMesAgg._sum.amountCents ?? 0;
  const saldoCents = sueldoCents + otrosIngresosCents - monthExpenseCents - ahorroMesCents;

  // Only cuotas active this month count toward either total — one that
  // already ended (installments exhausted) isn't due, so it's neither
  // pending nor paid. "Pagadas" sums the Expense a payment actually
  // created, not the item's nominal amountCents — payItem/payGroup accept
  // an override amount (src/lib/cuotas.ts), so what was really paid can
  // differ from the cuota's own amount. A grouped payment shares ONE
  // Expense across several items' RecurringPayment rows, so that Expense is
  // collected by id and summed once, never once per item sharing it.
  let cuotasPendientesCents = 0;
  const paidExpenseAmounts = new Map<string, number>();
  for (const item of cuotaItems) {
    if (!isActiveInMonth(item, yearMonth)) continue;
    const expense = item.payments[0]?.note.expense;
    if (!expense) {
      cuotasPendientesCents += item.amountCents;
    } else {
      paidExpenseAmounts.set(expense.id, expense.amountCents);
    }
  }
  const cuotasPagadasCents = Array.from(paidExpenseAmounts.values()).reduce((sum, cents) => sum + cents, 0);

  const expensesByCategory = expensesByCategoryGroups
    .map((group) => ({
      category: group.category ?? NO_CATEGORY_LABEL,
      amountCents: group._sum.amountCents ?? 0,
    }))
    .filter((entry) => entry.amountCents > 0)
    .sort((a, b) => b.amountCents - a.amountCents);

  const last7DaysExpenses = await Promise.all(
    Array.from({ length: 7 }, (_, i) => 6 - i).map(async (daysAgo) => {
      const date = toArgentinaDateString(new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000));
      const start = argentinaDayBoundary(date, false);
      const end = argentinaDayBoundary(date, true);
      const agg = await db.expense.aggregate({
        _sum: { amountCents: true },
        where: { currency: config.defaultCurrency, occurredAt: { gte: start, lte: end } },
      });
      return { date, totalCents: agg._sum.amountCents ?? 0 };
    })
  );

  const recentNotesResponse = recentNotes.map((note) => {
    let deletable = false;
    let deleteTargetId = "";

    if (note.type === "idea") {
      deletable = true;
      deleteTargetId = note.id;
    } else if (note.type === "recordatorio" && note.reminder && !PENDING_CONFIRMATION_STATUSES.includes(note.reminder.status)) {
      deletable = true;
      deleteTargetId = note.reminder.id;
    } else if (note.type === "gasto" && note.expense) {
      deletable = true;
      deleteTargetId = note.expense.id;
    } else if (note.type === "ingreso" && note.income) {
      deletable = true;
      deleteTargetId = note.income.id;
    } else if (note.type === "ahorro" && note.saving) {
      deletable = true;
      deleteTargetId = note.saving.id;
    }

    return {
      id: note.id,
      type: note.type as "gasto" | "idea" | "recordatorio" | "no_identificado" | "ingreso" | "ahorro",
      rawText: note.rawText,
      createdAt: note.createdAt,
      deletable,
      deleteTargetId,
    };
  });

  return NextResponse.json({
    monthExpenseCents,
    sueldoCents,
    otrosIngresosCents,
    ahorroTotalCents,
    ahorroMesCents,
    saldoCents,
    cuotasPendientesCents,
    cuotasPagadasCents,
    ideaCount,
    activeReminderCount,
    unclassifiedCount,
    last7DaysExpenses,
    expensesByCategory,
    recentNotes: recentNotesResponse,
    // So the "use client" dashboard page can format these cents correctly
    // without importing config.ts itself (process.env isn't inlined into
    // the browser bundle — see src/lib/money.ts).
    defaultCurrency: config.defaultCurrency,
    locale: config.locale,
  });
}
