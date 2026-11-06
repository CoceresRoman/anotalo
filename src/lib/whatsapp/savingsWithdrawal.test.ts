import { randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "vitest";
import { config } from "../config";
import db from "../db";

import { withdrawSavings } from "./savingsWithdrawal";

// Mirrors the "ahorro" capture Note+Saving pair (persist.ts) but for
// a deposit — used here only to seed a cumulative total for withdrawSavings
// to read.
async function seedSaving(amountCents: number, currency?: string) {
  const note = await db.note.create({
    data: {
      rawText: "aparté plata",
      source: "text",
      type: "ahorro",
      whatsappMessageId: `test:${randomUUID()}`,
    },
  });
  return db.saving.create({
    data: { noteId: note.id, amountCents, occurredAt: new Date(), ...(currency ? { currency } : {}) },
  });
}

async function totalSavingsCents(): Promise<number> {
  const result = await db.saving.aggregate({ _sum: { amountCents: true } });
  return result._sum.amountCents ?? 0;
}

beforeEach(async () => {
  await db.saving.deleteMany();
  await db.note.deleteMany();
});

test("withdrawSavings: con monto, retira exactamente ese monto y queda registrado como Saving negativo", async () => {
  await seedSaving(500_000_00);

  const result = await withdrawSavings(400_000_00);

  expect(result.withdrawnCents).toBe(400_000_00);
  expect(await totalSavingsCents()).toBe(100_000_00);

  const newest = await db.saving.findFirst({
    orderBy: { occurredAt: "desc" },
    include: { note: true },
  });
  expect(newest?.amountCents).toBe(-400_000_00);
  expect(newest?.note.type).toBe("ahorro");
});

test("withdrawSavings: sin monto, retira todo el disponible", async () => {
  await seedSaving(500_000_00);

  const result = await withdrawSavings(null);

  expect(result.withdrawnCents).toBe(500_000_00);
  expect(await totalSavingsCents()).toBe(0);
});

test("withdrawSavings: un monto mayor al disponible se topa, nunca deja el total negativo", async () => {
  await seedSaving(100_000_00);

  const result = await withdrawSavings(500_000_00);

  expect(result.withdrawnCents).toBe(100_000_00);
  expect(await totalSavingsCents()).toBe(0);
});

test("withdrawSavings: el disponible solo cuenta la moneda default — un depósito en otra moneda nunca se retira como pesos", async () => {
  await seedSaving(100_000_00);
  await seedSaving(900_000_00, "USD");

  const result = await withdrawSavings(null);

  expect(result.withdrawnCents).toBe(100_000_00);
  const withdrawal = await db.saving.findFirst({ where: { amountCents: { lt: 0 } } });
  expect(withdrawal?.currency).toBe(config.defaultCurrency);
});
