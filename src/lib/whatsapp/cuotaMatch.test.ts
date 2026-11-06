import { beforeEach, describe, expect, test } from "vitest";
import db from "../db";
import { findCuotaCandidates } from "./cuotaMatch";

const YEAR_MONTH = "2026-03";

beforeEach(async () => {
  await db.recurringPayment.deleteMany();
  await db.expense.deleteMany();
  await db.note.deleteMany();
  await db.recurringItem.deleteMany();
  await db.recurringGroup.deleteMany();
});

async function seedGroup(name: string) {
  return db.recurringGroup.create({ data: { name } });
}

async function seedItem({
  groupId = null,
  name,
  amountCents = 10000,
  totalInstallments = null as number | null,
  startInstallment = 1,
  startYearMonth = YEAR_MONTH,
}: {
  groupId?: string | null;
  name: string;
  amountCents?: number;
  totalInstallments?: number | null;
  startInstallment?: number;
  startYearMonth?: string;
}) {
  return db.recurringItem.create({
    data: { name, amountCents, totalInstallments, startInstallment, startYearMonth, groupId },
  });
}

async function seedPaymentFor(itemId: string, yearMonth: string, amountCents = 10000) {
  const note = await db.note.create({
    data: {
      rawText: "pago de prueba",
      source: "text",
      type: "gasto",
      whatsappMessageId: `web:${itemId}-${yearMonth}`,
    },
  });
  const expense = await db.expense.create({
    data: { noteId: note.id, amountCents, occurredAt: new Date() },
  });
  await db.recurringPayment.create({ data: { itemId, yearMonth, noteId: note.id } });
  return expense;
}

describe("findCuotaCandidates", () => {
  test("matches a single ungrouped item by name", async () => {
    const gimnasio = await seedItem({ name: "Gimnasio" });

    const result = await findCuotaCandidates("pagué el gimnasio", YEAR_MONTH);

    expect(result.kind).toBe("single");
    if (result.kind === "single") {
      expect(result.candidate).toEqual({ kind: "item", item: expect.objectContaining({ id: gimnasio.id }) });
    }
  });

  test("matches a single group by name", async () => {
    const group = await seedGroup("Tarjeta Mastercard");
    const item1 = await seedItem({ groupId: group.id, name: "cuota 1" });
    const item2 = await seedItem({ groupId: group.id, name: "cuota 2" });

    const result = await findCuotaCandidates("pagué la tarjeta mastercard", YEAR_MONTH);

    expect(result.kind).toBe("single");
    if (result.kind === "single") {
      expect(result.candidate.kind).toBe("group");
      if (result.candidate.kind === "group") {
        expect(result.candidate.group.id).toBe(group.id);
        expect(new Set(result.candidate.items.map((i) => i.id))).toEqual(new Set([item1.id, item2.id]));
      }
    }
  });

  test("a grouped item is still matchable on its own by name, even when its group also exists", async () => {
    const group = await seedGroup("Tarjeta Mastercard");
    const netflix = await seedItem({ groupId: group.id, name: "Netflix" });
    await seedItem({ groupId: group.id, name: "Spotify" });

    const result = await findCuotaCandidates("pagué netflix", YEAR_MONTH);

    expect(result).toEqual({
      kind: "single",
      candidate: { kind: "item", item: expect.objectContaining({ id: netflix.id }) },
    });
  });

  test("excludes an item that already has a RecurringPayment for this month", async () => {
    const gimnasio = await seedItem({ name: "Gimnasio" });
    await seedPaymentFor(gimnasio.id, YEAR_MONTH);

    const result = await findCuotaCandidates("pagué el gimnasio", YEAR_MONTH);

    expect(result).toEqual({ kind: "none" });
  });

  test("excludes an item that is not active this month (totalInstallments already exceeded)", async () => {
    await seedItem({
      name: "Gimnasio",
      startYearMonth: "2000-01",
      totalInstallments: 1,
      startInstallment: 1,
    });

    const result = await findCuotaCandidates("pagué el gimnasio", YEAR_MONTH);

    expect(result).toEqual({ kind: "none" });
  });

  test("excludes a group with no active, unpaid items this month, even if its name matches", async () => {
    const group = await seedGroup("Tarjeta Mastercard");
    const item = await seedItem({ groupId: group.id, name: "cuota 1" });
    await seedPaymentFor(item.id, YEAR_MONTH);

    const result = await findCuotaCandidates("pagué la tarjeta mastercard", YEAR_MONTH);

    expect(result).toEqual({ kind: "none" });
  });

  test("returns 'none' when nothing matches", async () => {
    await seedItem({ name: "Gimnasio" });

    const result = await findCuotaCandidates("pagué la reunión de mañana", YEAR_MONTH);

    expect(result).toEqual({ kind: "none" });
  });

  test("returns 'ambiguous' when two groups both match the request text, newest-created first", async () => {
    const older = await seedGroup("Tarjeta Visa");
    await seedItem({ groupId: older.id, name: "cuota vieja" });

    const newer = await seedGroup("Tarjeta Mastercard");
    await seedItem({ groupId: newer.id, name: "cuota nueva" });

    const result = await findCuotaCandidates("pagué la tarjeta", YEAR_MONTH);

    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      const groupIds = result.candidates.map((c) => (c.kind === "group" ? c.group.id : null));
      expect(groupIds).toEqual([newer.id, older.id]);
    }
  });
  // Final-review finding: extractKeywords drops short words and digits, so
  // "pagué eso" / "pagué la tv" / "pagué 500" all have zero keywords. With
  // 2+ candidates that must list and ask (ambiguous), never silently pick
  // the newest — a "single" here pays immediately with no confirmation.
  test.each(["pagué eso", "pagué la tv", "pagué 500"])(
    "a zero-keyword request (%s) with 2+ candidates returns 'ambiguous', never a silent pick",
    async (requestText) => {
      await seedItem({ name: "Gimnasio" });
      await seedItem({ name: "Netflix" });

      const result = await findCuotaCandidates(requestText, YEAR_MONTH);

      expect(result.kind).toBe("ambiguous");
      if (result.kind === "ambiguous") {
        expect(result.candidates).toHaveLength(2);
      }
    }
  );

  test("a zero-keyword request with more candidates than MAX_AMBIGUOUS caps the list at 5", async () => {
    for (let i = 0; i < 7; i++) await seedItem({ name: `Item ${String.fromCharCode(97 + i)}x` });

    const result = await findCuotaCandidates("pagué eso", YEAR_MONTH);

    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") expect(result.candidates).toHaveLength(5);
  });

  test("a zero-keyword request with exactly one candidate still resolves to 'single'", async () => {
    const only = await seedItem({ name: "Gimnasio" });

    const result = await findCuotaCandidates("pagué eso", YEAR_MONTH);

    expect(result).toEqual({ kind: "single", candidate: { kind: "item", item: expect.objectContaining({ id: only.id }) } });
  });

  test("a zero-keyword request with no candidates returns 'none'", async () => {
    expect(await findCuotaCandidates("pagué eso", YEAR_MONTH)).toEqual({ kind: "none" });
  });
});
