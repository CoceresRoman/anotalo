import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import db from "../../../lib/db";
import { GET } from "./route";

// Pinned "now": 2026-10-15T09:00:00 Argentina time (mid-month, mid-day),
// so month/day boundary math in the tests below has no edge cases to
// worry about unless a test deliberately seeds near one.
const NOW_ISO = "2026-10-15T12:00:00Z";

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW_ISO));
  // Reminder/Expense/Income all have a required FK to Note, so clear them
  // first — same pattern as src/app/api/gastos/route.test.ts. RecurringPayment
  // has FKs into both Note and RecurringItem, so it goes first of all.
  await db.recurringPayment.deleteMany();
  await db.reminder.deleteMany();
  await db.expense.deleteMany();
  await db.income.deleteMany();
  await db.saving.deleteMany();
  await db.note.deleteMany();
  await db.recurringItem.deleteMany();
  await db.recurringGroup.deleteMany();
});

afterEach(() => {
  vi.useRealTimers();
});

// Local helper, same pattern as src/app/api/recordatorios/route.test.ts.
function buildRequest(): NextRequest {
  return new NextRequest("http://localhost/api/dashboard");
}

async function seedNote({
  type,
  rawText = "nota de prueba",
  createdAt,
}: {
  type: "gasto" | "idea" | "recordatorio" | "no_identificado" | "ingreso" | "ahorro";
  rawText?: string;
  createdAt?: Date;
}) {
  return db.note.create({
    data: {
      rawText,
      source: "text",
      type,
      whatsappMessageId: randomUUID(),
      ...(createdAt ? { createdAt } : {}),
    },
  });
}

async function seedExpenseNote({
  amountCents,
  occurredAt,
  currency,
  category,
  rawText = "gasto de prueba",
}: {
  amountCents: number;
  occurredAt: string;
  currency?: string;
  category?: string | null;
  rawText?: string;
}) {
  const note = await seedNote({ type: "gasto", rawText });
  await db.expense.create({
    data: {
      noteId: note.id,
      amountCents,
      occurredAt: new Date(occurredAt),
      ...(currency ? { currency } : {}),
      ...(category !== undefined ? { category } : {}),
    },
  });
  return note;
}

async function seedReminderNote({
  status,
  parsedDatetime = null,
  rawText = "recordatorio de prueba",
}: {
  status: string;
  parsedDatetime?: Date | null;
  rawText?: string;
}) {
  const note = await seedNote({ type: "recordatorio", rawText });
  const reminder = await db.reminder.create({
    data: { noteId: note.id, status, parsedDatetime },
  });
  return { note, reminder };
}

async function seedIncomeNote({
  amountCents,
  occurredAt,
  isSalary,
  currency,
  rawText = "ingreso de prueba",
}: {
  amountCents: number;
  occurredAt: string;
  isSalary: boolean;
  currency?: string;
  rawText?: string;
}) {
  const note = await seedNote({ type: "ingreso", rawText });
  const income = await db.income.create({
    data: {
      noteId: note.id,
      amountCents,
      isSalary,
      occurredAt: new Date(occurredAt),
      ...(currency ? { currency } : {}),
    },
  });
  return { note, income };
}

async function seedSavingNote({
  amountCents,
  occurredAt,
  currency,
  rawText = "ahorro de prueba",
}: {
  amountCents: number;
  occurredAt: string;
  currency?: string;
  rawText?: string;
}) {
  const note = await seedNote({ type: "ahorro", rawText });
  const saving = await db.saving.create({
    data: {
      noteId: note.id,
      amountCents,
      occurredAt: new Date(occurredAt),
      ...(currency ? { currency } : {}),
    },
  });
  return { note, saving };
}

async function seedCuotaItem({
  name = "cuota de prueba",
  amountCents = 10000,
  totalInstallments = null as number | null,
  startInstallment = 1,
  startYearMonth = "2026-01",
  groupId = null as string | null,
}) {
  return db.recurringItem.create({
    data: { name, amountCents, totalInstallments, startInstallment, startYearMonth, groupId },
  });
}

