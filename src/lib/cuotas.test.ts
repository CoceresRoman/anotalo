import { randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "vitest";
import db from "./db";
import {
  CUOTA_EXPENSE_CATEGORY,
  addMonthsToYearMonth,
  getPendingCuotaNamesForMonth,
  installmentNumberFor,
  isActiveInMonth,
} from "./cuotas";

// Only getPendingCuotaNamesForMonth below touches the DB — same cleanup
// pattern as src/lib/whatsapp/cuotaPaymentFlow.test.ts. Harmless no-op for
// the pure-function tests above, which never create any rows.
beforeEach(async () => {
  await db.recurringPayment.deleteMany();
  await db.expense.deleteMany();
  await db.note.deleteMany();
  await db.recurringItem.deleteMany();
  await db.recurringGroup.deleteMany();
});

test("addMonthsToYearMonth: suma meses dentro del mismo año", () => {
  expect(addMonthsToYearMonth("2026-03", 2)).toBe("2026-05");
});

test("addMonthsToYearMonth: cruza el límite de año", () => {
  expect(addMonthsToYearMonth("2026-11", 3)).toBe("2027-02");
});

test("installmentNumberFor returns startInstallment in the starting month", () => {
  expect(
    installmentNumberFor({ startInstallment: 5, startYearMonth: "2026-10" }, "2026-10")
  ).toBe(5);
});

test("installmentNumberFor advances by one per elapsed calendar month", () => {
  expect(
    installmentNumberFor({ startInstallment: 5, startYearMonth: "2026-10" }, "2026-12")
  ).toBe(7);
});

test("installmentNumberFor handles a year boundary", () => {
  expect(
    installmentNumberFor({ startInstallment: 1, startYearMonth: "2026-11" }, "2027-01")
  ).toBe(3);
});

test("isActiveInMonth is true while the computed installment is within totalInstallments", () => {
  // startInstallment 1 en 2026-01, total 12: en 2026-12 la cuota calculada es 12.
  expect(
    isActiveInMonth(
      { startInstallment: 1, startYearMonth: "2026-01", totalInstallments: 12 },
      "2026-12"
    )
  ).toBe(true);
});

test("isActiveInMonth is false once the computed installment exceeds totalInstallments", () => {
  // En 2027-01 la cuota calculada es 13, con total 12.
  expect(
    isActiveInMonth(
      { startInstallment: 1, startYearMonth: "2026-01", totalInstallments: 12 },
      "2027-01"
    )
  ).toBe(false);
});

test("isActiveInMonth is always true when totalInstallments is null, for any month at or after startYearMonth", () => {
  const item = { startInstallment: 1, startYearMonth: "2026-11", totalInstallments: null };
  expect(isActiveInMonth(item, "2026-11")).toBe(true);
  expect(isActiveInMonth(item, "2027-01")).toBe(true);
  expect(isActiveInMonth(item, "2035-06")).toBe(true);
});

test("isActiveInMonth is false for a month before startYearMonth, regardless of totalInstallments", () => {
  expect(
    isActiveInMonth(
      { startInstallment: 1, startYearMonth: "2026-11", totalInstallments: 12 },
      "2026-10"
    )
  ).toBe(false);
  expect(
    isActiveInMonth(
      { startInstallment: 1, startYearMonth: "2026-11", totalInstallments: null },
      "2026-10"
    )
  ).toBe(false);
});

test("getPendingCuotaNamesForMonth returns active unpaid standalone items by name, excludes paid and inactive items, and dedupes a grouped pair to the group's name", async () => {
  const yearMonth = "2026-11";

  // Standalone, active, unpaid this month -> included by its own name.
  await db.recurringItem.create({
    data: {
      name: "Netflix",
      amountCents: 500000,
      startInstallment: 1,
      startYearMonth: "2026-01",
      totalInstallments: null,
    },
  });

  // Standalone, active, but already paid this month -> excluded.
  const paidItem = await db.recurringItem.create({
    data: {
      name: "Spotify",
      amountCents: 100000,
      startInstallment: 1,
      startYearMonth: "2026-01",
      totalInstallments: null,
    },
  });
  const note = await db.note.create({
    data: {
      rawText: "Spotify",
      source: "text",
      type: "gasto",
      whatsappMessageId: `test:${randomUUID()}`,
    },
  });
  await db.expense.create({
    data: {
      noteId: note.id,
      amountCents: 100000,
      category: CUOTA_EXPENSE_CATEGORY,
      occurredAt: new Date(),
    },
  });
  await db.recurringPayment.create({
    data: { itemId: paidItem.id, yearMonth, noteId: note.id },
  });

  // Inactive: installments exhausted (startInstallment 1 + 22 elapsed
  // months from 2025-01 to 2026-11 = cuota 23, past totalInstallments 6).
  await db.recurringItem.create({
    data: {
      name: "PS5",
      amountCents: 2000000,
      startInstallment: 1,
      startYearMonth: "2025-01",
      totalInstallments: 6,
    },
  });

  // Grouped pair, both active and unpaid this month -> appears once, by
  // the group's name, not once per member.
  const group = await db.recurringGroup.create({ data: { name: "Tarjeta Visa" } });
  await db.recurringItem.create({
    data: {
      name: "Compra A",
      amountCents: 300000,
      startInstallment: 1,
      startYearMonth: "2026-01",
      totalInstallments: null,
      groupId: group.id,
    },
  });
  await db.recurringItem.create({
    data: {
      name: "Compra B",
      amountCents: 400000,
      startInstallment: 1,
      startYearMonth: "2026-01",
      totalInstallments: null,
      groupId: group.id,
    },
  });

  const names = await getPendingCuotaNamesForMonth(yearMonth);

  expect(names.slice().sort()).toEqual(["Netflix", "Tarjeta Visa"]);
});
