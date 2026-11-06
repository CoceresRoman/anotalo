// One-off operational script: backfills every existing Expense row's
// freeform category (whatever the WhatsApp classifier produced before Task 1
// fixed the list) into one of the 6 EXPENSE_CATEGORIES values, using the
// same keyword table the classifier no longer needs (mapLegacyCategoryToFixed
// in src/lib/expenseCategories.ts). Not part of the app's request path — no
// route, no UI — run once by hand with:
//
//   npx tsx scripts/migrate-expense-categories.ts
//
// Same plain-script convention as scripts/setup-google-auth.ts.
import type { PrismaClient } from "@prisma/client";
import db from "../src/lib/db";
import { CUOTA_EXPENSE_CATEGORY, mapLegacyCategoryToFixed } from "../src/lib/expenseCategories";

// Reads every Expense row and, for each whose category is not
// CUOTA_EXPENSE_CATEGORY ("cuotas" — written only by cuotas.ts's
// payItem/payGroup, never by the classifier, so it's always already a valid
// fixed-list value and must never be touched here — Review Focus #1),
// computes mapLegacyCategoryToFixed(category) and updates the row only if
// that differs from its current value. Returns the counts so main() (and
// tests) can report what happened without re-querying.
export async function migrateExpenseCategories(
  prisma: PrismaClient
): Promise<{ updated: number; skipped: number }> {
  const expenses = await prisma.expense.findMany();

  let updated = 0;
  let skipped = 0;

  for (const expense of expenses) {
    if (expense.category === CUOTA_EXPENSE_CATEGORY) {
      skipped += 1;
      continue;
    }

    const fixed = mapLegacyCategoryToFixed(expense.category);
    if (fixed !== expense.category) {
      await prisma.expense.update({ where: { id: expense.id }, data: { category: fixed } });
      updated += 1;
    }
  }

  return { updated, skipped };
}

async function countByCategory(prisma: PrismaClient): Promise<Record<string, number>> {
  const groups = await prisma.expense.groupBy({ by: ["category"], _count: { category: true } });
  const counts: Record<string, number> = {};
  for (const group of groups) {
    counts[group.category ?? "(null)"] = group._count.category;
  }
  return counts;
}

async function main(): Promise<void> {
  console.log("Category counts before migration:", await countByCategory(db));

  const result = await migrateExpenseCategories(db);

  console.log("Category counts after migration:", await countByCategory(db));
  console.log(`Migration done: ${result.updated} row(s) updated, ${result.skipped} row(s) skipped (cuotas).`);
}

// Only runs when this file is executed directly (e.g. `npx tsx
// scripts/migrate-expense-categories.ts`), not when migrateExpenseCategories
// is imported for testing — same pattern as scripts/setup-google-auth.ts.
if (process.argv[1] && process.argv[1].endsWith("migrate-expense-categories.ts")) {
  main()
    .catch((err) => {
      console.error("migrate-expense-categories failed:", err);
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