async function seedCuotaPayment(itemId: string, yearMonth: string, amountCents = 10000) {
  const note = await db.note.create({
    data: { rawText: "pago de prueba", source: "text", type: "gasto", whatsappMessageId: randomUUID() },
  });
  await db.expense.create({ data: { noteId: note.id, amountCents, occurredAt: new Date() } });
  await db.recurringPayment.create({ data: { itemId, yearMonth, noteId: note.id } });
}

test("monthExpenseCents sums only ARS expenses within the current Argentina month", async () => {
  await seedExpenseNote({ amountCents: 100000, occurredAt: "2026-10-05T12:00:00-03:00" }); // ARS, this month
  await seedExpenseNote({ amountCents: 500000, occurredAt: "2026-10-06T12:00:00-03:00", currency: "USD" }); // USD, excluded
  await seedExpenseNote({ amountCents: 900000, occurredAt: "2026-09-20T12:00:00-03:00" }); // ARS, last month

  const body = (await (await GET(buildRequest())).json()) as { monthExpenseCents: number };

  expect(body.monthExpenseCents).toBe(100000);
});

test("ideaCount / unclassifiedCount count notes by type", async () => {
  await seedNote({ type: "idea", rawText: "idea 1" });
  await seedNote({ type: "idea", rawText: "idea 2" });
  await seedNote({ type: "no_identificado", rawText: "sin clasificar" });
  await seedExpenseNote({ amountCents: 1000, occurredAt: "2026-10-05T12:00:00-03:00" });

  const body = (await (await GET(buildRequest())).json()) as { ideaCount: number; unclassifiedCount: number };

  expect(body.ideaCount).toBe(2);
  expect(body.unclassifiedCount).toBe(1);
});

test("activeReminderCount counts queued/awaiting_confirmation/confirming, and confirmed reminders whose parsedDatetime is still in the future; excludes rejected, ambiguous_no_date, and past confirmed", async () => {
  await seedReminderNote({ status: "queued" });
  await seedReminderNote({ status: "awaiting_confirmation" });
  await seedReminderNote({ status: "confirming" });
  await seedReminderNote({ status: "confirmed", parsedDatetime: new Date("2026-11-01T12:00:00Z") }); // future
  await seedReminderNote({ status: "confirmed", parsedDatetime: new Date("2026-10-01T12:00:00Z") }); // past, excluded
  await seedReminderNote({ status: "rejected" });
  await seedReminderNote({ status: "ambiguous_no_date" });

  const body = (await (await GET(buildRequest())).json()) as { activeReminderCount: number };

  expect(body.activeReminderCount).toBe(4);
});

test("last7DaysExpenses has 7 entries, oldest first, correctly bucketed by Argentina calendar day", async () => {
  await seedExpenseNote({ amountCents: 1000, occurredAt: "2026-10-08T12:00:00-03:00" }); // outside window
  await seedExpenseNote({ amountCents: 2000, occurredAt: "2026-10-10T12:00:00-03:00" });
  await seedExpenseNote({ amountCents: 3000, occurredAt: "2026-10-15T08:00:00-03:00" }); // today
  await seedExpenseNote({ amountCents: 9999, occurredAt: "2026-10-10T12:00:00-03:00", currency: "USD" }); // excluded currency

  const body = (await (await GET(buildRequest())).json()) as { last7DaysExpenses: { date: string; totalCents: number }[] };

  expect(body.last7DaysExpenses).toHaveLength(7);
  expect(body.last7DaysExpenses.map((d) => d.date)).toEqual([
    "2026-10-09",
    "2026-10-10",
    "2026-10-11",
    "2026-10-12",
    "2026-10-13",
    "2026-10-14",
    "2026-10-15",
  ]);
  expect(body.last7DaysExpenses.find((d) => d.date === "2026-10-10")?.totalCents).toBe(2000);
  expect(body.last7DaysExpenses.find((d) => d.date === "2026-10-15")?.totalCents).toBe(3000);
  expect(body.last7DaysExpenses.find((d) => d.date === "2026-10-09")?.totalCents).toBe(0);
});

