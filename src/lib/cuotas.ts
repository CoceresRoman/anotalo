// Cálculo puro de vigencia de cuotas recurrentes (sin acceso a DB; todo se
// deriva de los campos de un RecurringItem y de strings "YYYY-MM") más
// payItem/payGroup — estas DOS sí tocan la DB: son la lógica de "crear el
// Note+Expense+RecurringPayment de un pago" extraída de
// src/app/api/cuotas/[id]/pagar/route.ts y
// src/app/api/agrupadores/[id]/pagar/route.ts para que ambos
// endpoints HTTP y el flujo de WhatsApp (cuotaPaymentFlow.ts) la
// compartan desde un único lugar, en vez de reimplementarla o hacer que el
// bot le pegue a su propia API.
import { randomUUID } from "node:crypto";
import db from "./db";
import { toArgentinaDateString } from "./timezone";
import { CUOTA_EXPENSE_CATEGORY } from "./expenseCategories";

export { CUOTA_EXPENSE_CATEGORY };

type YearMonth = { year: number; month: number };

// The "already paid this month" pre-checks below run outside the payment
// transaction, so a double-click or a web+WhatsApp race can still land a
// competing RecurringPayment in between — the
// @@unique([itemId, yearMonth]) create then throws P2002, which the whole
// transaction rolls back on. Detected here so payItem/payGroup can map it
// to their clean outcomes instead of surfacing a raw 500.
function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

function parseYearMonth(value: string): YearMonth {
  const [year, month] = value.split("-").map(Number);
  return { year, month };
}

function elapsedMonths(startYearMonth: string, yearMonth: string): number {
  const start = parseYearMonth(startYearMonth);
  const target = parseYearMonth(yearMonth);
  return (target.year - start.year) * 12 + (target.month - start.month);
}

/**
 * `yearMonth` desplazado `n` meses (negativo hacia atrás), cruzando años.
 * Misma aritmética que el `addMonths` del cliente en
 * src/app/(app)/cuotas/page.tsx, ahora server-side y exportada —
 * src/lib/whatsapp/purchaseFeasibility.ts la usa para proyectar
 * meses futuros y para ubicar los 3 meses cerrados anteriores al actual.
 */
