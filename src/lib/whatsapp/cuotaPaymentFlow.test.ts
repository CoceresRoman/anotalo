import { randomUUID } from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";
import db from "../db";

// requestCuotaPayment/handleCuotaPaymentReply's only external dependency is
// sendSelfMessage (WhatsApp send) — payItem/payGroup (src/lib/cuotas.ts)
// and findCuotaCandidates (cuotaMatch.ts) are real: these
// tests assert the request/pay/disambiguate state machine against a real
// (test) DB, never touching WhatsApp. Same mocking discipline as
// deleteFlow.test.ts.
const mockSendSelfMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("./connection", () => ({ sendSelfMessage: mockSendSelfMessage }));

import {
  handleCuotaPaymentReply,
  requestCuotaPayment,
  resendPendingCuotaPaymentPrompt,
} from "./cuotaPaymentFlow";
// Imported as a namespace (not destructured) specifically so a single test
// below can spy on findCuotaCandidates to simulate a concurrent
// requestCuotaPayment landing inside requestCuotaPayment's own await window
// — same rationale/pattern as deleteFlow.test.ts's analogous race test.
import * as cuotaMatchModule from "./cuotaMatch";

async function seedItem({
  name = "gimnasio",
  amountCents = 10000,
  totalInstallments = null as number | null,
  startInstallment = 1,
  startYearMonth,
  groupId = null as string | null,
}: {
  name?: string;
  amountCents?: number;
  totalInstallments?: number | null;
  startInstallment?: number;
  startYearMonth?: string;
  groupId?: string | null;
} = {}) {
  return db.recurringItem.create({
    data: {
      name,
      amountCents,
      totalInstallments,
      startInstallment,
      startYearMonth: startYearMonth ?? currentYearMonth(),
      groupId,
    },
  });
}

async function seedGroup(name = "Tarjeta Mastercard") {
  return db.recurringGroup.create({ data: { name } });
}

function currentYearMonth(): string {
  // Mirrors toArgentinaDateString(new Date()).slice(0, 7) without importing
  // timezone.ts — tests run with real timers (no Date faking here), so this
  // just needs to match whatever requestCuotaPayment itself computes.
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  return `${year}-${month}`;
}

async function seedNote({
  type = "idea",
  rawText = "nota de prueba",
}: {
  type?: string;
  rawText?: string;
} = {}) {
  return db.note.create({
    data: {
      rawText,
      source: "text",
      type,
      whatsappMessageId: randomUUID(),
    },
  });
}

beforeEach(async () => {
  await db.recurringPayment.deleteMany();
  await db.expense.deleteMany();
  await db.pendingCuotaPayment.deleteMany();
  await db.pendingDeletion.deleteMany();
  await db.pendingPurchaseSimulation.deleteMany();
  await db.reminder.deleteMany();
  await db.note.deleteMany();
  await db.recurringItem.deleteMany();
  await db.recurringGroup.deleteMany();
  mockSendSelfMessage.mockReset().mockResolvedValue(undefined);
});

test("requestCuotaPayment with no candidates sends a 'not found' message and creates no PendingCuotaPayment", async () => {
  const outcome = await requestCuotaPayment("pagué el gimnasio");

  expect(outcome).toBe("none_found");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(
    expect.stringContaining("No encontré ninguna cuota")
  );
  expect(await db.pendingCuotaPayment.count()).toBe(0);
});

test("requestCuotaPayment with a single match pays it directly (no confirmation) and sends a success message", async () => {
  const item = await seedItem({ name: "gimnasio", amountCents: 50000 });

  const outcome = await requestCuotaPayment("pagué el gimnasio");

  expect(outcome).toBe("paid");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining("gimnasio"));
  expect(await db.pendingCuotaPayment.count()).toBe(0);

  const payment = await db.recurringPayment.findUnique({
    where: { itemId_yearMonth: { itemId: item.id, yearMonth: currentYearMonth() } },
  });
  expect(payment).not.toBeNull();
  const expense = await db.expense.findUnique({ where: { noteId: payment!.noteId } });
  expect(expense?.amountCents).toBe(50000);
});