test("recentNotes returns the 8 most recent notes of any type, newest first", async () => {
  const base = new Date("2026-10-01T12:00:00Z").getTime();
  for (let i = 0; i < 10; i++) {
    await seedNote({ type: "idea", rawText: `nota ${i}`, createdAt: new Date(base + i * 60_000) });
  }

  const body = (await (await GET(buildRequest())).json()) as { recentNotes: { rawText: string }[] };

  expect(body.recentNotes).toHaveLength(8);
  expect(body.recentNotes.map((n) => n.rawText)).toEqual([
    "nota 9",
    "nota 8",
    "nota 7",
    "nota 6",
    "nota 5",
    "nota 4",
    "nota 3",
    "nota 2",
  ]);
});

test("recentNotes marks an idea as deletable with deleteTargetId = note.id", async () => {
  const note = await seedNote({ type: "idea", rawText: "una idea" });

  const body = (await (await GET(buildRequest())).json()) as {
    recentNotes: { rawText: string; deletable: boolean; deleteTargetId: string }[];
  };

  const item = body.recentNotes.find((n) => n.rawText === "una idea");
  expect(item).toMatchObject({ deletable: true, deleteTargetId: note.id });
});

test("recentNotes marks a confirmed recordatorio as deletable with deleteTargetId = reminder.id", async () => {
  const { reminder } = await seedReminderNote({
    status: "confirmed",
    parsedDatetime: new Date("2026-11-01T12:00:00Z"),
    rawText: "turno confirmado",
  });

  const body = (await (await GET(buildRequest())).json()) as {
    recentNotes: { rawText: string; deletable: boolean; deleteTargetId: string }[];
  };

  const item = body.recentNotes.find((n) => n.rawText === "turno confirmado");
  expect(item).toMatchObject({ deletable: true, deleteTargetId: reminder.id });
});

test("recentNotes marks an awaiting_confirmation recordatorio as NOT deletable", async () => {
  await seedReminderNote({ status: "awaiting_confirmation", rawText: "turno pendiente" });

  const body = (await (await GET(buildRequest())).json()) as {
    recentNotes: { rawText: string; deletable: boolean; deleteTargetId: string }[];
  };

  const item = body.recentNotes.find((n) => n.rawText === "turno pendiente");
  expect(item).toMatchObject({ deletable: false, deleteTargetId: "" });
});

test("recentNotes marks no_identificado notes as NOT deletable (gasto is covered by its own deletable test below)", async () => {
  await seedNote({ type: "no_identificado", rawText: "sin clasificar" });

  const body = (await (await GET(buildRequest())).json()) as {
    recentNotes: { rawText: string; deletable: boolean; deleteTargetId: string }[];
  };

  const sinClasificar = body.recentNotes.find((n) => n.rawText === "sin clasificar");
  expect(sinClasificar).toMatchObject({ deletable: false, deleteTargetId: "" });
});

test("sueldoCents sums only income with isSalary=true within the current Argentina month", async () => {
  await seedIncomeNote({ amountCents: 1000000, occurredAt: "2026-10-05T12:00:00-03:00", isSalary: true }); // this month, sueldo
  await seedIncomeNote({ amountCents: 50000, occurredAt: "2026-10-06T12:00:00-03:00", isSalary: false }); // this month, otro ingreso — excluded
  await seedIncomeNote({ amountCents: 900000, occurredAt: "2026-09-20T12:00:00-03:00", isSalary: true }); // last month — excluded

  const body = (await (await GET(buildRequest())).json()) as { sueldoCents: number };

  expect(body.sueldoCents).toBe(1000000);
});

test("otrosIngresosCents sums only income with isSalary=false within the current Argentina month", async () => {
  await seedIncomeNote({ amountCents: 50000, occurredAt: "2026-10-06T12:00:00-03:00", isSalary: false }); // this month, otro ingreso
  await seedIncomeNote({ amountCents: 1000000, occurredAt: "2026-10-05T12:00:00-03:00", isSalary: true }); // this month, sueldo — excluded
  await seedIncomeNote({ amountCents: 30000, occurredAt: "2026-09-20T12:00:00-03:00", isSalary: false }); // last month — excluded

  const body = (await (await GET(buildRequest())).json()) as { otrosIngresosCents: number };

  expect(body.otrosIngresosCents).toBe(50000);
});

