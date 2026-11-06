import { randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "vitest";
import db from "../src/lib/db";
import { CUOTA_EXPENSE_CATEGORY } from "../src/lib/expenseCategories";
import { migrateExpenseCategories } from "./migrate-expense-categories";

// Same disposable-SQLite-test-DB pattern as src/app/api/gastos/[id]/route.test.ts.
beforeEach(async () => {
  await db.expense.deleteMany();
  await db.note.deleteMany();
});

async function seedExpense(category: string | null) {
  const note = await db.note.create({
    data: {
      rawText: "gasto de prueba",
      source: "text",
      type: "gasto",
      whatsappMessageId: randomUUID(),
    },
  });
  return db.expense.create({
    data: {
      noteId: note.id,
      amountCents: 100000,
      category,
      occurredAt: new Date("2026-10-05"),
    },
  });
}

test("migrateExpenseCategories leaves 'cuotas' rows untouched and counts them as skipped", async () => {
  const cuota = await seedExpense(CUOTA_EXPENSE_CATEGORY);

  const result = await migrateExpenseCategories(db);

  const unchanged = await db.expense.findUnique({ where: { id: cuota.id } });
  expect(unchanged?.category).toBe(CUOTA_EXPENSE_CATEGORY);
  expect(result.skipped).toBe(1);
});

test("migrateExpenseCategories leaves an already-fixed category unchanged and does not count it as updated", async () => {
  const expense = await seedExpense("Comida");

  const result = await migrateExpenseCategories(db);

  const unchanged = await db.expense.findUnique({ where: { id: expense.id } });
  expect(unchanged?.category).toBe("Comida");
  expect(result.updated).toBe(0);
});

test("migrateExpenseCategories maps a legacy category to its fixed equivalent and counts it as updated", async () => {
  const expense = await seedExpense("super");

  const result = await migrateExpenseCategories(db);

  const updated = await db.expense.findUnique({ where: { id: expense.id } });
  expect(updated?.category).toBe("Comida");
  expect(result.updated).toBe(1);
});

test("migrateExpenseCategories maps a null category to Otros", async () => {
  const expense = await seedExpense(null);

  const result = await migrateExpenseCategories(db);

  const updated = await db.expense.findUnique({ where: { id: expense.id } });
  expect(updated?.category).toBe("Otros");
  expect(result.updated).toBe(1);
});

test("migrateExpenseCategories maps an unrecognized category to Otros", async () => {
  const expense = await seedExpense("regalo");

  const result = await migrateExpenseCategories(db);

  const updated = await db.expense.findUnique({ where: { id: expense.id } });
  expect(updated?.category).toBe("Otros");
  expect(result.updated).toBe(1);
});

test("migrateExpenseCategories returns accurate counts across a mix of rows", async () => {
  await seedExpense(CUOTA_EXPENSE_CATEGORY);
  await seedExpense("Comida");
  await seedExpense("super");
  await seedExpense(null);
  await seedExpense("regalo");

  const result = await migrateExpenseCategories(db);

  expect(result).toEqual({ updated: 3, skipped: 1 });
});