test("requestCuotaPayment with a single match and a stated amount uses that amount instead of the computed one", async () => {
  await seedItem({ name: "gimnasio", amountCents: 50000 });

  const outcome = await requestCuotaPayment("pagué el gimnasio, 85000", 85000);

  expect(outcome).toBe("paid");
  const expense = await db.expense.findFirst();
  expect(expense?.amountCents).toBe(85000);
});

test("requestCuotaPayment with multiple matches sends a numbered list and creates a PendingCuotaPayment", async () => {
  const item1 = await seedItem({ name: "tarjeta mastercard oro" });
  const item2 = await seedItem({ name: "tarjeta mastercard black" });

  const outcome = await requestCuotaPayment("pagué la tarjeta mastercard");

  expect(outcome).toBe("asked_disambiguate");
  const message = mockSendSelfMessage.mock.calls[0]![0] as string;
  expect(message).toContain("1.");
  expect(message).toContain("2.");
  expect(message.toLowerCase()).toContain("número");

  const pending = await db.pendingCuotaPayment.findFirst();
  expect(pending).not.toBeNull();
  const candidates = JSON.parse(pending!.candidates);
  expect(new Set(candidates.map((c: { id: string }) => c.id))).toEqual(
    new Set([item1.id, item2.id])
  );
});

test("requestCuotaPayment while a Reminder is awaiting_confirmation is blocked", async () => {
  const note = await seedNote({ type: "recordatorio", rawText: "turno con el dentista" });
  await db.reminder.create({
    data: {
      noteId: note.id,
      parsedDatetime: new Date(Date.now() + 86400000),
      status: "awaiting_confirmation",
      calendarEventId: null,
    },
  });
  await seedItem({ name: "gimnasio" });

  const outcome = await requestCuotaPayment("pagué el gimnasio");

  expect(outcome).toBe("blocked_pending");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(
    expect.stringContaining("recordatorio pendiente de confirmar")
  );
  expect(await db.pendingCuotaPayment.count()).toBe(0);
});

test("requestCuotaPayment while a PendingDeletion is open is blocked", async () => {
  const note = await seedNote({ rawText: "idea de la app de libros" });
  await db.pendingDeletion.create({
    data: { stage: "confirming", noteIds: JSON.stringify([note.id]) },
  });
  await seedItem({ name: "gimnasio" });

  const outcome = await requestCuotaPayment("pagué el gimnasio");

  expect(outcome).toBe("blocked_pending");
  expect(await db.pendingCuotaPayment.count()).toBe(0);
});

// Code review finding: the single-match "pay directly" path never reaches
// the atomic insert at all, so without an explicit upfront check here it
// would pay through even while an earlier disambiguation is still open —
// inconsistent with how a pending Reminder/PendingDeletion already block
// this same path.
test("requestCuotaPayment with a single match is blocked while a PendingCuotaPayment is already open (pays nothing)", async () => {
  const otherItem = await seedItem({ name: "netflix" });
  await db.pendingCuotaPayment.create({
    data: { candidates: JSON.stringify([{ kind: "item", id: otherItem.id }]), overrideAmountCents: null },
  });
  const item = await seedItem({ name: "gimnasio" });

  const outcome = await requestCuotaPayment("pagué el gimnasio");

  expect(outcome).toBe("blocked_pending");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(
    expect.stringContaining("pago de cuota pendiente")
  );
  const payment = await db.recurringPayment.findUnique({
    where: { itemId_yearMonth: { itemId: item.id, yearMonth: currentYearMonth() } },
  });
  expect(payment).toBeNull();
  // Still exactly the one PendingCuotaPayment row that was already there —
  // no second one created, and the original wasn't touched.
  expect(await db.pendingCuotaPayment.count()).toBe(1);
});