test("saldoCents is sueldoCents + otrosIngresosCents - monthExpenseCents", async () => {
  await seedIncomeNote({ amountCents: 1000000, occurredAt: "2026-10-05T12:00:00-03:00", isSalary: true });
  await seedIncomeNote({ amountCents: 50000, occurredAt: "2026-10-06T12:00:00-03:00", isSalary: false });
  await seedExpenseNote({ amountCents: 300000, occurredAt: "2026-10-10T12:00:00-03:00" });

  const body = (await (await GET(buildRequest())).json()) as {
    sueldoCents: number;
    otrosIngresosCents: number;
    monthExpenseCents: number;
    saldoCents: number;
  };

  expect(body.sueldoCents).toBe(1000000);
  expect(body.otrosIngresosCents).toBe(50000);
  expect(body.monthExpenseCents).toBe(300000);
  expect(body.saldoCents).toBe(1000000 + 50000 - 300000);
});

test("an expense from a previous month never affects the current month's saldoCents, even when that previous month has no income registered", async () => {
  // Previous month (September): only a gasto, no Income rows at all for
  // that month — this is exactly the leakage scenario
  // Focus calls out ("un gasto de octubre nunca debe restar del sueldo
  // de noviembre, aunque octubre no tenga sueldo registrado").
  await seedExpenseNote({ amountCents: 900000, occurredAt: "2026-09-20T12:00:00-03:00" });

  // Current month (October): sueldo only, no otros ingresos, no gastos.
  await seedIncomeNote({ amountCents: 1000000, occurredAt: "2026-10-05T12:00:00-03:00", isSalary: true });

  const body = (await (await GET(buildRequest())).json()) as {
    sueldoCents: number;
    otrosIngresosCents: number;
    monthExpenseCents: number;
    saldoCents: number;
  };

  expect(body.sueldoCents).toBe(1000000);
  expect(body.otrosIngresosCents).toBe(0);
  expect(body.monthExpenseCents).toBe(0);
  expect(body.saldoCents).toBe(body.sueldoCents);
});

test("ahorroTotalCents never resets by month, ahorroMesCents is the net of only this month's Saving rows, and saldoCents subtracts ahorroMesCents", async () => {
  // Last month: a deposit that must count toward ahorroTotalCents but NOT
  // toward ahorroMesCents or saldoCents (ahorroTotalCents never
  // resets between months).
  await seedSavingNote({ amountCents: 200000, occurredAt: "2026-09-10T12:00:00-03:00" });
  // This month: a deposit and a withdrawal (negative amountCents) — net is
  // what saldoCents subtracts, not just the positive deposit.
  await seedSavingNote({ amountCents: 50000, occurredAt: "2026-10-05T12:00:00-03:00", rawText: "aparté 500" });
  await seedSavingNote({ amountCents: -20000, occurredAt: "2026-10-08T12:00:00-03:00", rawText: "retiré 200 del ahorro" });

  await seedIncomeNote({ amountCents: 1000000, occurredAt: "2026-10-05T12:00:00-03:00", isSalary: true });
  await seedIncomeNote({ amountCents: 50000, occurredAt: "2026-10-06T12:00:00-03:00", isSalary: false });
  await seedExpenseNote({ amountCents: 300000, occurredAt: "2026-10-10T12:00:00-03:00" });

  const body = (await (await GET(buildRequest())).json()) as {
    sueldoCents: number;
    otrosIngresosCents: number;
    monthExpenseCents: number;
    ahorroTotalCents: number;
    ahorroMesCents: number;
    saldoCents: number;
  };

  expect(body.ahorroTotalCents).toBe(200000 + 50000 - 20000);
  expect(body.ahorroMesCents).toBe(50000 - 20000);
  expect(body.saldoCents).toBe(
    body.sueldoCents + body.otrosIngresosCents - body.monthExpenseCents - body.ahorroMesCents
  );
  expect(body.saldoCents).toBe(1000000 + 50000 - 300000 - 30000);
});