export function addMonthsToYearMonth(yearMonth: string, n: number): string {
  const { year, month } = parseYearMonth(yearMonth);
  const total = year * 12 + (month - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** Cuota (1-based) vigente para `item` en `yearMonth`, contando desde item.startInstallment en item.startYearMonth. */
export function installmentNumberFor(
  item: { startInstallment: number; startYearMonth: string },
  yearMonth: string
): number {
  return item.startInstallment + elapsedMonths(item.startYearMonth, yearMonth);
}

/**
 * true si la cuota calculada todavía no superó totalInstallments (o si
 * totalInstallments es null — indefinida) Y yearMonth no es anterior a
 * startYearMonth.
 */
export function isActiveInMonth(
  item: {
    startInstallment: number;
    startYearMonth: string;
    totalInstallments: number | null;
  },
  yearMonth: string
): boolean {
  if (elapsedMonths(item.startYearMonth, yearMonth) < 0) return false;
  return (
    item.totalInstallments === null ||
    installmentNumberFor(item, yearMonth) <= item.totalInstallments
  );
}

// Pays a single RecurringItem: creates a Note+Expense for `overrideAmountCents
// ?? item.amountCents` and the RecurringPayment linking them for the current
// (Argentina) yearMonth. Exact same checks/order as the pre-extraction inline
// logic in src/app/api/cuotas/[id]/pagar/route.ts — moved here
// unchanged so that route and src/lib/whatsapp/cuotaPaymentFlow.ts
// share one implementation.
export async function payItem(
  itemId: string,
  overrideAmountCents: number | null
): Promise<{ expenseId: string } | "not_active" | "already_paid" | "not_found"> {
  const item = await db.recurringItem.findUnique({ where: { id: itemId } });
  if (!item) return "not_found";

  const yearMonth = toArgentinaDateString(new Date()).slice(0, 7);

  if (!isActiveInMonth(item, yearMonth)) return "not_active";

  const existingPayment = await db.recurringPayment.findUnique({
    where: { itemId_yearMonth: { itemId: item.id, yearMonth } },
  });
  if (existingPayment) return "already_paid";

  const amountCents = overrideAmountCents ?? item.amountCents;

  let expenseId: string;
  try {
    expenseId = await db.$transaction(async (tx) => {
      const note = await tx.note.create({
        data: {
          rawText: item.name,
          source: "text",
          type: "gasto",
          // Not a real WhatsApp message, but whatsappMessageId is @unique and
          // non-nullable (Note model) — a "web:" prefixed random id can never
          // collide with a real WhatsApp message id.
          whatsappMessageId: `web:${randomUUID()}`,
        },
      });
      const expense = await tx.expense.create({
        data: {
          noteId: note.id,
          amountCents,
          category: CUOTA_EXPENSE_CATEGORY,
          occurredAt: new Date(),
        },
      });
      await tx.recurringPayment.create({
        data: { itemId: item.id, yearMonth, noteId: note.id },
      });
      return expense.id;
    });
  } catch (err) {
    // A competing payment for this same item+month won the race (see
    // isUniqueConstraintError) — same outcome as the pre-check above.
    if (isUniqueConstraintError(err)) return "already_paid";
    throw err;
  }

  return { expenseId };
}

// Pays every RecurringItem under `groupId` that is BOTH active this month
// AND not yet paid this month, in one combined Note+Expense (all the
// RecurringPayment rows created here share the same noteId — schema comment,
// so deleting that one shared Note later undoes the whole group
// payment in a single step). Exact same checks/order as the pre-extraction
// inline logic in src/app/api/agrupadores/[id]/pagar/route.ts.
export async function payGroup(
  groupId: string,
  overrideAmountCents: number | null,
  retryOnRace = true
): Promise<{ expenseId: string; itemIds: string[] } | "nothing_to_pay" | "not_found"> {
  const group = await db.recurringGroup.findUnique({ where: { id: groupId } });
  if (!group) return "not_found";

  const yearMonth = toArgentinaDateString(new Date()).slice(0, 7);

  const items = await db.recurringItem.findMany({ where: { groupId: group.id } });

  const payable: typeof items = [];
  for (const item of items) {
    if (!isActiveInMonth(item, yearMonth)) continue;
    const existingPayment = await db.recurringPayment.findUnique({
      where: { itemId_yearMonth: { itemId: item.id, yearMonth } },
    });
    if (existingPayment) continue;
    payable.push(item);
  }

  if (payable.length === 0) return "nothing_to_pay";

  const amountCents =
    overrideAmountCents ?? payable.reduce((sum, item) => sum + item.amountCents, 0);

  let expenseId: string;
  try {
    expenseId = await db.$transaction(async (tx) => {
      const note = await tx.note.create({
        data: {
          rawText: group.name,
          source: "text",
          type: "gasto",
          // Not a real WhatsApp message, but whatsappMessageId is @unique and
          // non-nullable (Note model) — a "web:" prefixed random id can never
          // collide with a real WhatsApp message id.
          whatsappMessageId: `web:${randomUUID()}`,
        },
      });
      const expense = await tx.expense.create({
        data: {
          noteId: note.id,
          amountCents,
          category: CUOTA_EXPENSE_CATEGORY,
          occurredAt: new Date(),
        },
      });
      for (const item of payable) {
        await tx.recurringPayment.create({
          data: { itemId: item.id, yearMonth, noteId: note.id },
        });
      }
      return expense.id;
    });
  } catch (err) {
    // A competing payment for one of `payable` won the race (see
    // isUniqueConstraintError) and the whole transaction rolled back.
    // There is no "already_paid" outcome for a group — some of its other
    // items may still be unpaid — so recompute once from scratch: that
    // pays whatever is still payable, or returns "nothing_to_pay".
      if (isUniqueConstraintError(err)) {
      return retryOnRace ? payGroup(groupId, overrideAmountCents, false) : "nothing_to_pay";
    }
    throw err;
  }

  return { expenseId, itemIds: payable.map((item) => item.id) };
}

// Names of every active, unpaid item/group for `yearMonth` — feeds the
// monthly WhatsApp reminder (src/app/api/cron/cuota-reminder/route.ts).
// Mirrors the exact same loop already in
// src/app/api/dashboard/route.ts (cuotaItems + isActiveInMonth + checking
// item.payments[0]), but collects names instead of totals, and dedupes a
// grouped item to its group's name — once per group, never once per
// member — since payGroup above settles all of a group's members together
// in one message anyway.
export async function getPendingCuotaNamesForMonth(yearMonth: string): Promise<string[]> {
  const cuotaItems = await db.recurringItem.findMany({
    include: {
      group: true,
      payments: { where: { yearMonth } },
    },
  });

  const names: string[] = [];
  const seenGroupIds = new Set<string>();
  for (const item of cuotaItems) {
    if (!isActiveInMonth(item, yearMonth)) continue;
    if (item.payments[0]) continue;

    if (item.groupId) {
      if (seenGroupIds.has(item.groupId)) continue;
      seenGroupIds.add(item.groupId);
      names.push(item.group?.name ?? item.name);
    } else {
      names.push(item.name);
    }
  }
  return names;
}