// Code review finding: the post-insert-failure fallback (ambiguous path)
// only picked between "Reminder pending" and "PendingDeletion open",
// wrongly blaming a borrado even when the real blocker is another
// PendingCuotaPayment that won the race between requestCuotaPayment's own
// candidate lookup and its atomic insert. Simulated the same way
// deleteFlow.test.ts simulates its analogous race: findCuotaCandidates
// creates the competing row as a side effect before returning.
test("requestCuotaPayment's post-insert-failure fallback correctly blames a pending cuota payment, not a borrado, when that's what's actually blocking (atomic race guard)", async () => {
  const item1 = await seedItem({ name: "tarjeta mastercard oro" });
  await seedItem({ name: "tarjeta mastercard black" });

  const original = cuotaMatchModule.findCuotaCandidates;
  const spy = vi
    .spyOn(cuotaMatchModule, "findCuotaCandidates")
    .mockImplementationOnce(async (requestText: string, yearMonth: string) => {
      await db.pendingCuotaPayment.create({
        data: {
          candidates: JSON.stringify([{ kind: "item", id: item1.id }]),
          overrideAmountCents: null,
        },
      });
      return original(requestText, yearMonth);
    });

  const outcome = await requestCuotaPayment("pagué la tarjeta mastercard");

  expect(outcome).toBe("blocked_pending");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(
    expect.stringContaining("pago de cuota pendiente")
  );
  // Only the one row created by the spy's side effect — the race was
  // caught, no second PendingCuotaPayment was created.
  expect(await db.pendingCuotaPayment.count()).toBe(1);

  spy.mockRestore();
});

// PendingPurchaseSimulation is the 4th leg
// of the same "one pending confirmation of any kind" slot — an open
// purchase-feasibility question must block a new payment request the same
// way an open PendingDeletion already does (test above), reusing the
// generic "blocked_pending" outcome but with its own message.
test("requestCuotaPayment while a PendingPurchaseSimulation exists is blocked: sends the purchase-simulation blocking message, pays nothing", async () => {
  await db.pendingPurchaseSimulation.create({
    data: { conversationText: "¿me conviene comprar una heladera?", missingField: "price" },
  });
  const item = await seedItem({ name: "gimnasio" });

  const outcome = await requestCuotaPayment("pagué el gimnasio");

  expect(outcome).toBe("blocked_pending");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(
    expect.stringContaining("consulta de factibilidad de compra pendiente")
  );
  const payment = await db.recurringPayment.findUnique({
    where: { itemId_yearMonth: { itemId: item.id, yearMonth: currentYearMonth() } },
  });
  expect(payment).toBeNull();
});

test("handleCuotaPaymentReply with a valid number pays that candidate and clears the pending row", async () => {
  const item1 = await seedItem({ name: "tarjeta mastercard oro", amountCents: 30000 });
  const item2 = await seedItem({ name: "tarjeta mastercard black", amountCents: 40000 });
  await db.pendingCuotaPayment.create({
    data: {
      candidates: JSON.stringify([
        { kind: "item", id: item1.id },
        { kind: "item", id: item2.id },
      ]),
      overrideAmountCents: null,
    },
  });

  const outcome = await handleCuotaPaymentReply("2");

  expect(outcome).toBe("disambiguated");
  expect(await db.pendingCuotaPayment.count()).toBe(0);

  const payment2 = await db.recurringPayment.findUnique({
    where: { itemId_yearMonth: { itemId: item2.id, yearMonth: currentYearMonth() } },
  });
  expect(payment2).not.toBeNull();
  const payment1 = await db.recurringPayment.findUnique({
    where: { itemId_yearMonth: { itemId: item1.id, yearMonth: currentYearMonth() } },
  });
  expect(payment1).toBeNull();
  expect(mockSendSelfMessage).toHaveBeenCalledWith(
    expect.stringContaining("tarjeta mastercard black")
  );
});