test("ahorroTotalCents only sums default-currency Saving rows, across all months", async () => {
  await seedSavingNote({ amountCents: 200000, occurredAt: "2026-09-10T12:00:00-03:00" });
  await seedSavingNote({ amountCents: 50000, occurredAt: "2026-10-05T12:00:00-03:00" });
  await seedSavingNote({ amountCents: 10000, occurredAt: "2026-09-11T12:00:00-03:00", currency: "USD" });
  await seedSavingNote({ amountCents: 20000, occurredAt: "2026-10-06T12:00:00-03:00", currency: "USD" });

  const body = (await (await GET(buildRequest())).json()) as { ahorroTotalCents: number; ahorroMesCents: number };

  expect(body.ahorroTotalCents).toBe(200000 + 50000);
  expect(body.ahorroMesCents).toBe(50000);
});

test("recentNotes marks a gasto as deletable with deleteTargetId = expense.id", async () => {
  const note = await seedExpenseNote({ amountCents: 1000, occurredAt: "2026-10-05T12:00:00-03:00", rawText: "un gasto borrable" });
  const expense = await db.expense.findUniqueOrThrow({ where: { noteId: note.id } });

  const body = (await (await GET(buildRequest())).json()) as {
    recentNotes: { rawText: string; deletable: boolean; deleteTargetId: string }[];
  };

  const item = body.recentNotes.find((n) => n.rawText === "un gasto borrable");
  expect(item).toMatchObject({ deletable: true, deleteTargetId: expense.id });
});

test("recentNotes marks an ingreso as deletable with deleteTargetId = income.id", async () => {
  const { income } = await seedIncomeNote({
    amountCents: 50000,
    occurredAt: "2026-10-06T12:00:00-03:00",
    isSalary: false,
    rawText: "un ingreso borrable",
  });

  const body = (await (await GET(buildRequest())).json()) as {
    recentNotes: { rawText: string; deletable: boolean; deleteTargetId: string }[];
  };

  const item = body.recentNotes.find((n) => n.rawText === "un ingreso borrable");
  expect(item).toMatchObject({ deletable: true, deleteTargetId: income.id });
});

test("recentNotes marks an ahorro as deletable with deleteTargetId = saving.id", async () => {
  const { saving } = await seedSavingNote({
    amountCents: 50000,
    occurredAt: "2026-10-06T12:00:00-03:00",
    rawText: "un ahorro borrable",
  });

  const body = (await (await GET(buildRequest())).json()) as {
    recentNotes: { rawText: string; deletable: boolean; deleteTargetId: string }[];
  };

  const item = body.recentNotes.find((n) => n.rawText === "un ahorro borrable");
  expect(item).toMatchObject({ deletable: true, deleteTargetId: saving.id });
});

test("cuotasPendientesCents sums the amountCents of active cuotas not yet paid this month", async () => {
  await seedCuotaItem({ name: "gimnasio", amountCents: 8000, totalInstallments: null, startYearMonth: "2026-01" });
  const netflix = await seedCuotaItem({ name: "netflix", amountCents: 5000, totalInstallments: null, startYearMonth: "2026-01" });
  await seedCuotaPayment(netflix.id, "2026-10", 5000); // paid this month — excluded from pendientes

  const body = (await (await GET(buildRequest())).json()) as { cuotasPendientesCents: number };

  expect(body.cuotasPendientesCents).toBe(8000);
});

test("cuotasPagadasCents sums the amountCents of active cuotas already paid this month", async () => {
  const gym = await seedCuotaItem({ name: "gimnasio", amountCents: 8000, totalInstallments: null, startYearMonth: "2026-01" });
  await seedCuotaItem({ name: "netflix", amountCents: 5000, totalInstallments: null, startYearMonth: "2026-01" });
  await seedCuotaPayment(gym.id, "2026-10", 8000);

  const body = (await (await GET(buildRequest())).json()) as { cuotasPagadasCents: number };

  expect(body.cuotasPagadasCents).toBe(8000);
});