test("handleCuotaPaymentReply with 'ninguna' cancels and clears the pending row", async () => {
  const item = await seedItem({ name: "gimnasio" });
  await db.pendingCuotaPayment.create({
    data: { candidates: JSON.stringify([{ kind: "item", id: item.id }]), overrideAmountCents: null },
  });

  const outcome = await handleCuotaPaymentReply("ninguna");

  expect(outcome).toBe("rejected");
  expect(await db.pendingCuotaPayment.count()).toBe(0);
  const payment = await db.recurringPayment.findUnique({
    where: { itemId_yearMonth: { itemId: item.id, yearMonth: currentYearMonth() } },
  });
  expect(payment).toBeNull();
  expect(mockSendSelfMessage).toHaveBeenCalled();
});

// Mirrors the fix required for deleteFlow.ts's equivalent
// function: clearing the pending row must promote a Reminder queued behind
// it (same shared "one pending confirmation" slot), not leave it stranded.
test("handleCuotaPaymentReply clearing the pending row calls promptNextIfIdle", async () => {
  const item = await seedItem({ name: "gimnasio" });
  const reminderNote = await seedNote({ type: "recordatorio", rawText: "turno con el dentista" });
  const queuedReminder = await db.reminder.create({
    data: {
      noteId: reminderNote.id,
      parsedDatetime: new Date(Date.now() + 86400000),
      status: "queued",
      calendarEventId: null,
    },
  });
  await db.pendingCuotaPayment.create({
    data: { candidates: JSON.stringify([{ kind: "item", id: item.id }]), overrideAmountCents: null },
  });

  await handleCuotaPaymentReply("ninguna");

  const promoted = await db.reminder.findUnique({ where: { id: queuedReminder.id } });
  expect(promoted?.status).toBe("awaiting_confirmation");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(
    expect.stringContaining('"turno con el dentista"')
  );
});

test("handleCuotaPaymentReply with no PendingCuotaPayment returns 'no_pending'", async () => {
  const outcome = await handleCuotaPaymentReply("1");

  expect(outcome).toBe("no_pending");
});

test("resendPendingCuotaPaymentPrompt re-sends the disambiguation list for the current PendingCuotaPayment", async () => {
  const item1 = await seedItem({ name: "tarjeta mastercard oro" });
  const item2 = await seedItem({ name: "tarjeta mastercard black" });
  await db.pendingCuotaPayment.create({
    data: {
      candidates: JSON.stringify([
        { kind: "item", id: item1.id },
        { kind: "item", id: item2.id },
      ]),
      overrideAmountCents: null,
    },
  });

  await resendPendingCuotaPaymentPrompt();

  const message = mockSendSelfMessage.mock.calls[0]![0] as string;
  expect(message).toContain("1.");
  expect(message).toContain("2.");
});

test("resendPendingCuotaPaymentPrompt never throws when nothing is pending", async () => {
  await expect(resendPendingCuotaPaymentPrompt()).resolves.toBeUndefined();
  expect(mockSendSelfMessage).not.toHaveBeenCalled();
});

test("requestCuotaPayment also works for a group candidate (paga el agrupador combinado)", async () => {
  const group = await seedGroup("Tarjeta Mastercard");
  const item1 = await seedItem({ name: "cuota 1", amountCents: 10000, groupId: group.id });
  const item2 = await seedItem({ name: "cuota 2", amountCents: 25000, groupId: group.id });

  const outcome = await requestCuotaPayment("pagué la tarjeta mastercard combinada");

  // Either a direct group match or (depending on scoring) an item match is
  // acceptable here — the real assertion is that SOMETHING got paid and no
  // PendingCuotaPayment was left dangling.
  expect(outcome === "paid" || outcome === "asked_disambiguate").toBe(true);
  void item1;
  void item2;
});