test("a cuota that has already ended (installments exhausted) is excluded from both cuotasPendientesCents and cuotasPagadasCents", async () => {
  // 3 cuotas de $1000 arrancando en 2026-01: para el mes actual (2026-10),
  // la cuota calculada es 10, muy por encima de 3 — ya terminó.
  await seedCuotaItem({ name: "compra vieja", amountCents: 1000, totalInstallments: 3, startInstallment: 1, startYearMonth: "2026-01" });

  const body = (await (await GET(buildRequest())).json()) as {
    cuotasPendientesCents: number;
    cuotasPagadasCents: number;
  };

  expect(body.cuotasPendientesCents).toBe(0);
  expect(body.cuotasPagadasCents).toBe(0);
});

test("a grouped payment's shared Expense is counted once in cuotasPagadasCents, not once per item sharing it", async () => {
  const group = await db.recurringGroup.create({ data: { name: "Tarjeta" } });
  const itemA = await seedCuotaItem({ name: "cuota A", amountCents: 3000, startYearMonth: "2026-01", groupId: group.id });
  const itemB = await seedCuotaItem({ name: "cuota B", amountCents: 7000, startYearMonth: "2026-01", groupId: group.id });

  // Pago combinado: una sola Note/Expense, dos filas RecurringPayment —
  // mismo patrón que payGroup (src/lib/cuotas.ts). El monto pagado (9000)
  // es distinto a la suma nominal de los items (3000+7000=10000) a
  // propósito, para distinguir "sumar el gasto real una sola vez" de
  // "sumar el monto nominal de cada item" (lo segundo sería doble conteo
  // Y el monto equivocado si hubo un override).
  const note = await db.note.create({
    data: { rawText: "pago de tarjeta", source: "text", type: "gasto", whatsappMessageId: randomUUID() },
  });
  await db.expense.create({ data: { noteId: note.id, amountCents: 9000, occurredAt: new Date() } });
  await db.recurringPayment.create({ data: { itemId: itemA.id, yearMonth: "2026-10", noteId: note.id } });
  await db.recurringPayment.create({ data: { itemId: itemB.id, yearMonth: "2026-10", noteId: note.id } });

  const body = (await (await GET(buildRequest())).json()) as {
    cuotasPendientesCents: number;
    cuotasPagadasCents: number;
  };

  expect(body.cuotasPagadasCents).toBe(9000);
  expect(body.cuotasPendientesCents).toBe(0);
});

test("cuotasPagadasCents reflects the actually-paid Expense amount, not the item's nominal amountCents, when a payment used an override amount", async () => {
  const item = await seedCuotaItem({ name: "gimnasio", amountCents: 8000, startYearMonth: "2026-01" });
  await seedCuotaPayment(item.id, "2026-10", 5000); // pagado con un monto distinto al nominal

  const body = (await (await GET(buildRequest())).json()) as { cuotasPagadasCents: number };

  expect(body.cuotasPagadasCents).toBe(5000);
});

test("expensesByCategory groups this month's ARS expenses by category, sorted descending, excluding past months, with null bucketed as 'Sin categoría'", async () => {
  await seedExpenseNote({ amountCents: 50000, occurredAt: "2026-10-05T12:00:00-03:00", category: "Comida" });
  await seedExpenseNote({ amountCents: 30000, occurredAt: "2026-10-06T12:00:00-03:00", category: "Comida" });
  await seedExpenseNote({ amountCents: 20000, occurredAt: "2026-10-07T12:00:00-03:00", category: "Transporte" });
  await seedExpenseNote({ amountCents: 90000, occurredAt: "2026-10-08T12:00:00-03:00", category: "cuotas" });
  await seedExpenseNote({ amountCents: 10000, occurredAt: "2026-10-09T12:00:00-03:00", category: null });
  // Past month — must be excluded even though it has its own category.
  await seedExpenseNote({ amountCents: 900000, occurredAt: "2026-09-20T12:00:00-03:00", category: "Comida" });

  const body = (await (await GET(buildRequest())).json()) as {
    expensesByCategory: { category: string; amountCents: number }[];
  };

  expect(body.expensesByCategory).toEqual([
    { category: "cuotas", amountCents: 90000 },
    { category: "Comida", amountCents: 80000 },
    { category: "Transporte", amountCents: 20000 },
    { category: "Sin categoría", amountCents: 10000 },
  ]);
});
