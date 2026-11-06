import { randomUUID } from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";

// Only the Groq class itself is replaced, same pattern as
// purchaseFeasibility.test.ts/query.test.ts — extractPurchaseParams and
// composeFeasibilityAnswer (both real, imported from purchaseFeasibility.ts)
// are exercised against a real (test) DB; only their underlying Groq network
// call is faked.
const { mockCreate } = vi.hoisted(() => {
  return { mockCreate: vi.fn() };
});

vi.mock("groq-sdk", async () => {
  const actual = await vi.importActual<typeof import("groq-sdk")>("groq-sdk");
  class FakeGroq {
    chat = {
      completions: {
        create: mockCreate,
      },
    };
  }
  return {
    ...actual,
    default: FakeGroq,
  };
});

const mockSendSelfMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./connection", () => ({ sendSelfMessage: mockSendSelfMessage }));

import db from "../db";
import { addMonthsToYearMonth } from "../cuotas";
import { toArgentinaDateString } from "../timezone";
import { NO_HISTORY_MESSAGE } from "./purchaseFeasibility";
import {
  determineMissingField,
  handlePurchaseFeasibilityReply,
  requestPurchaseFeasibility,
  resendPendingPurchaseFeasibilityPrompt,
} from "./purchaseFeasibilityFlow";
// Imported as a namespace (not destructured) specifically so a single test
// below can spy on extractPurchaseParams to simulate a concurrent
// requestPurchaseFeasibility creating its own PendingPurchaseSimulation row
// inside THIS call's own await window, landing after the upfront guard but
// before the atomic insert — same rationale/pattern as
// cuotaPaymentFlow.test.ts's analogous race test.
import * as purchaseFeasibilityModule from "./purchaseFeasibility";

// Queues the next Groq chat-completion response as JSON — used for the
// extraction call (extractPurchaseParams, Groq call #1).
function mockExtractionToReturn(payload: unknown) {
  const content = typeof payload === "string" ? payload : JSON.stringify(payload);
  mockCreate.mockResolvedValueOnce({ choices: [{ message: { content } }] });
}

// Used for the composition call (composeFeasibilityAnswer, Groq call #2),
// which returns free text, not JSON.
function mockCompositionToReturn(text: string) {
  mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: text } }] });
}

// Simulates the composition call (Groq call #2) failing — e.g. a network
// error — so composeFeasibilityAnswer's own throw (by design, when Groq
// fails) propagates up into computeAndSendFeasibilityAnswer, which must
// catch it and send a fixed failure message instead of letting it escape.
function mockCompositionToThrow() {
  mockCreate.mockRejectedValueOnce(new Error("Groq API error"));
}

function currentYearMonth(): string {
  return toArgentinaDateString(new Date()).slice(0, 7);
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

async function seedIncome({
  amountCents,
  isSalary = true,
  occurredAt,
}: {
  amountCents: number;
  isSalary?: boolean;
  occurredAt: string;
}) {
  const note = await db.note.create({
    data: {
      rawText: "ingreso de prueba",
      source: "text",
      type: "ingreso",
      whatsappMessageId: `test:${randomUUID()}`,
    },
  });
  return db.income.create({
    data: { noteId: note.id, amountCents, isSalary, occurredAt: new Date(occurredAt) },
  });
}

async function seedExpense({
  amountCents,
  category = "Otros",
  occurredAt,
}: {
  amountCents: number;
  category?: string;
  occurredAt: string;
}) {
  const note = await db.note.create({
    data: {
      rawText: "gasto de prueba",
      source: "text",
      type: "gasto",
      whatsappMessageId: `test:${randomUUID()}`,
    },
  });
  return db.expense.create({
    data: { noteId: note.id, amountCents, category, occurredAt: new Date(occurredAt) },
  });
}

// One past calendar month (relative to the real "now", like
// cuotaPaymentFlow.test.ts's own currentYearMonth helper) with movements —
// enough for evaluateFeasibility's monthsUsed > 0, so it never falls into
// "no_history" unless a test explicitly wants that.
async function seedOnePastMonthOfHistory() {
  const pastYearMonth = addMonthsToYearMonth(currentYearMonth(), -1);
  // Probe bien anterior (fuera de la ventana de 3 meses que mira
  // averagePastIncomeAndExpense): establece que la app ya trackeaba antes
  // de que arrancara pastYearMonth, así que ese mes queda CUBIERTO POR
  // COMPLETO — sin esto sería el primer mes parcial de uso y quedaría
  // excluido (ver el chequeo de cobertura).
  const probeYearMonth = addMonthsToYearMonth(currentYearMonth(), -5);
  await seedExpense({ amountCents: 1, occurredAt: `${probeYearMonth}-15T12:00:00-03:00` });
  await seedIncome({ amountCents: 300_000_00, occurredAt: `${pastYearMonth}-10T12:00:00-03:00` });
  await seedExpense({ amountCents: 80_000_00, occurredAt: `${pastYearMonth}-20T12:00:00-03:00` });
}

beforeEach(async () => {
  await db.recurringPayment.deleteMany();
  await db.income.deleteMany();
  await db.expense.deleteMany();
  await db.pendingCuotaPayment.deleteMany();
  await db.pendingDeletion.deleteMany();
  await db.pendingPurchaseSimulation.deleteMany();
  await db.reminder.deleteMany();
  await db.note.deleteMany();
  await db.recurringItem.deleteMany();
  await db.recurringGroup.deleteMany();
  mockCreate.mockReset();
  mockSendSelfMessage.mockReset().mockResolvedValue(undefined);
});

// --- determineMissingField (pure function, no DB) --------------------------

test("determineMissingField: {} -> price falta antes que nada", () => {
  expect(determineMissingField({})).toBe("price");
});

test("determineMissingField: solo priceCents -> mode", () => {
  expect(determineMissingField({ priceCents: 1000 })).toBe("mode");
});

test("determineMissingField: priceCents + mode contado -> null (no necesita más nada)", () => {
  expect(determineMissingField({ priceCents: 1000, mode: "contado" })).toBeNull();
});

test("determineMissingField: priceCents + mode cuotas, sin installments -> installments", () => {
  expect(determineMissingField({ priceCents: 1000, mode: "cuotas" })).toBe("installments");
});

test("determineMissingField: con installments y sin hasInterest -> null (se asume 0%)", () => {
  expect(
    determineMissingField({ priceCents: 1000, mode: "cuotas", installments: 6 })
  ).toBeNull();
});

test("determineMissingField: hasInterest true sin tnaPercent ni totalToPayCents -> interest", () => {
  expect(
    determineMissingField({
      priceCents: 1000,
      mode: "cuotas",
      installments: 6,
      hasInterest: true,
    })
  ).toBe("interest");
});

test("determineMissingField: hasInterest true con tnaPercent -> null", () => {
  expect(
    determineMissingField({
      priceCents: 1000,
      mode: "cuotas",
      installments: 6,
      hasInterest: true,
      tnaPercent: 40,
    })
  ).toBeNull();
});

test("determineMissingField: mode ambos sin installments -> installments (igual que cuotas)", () => {
  expect(determineMissingField({ priceCents: 1000, mode: "ambos" })).toBe("installments");
});

test("determineMissingField: modo ahorrar con priceCents no pide nada más", () => {
  expect(determineMissingField({ priceCents: 1000, mode: "ahorrar" })).toBe(null);
});

test("determineMissingField: modo recurrente con priceCents (el monto mensual) no pide nada más", () => {
  expect(determineMissingField({ priceCents: 1000, mode: "recurrente" })).toBe(null);
});

test("determineMissingField: modo recurrente sin priceCents pide price antes que nada", () => {
  expect(determineMissingField({ mode: "recurrente" })).toBe("price");
});

// --- requestPurchaseFeasibility --------------------------------------------

test("requestPurchaseFeasibility: extracción completa con historial -> answered, un solo sendSelfMessage con el texto compuesto", async () => {
  await seedOnePastMonthOfHistory();
  mockExtractionToReturn({ priceCents: 500_000_00, mode: "contado" });
  mockCompositionToReturn("Te conviene, está cómoda.");

  const outcome = await requestPurchaseFeasibility("¿me conviene comprar una heladera de 500.000 de contado?");

  expect(outcome).toBe("answered");
  expect(mockSendSelfMessage).toHaveBeenCalledTimes(1);
  expect(mockSendSelfMessage).toHaveBeenCalledWith("Te conviene, está cómoda.");
  expect(await db.pendingPurchaseSimulation.count()).toBe(0);
});

// Controller-upgraded review finding: composeFeasibilityAnswer throws by
// design when Groq fails (mirrors query.ts's composeAnswer), and
// router.ts's handleIncomingMessage only wraps classifyAndHandle in
// try/finally, not try/catch — so an uncaught throw here would escape the
// whole WhatsApp message handler for that message, violating the app's own
// "never drop a message" invariant. This must resolve to a sent failure
// message, never an uncaught rejection out of requestPurchaseFeasibility.
test("requestPurchaseFeasibility: si composeFeasibilityAnswer falla (Groq), manda un mensaje de falla fijo en vez de propagar la excepción", async () => {
  await seedOnePastMonthOfHistory();
  mockExtractionToReturn({ priceCents: 500_000_00, mode: "contado" });
  mockCompositionToThrow();

  const outcome = await requestPurchaseFeasibility("¿me conviene comprar una heladera de 500.000 de contado?");

  expect(outcome).toBe("answered");
  expect(mockSendSelfMessage).toHaveBeenCalledTimes(1);
  const sentMessage = mockSendSelfMessage.mock.calls[0]![0] as string;
  expect(sentMessage).not.toBe("");
  expect(sentMessage.toLowerCase()).toContain("no pude calcular");
  expect(await db.pendingPurchaseSimulation.count()).toBe(0);
});

test("requestPurchaseFeasibility: falta installments -> asked_clarify, crea PendingPurchaseSimulation con missingField installments", async () => {
  mockExtractionToReturn({ priceCents: 500_000_00, mode: "cuotas" });

  const outcome = await requestPurchaseFeasibility("quiero comprar una heladera de 500.000 en cuotas");

  expect(outcome).toBe("asked_clarify");
  const pending = await db.pendingPurchaseSimulation.findFirst();
  expect(pending).not.toBeNull();
  expect(pending!.missingField).toBe("installments");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining("¿En cuántas cuotas?"));
});

test("requestPurchaseFeasibility while a Reminder is awaiting_confirmation is blocked", async () => {
  const note = await seedNote({ type: "recordatorio", rawText: "turno con el dentista" });
  await db.reminder.create({
    data: {
      noteId: note.id,
      parsedDatetime: new Date(Date.now() + 86400000),
      status: "awaiting_confirmation",
      calendarEventId: null,
    },
  });

  const outcome = await requestPurchaseFeasibility("¿me conviene comprar una heladera?");

  expect(outcome).toBe("blocked_pending");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining("recordatorio pendiente"));
  expect(await db.pendingPurchaseSimulation.count()).toBe(0);
  expect(mockCreate).not.toHaveBeenCalled();
});

test("requestPurchaseFeasibility while a PendingDeletion is open is blocked", async () => {
  const note = await seedNote({ rawText: "idea de la app de libros" });
  await db.pendingDeletion.create({
    data: { stage: "confirming", noteIds: JSON.stringify([note.id]) },
  });

  const outcome = await requestPurchaseFeasibility("¿me conviene comprar una heladera?");

  expect(outcome).toBe("blocked_pending");
  expect(await db.pendingPurchaseSimulation.count()).toBe(0);
});

test("requestPurchaseFeasibility while a PendingCuotaPayment is open is blocked", async () => {
  const item = await db.recurringItem.create({
    data: { name: "gimnasio", amountCents: 10000, startInstallment: 1, startYearMonth: currentYearMonth() },
  });
  await db.pendingCuotaPayment.create({
    data: { candidates: JSON.stringify([{ kind: "item", id: item.id }]), overrideAmountCents: null },
  });

  const outcome = await requestPurchaseFeasibility("¿me conviene comprar una heladera?");

  expect(outcome).toBe("blocked_pending");
  expect(await db.pendingPurchaseSimulation.count()).toBe(0);
});

test("requestPurchaseFeasibility while a PendingPurchaseSimulation already exists is blocked", async () => {
  await db.pendingPurchaseSimulation.create({
    data: { conversationText: "¿me conviene comprar una moto?", missingField: "price" },
  });

  const outcome = await requestPurchaseFeasibility("¿me conviene comprar una heladera?");

  expect(outcome).toBe("blocked_pending");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(
    expect.stringContaining("consulta de factibilidad de compra pendiente")
  );
  // Still exactly the one row that was already there.
  expect(await db.pendingPurchaseSimulation.count()).toBe(1);
});

// The actual safety net for the "missing field" path: a concurrent
// requestPurchaseFeasibility (or enqueueReminder/requestDelete/
// requestCuotaPayment) landing in the await window between the upfront
// guard and the atomic insert is caught there, and the post-insert-failure
// fallback must correctly blame the PendingPurchaseSimulation that actually
// won the race (not silently drop the notice) — mirrors
// cuotaPaymentFlow.test.ts's own race test for its 4th-leg fallback.
test("requestPurchaseFeasibility's post-insert-failure fallback blocks on a PendingPurchaseSimulation created by a concurrent call (atomic race guard)", async () => {
  const original = purchaseFeasibilityModule.extractPurchaseParams;
  const spy = vi
    .spyOn(purchaseFeasibilityModule, "extractPurchaseParams")
    .mockImplementationOnce(async (text: string) => {
      await db.pendingPurchaseSimulation.create({
        data: { conversationText: "otra consulta concurrente", missingField: "price" },
      });
      return original(text);
    });
  mockExtractionToReturn({ priceCents: 500_000_00, mode: "cuotas" });

  const outcome = await requestPurchaseFeasibility("quiero comprar una heladera de 500.000 en cuotas");

  expect(outcome).toBe("blocked_pending");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(
    expect.stringContaining("consulta de factibilidad de compra pendiente")
  );
  // Only the one row created by the spy's side effect — the race was
  // caught, no second PendingPurchaseSimulation was created.
  expect(await db.pendingPurchaseSimulation.count()).toBe(1);

  spy.mockRestore();
});

test("requestPurchaseFeasibility: 0 meses de historial, extracción completa -> answered con NO_HISTORY_MESSAGE tal cual, sin segundo llamado a Groq", async () => {
  mockExtractionToReturn({ priceCents: 500_000_00, mode: "contado" });

  const outcome = await requestPurchaseFeasibility("¿me conviene comprar una heladera de contado?");

  expect(outcome).toBe("answered");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(NO_HISTORY_MESSAGE);
  // Assert the second Groq call
  // (composeFeasibilityAnswer's underlying call) was never made once
  // evaluateFeasibility already resolved "no_history".
  expect(mockCreate).not.toHaveBeenCalledTimes(2);
  expect(mockCreate).toHaveBeenCalledTimes(1);
});

// --- handlePurchaseFeasibilityReply ----------------------------------------

test("handlePurchaseFeasibilityReply: responde el campo que faltaba (installments) -> answered, borra la fila, llama promptNextIfIdle", async () => {
  await seedOnePastMonthOfHistory();
  await db.pendingPurchaseSimulation.create({
    data: {
      conversationText: "quiero comprar una heladera de 500.000 en cuotas",
      missingField: "installments",
    },
  });
  const reminderNote = await seedNote({ type: "recordatorio", rawText: "turno con el dentista" });
  const queuedReminder = await db.reminder.create({
    data: {
      noteId: reminderNote.id,
      parsedDatetime: new Date(Date.now() + 86400000),
      status: "queued",
      calendarEventId: null,
    },
  });
  mockExtractionToReturn({ priceCents: 500_000_00, mode: "cuotas", installments: 6 });
  mockCompositionToReturn("En 6 cuotas te queda cómoda.");

  const outcome = await handlePurchaseFeasibilityReply("6 cuotas");

  expect(outcome).toBe("answered");
  expect(await db.pendingPurchaseSimulation.count()).toBe(0);
  expect(mockSendSelfMessage).toHaveBeenCalledWith("En 6 cuotas te queda cómoda.");

  const promoted = await db.reminder.findUnique({ where: { id: queuedReminder.id } });
  expect(promoted?.status).toBe("awaiting_confirmation");
});

// Same controller-upgraded finding as requestPurchaseFeasibility's own
// equivalent test above, but for the "answered" path reached through a
// reply (the row must still be gone — it was already deleted BEFORE this
// compute/compose step — even though Groq failed).
test("handlePurchaseFeasibilityReply: si composeFeasibilityAnswer falla (Groq) al responder la aclaración, manda un mensaje de falla fijo, no propaga, y la fila sigue borrada", async () => {
  await seedOnePastMonthOfHistory();
  await db.pendingPurchaseSimulation.create({
    data: {
      conversationText: "quiero comprar una heladera de 500.000 en cuotas",
      missingField: "installments",
    },
  });
  mockExtractionToReturn({ priceCents: 500_000_00, mode: "cuotas", installments: 6 });
  mockCompositionToThrow();

  const outcome = await handlePurchaseFeasibilityReply("6 cuotas");

  expect(outcome).toBe("answered");
  expect(await db.pendingPurchaseSimulation.count()).toBe(0);
  const sentMessage = mockSendSelfMessage.mock.calls.at(-1)![0] as string;
  expect(sentMessage.toLowerCase()).toContain("no pude calcular");
});

test("handlePurchaseFeasibilityReply: falta mode, la respuesta lo resuelve pero sigue faltando installments -> asked_clarify, fila actualizada (mismo id), nueva pregunta", async () => {
  const pending = await db.pendingPurchaseSimulation.create({
    data: { conversationText: "quiero comprar una heladera de 500.000", missingField: "mode" },
  });
  mockExtractionToReturn({ priceCents: 500_000_00, mode: "cuotas" });

  const outcome = await handlePurchaseFeasibilityReply("en cuotas");

  expect(outcome).toBe("asked_clarify");
  expect(await db.pendingPurchaseSimulation.count()).toBe(1);
  const updated = await db.pendingPurchaseSimulation.findUnique({ where: { id: pending.id } });
  expect(updated).not.toBeNull();
  expect(updated!.id).toBe(pending.id);
  expect(updated!.missingField).toBe("installments");
  expect(updated!.conversationText).toBe("quiero comprar una heladera de 500.000\nen cuotas");
  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining("¿En cuántas cuotas?"));
});

test("handlePurchaseFeasibilityReply: missingField interest sin progreso (re-extracción sigue sin tasa/total) -> unrecognized, fila intacta, nada enviado", async () => {
  const pending = await db.pendingPurchaseSimulation.create({
    data: {
      conversationText: "quiero comprar algo de 600.000 en 6 cuotas con interés",
      missingField: "interest",
    },
  });
  // La re-extracción sigue marcando hasInterest true pero sin tnaPercent ni
  // totalToPayCents -> determineMissingField vuelve a dar "interest". Ya no
  // hay un default silencioso de 0% — se trata igual que price/mode/
  // installments sin progreso.
  mockExtractionToReturn({
    priceCents: 600_000_00,
    mode: "cuotas",
    installments: 6,
    hasInterest: true,
  });

  const outcome = await handlePurchaseFeasibilityReply("no sé la tasa");

  expect(outcome).toBe("unrecognized");
  const untouched = await db.pendingPurchaseSimulation.findUnique({ where: { id: pending.id } });
  expect(untouched).not.toBeNull();
  expect(untouched!.missingField).toBe("interest");
  expect(mockSendSelfMessage).not.toHaveBeenCalled();
});

test("handlePurchaseFeasibilityReply: missingField price sin progreso (re-extracción sigue sin precio) -> unrecognized, fila intacta, nada enviado", async () => {
  const pending = await db.pendingPurchaseSimulation.create({
    data: { conversationText: "quiero comprar algo", missingField: "price" },
  });
  // El mensaje no tiene nada que ver con un precio (simula "pagué el
  // gimnasio" llegando mientras la pregunta del precio está abierta).
  mockExtractionToReturn({});

  const outcome = await handlePurchaseFeasibilityReply("pagué el gimnasio");

  expect(outcome).toBe("unrecognized");
  const untouched = await db.pendingPurchaseSimulation.findUnique({ where: { id: pending.id } });
  expect(untouched).not.toBeNull();
  expect(untouched!.conversationText).toBe("quiero comprar algo");
  expect(untouched!.missingField).toBe("price");
  expect(mockSendSelfMessage).not.toHaveBeenCalled();
});

test("handlePurchaseFeasibilityReply: missingField mode sin progreso -> unrecognized, fila intacta", async () => {
  const pending = await db.pendingPurchaseSimulation.create({
    data: { conversationText: "quiero comprar algo de 500.000", missingField: "mode" },
  });
  mockExtractionToReturn({ priceCents: 500_000_00 });

  const outcome = await handlePurchaseFeasibilityReply("no sé todavía");

  expect(outcome).toBe("unrecognized");
  const untouched = await db.pendingPurchaseSimulation.findUnique({ where: { id: pending.id } });
  expect(untouched!.missingField).toBe("mode");
  expect(mockSendSelfMessage).not.toHaveBeenCalled();
});

test("handlePurchaseFeasibilityReply: missingField installments sin progreso -> unrecognized, fila intacta", async () => {
  const pending = await db.pendingPurchaseSimulation.create({
    data: { conversationText: "quiero comprar algo de 500.000 en cuotas", missingField: "installments" },
  });
  mockExtractionToReturn({ priceCents: 500_000_00, mode: "cuotas" });

  const outcome = await handlePurchaseFeasibilityReply("todavía no sé");

  expect(outcome).toBe("unrecognized");
  const untouched = await db.pendingPurchaseSimulation.findUnique({ where: { id: pending.id } });
  expect(untouched!.missingField).toBe("installments");
  expect(mockSendSelfMessage).not.toHaveBeenCalled();
});

test("handlePurchaseFeasibilityReply: respuesta bare 'no' cancela sin llamar extractPurchaseParams de nuevo", async () => {
  await db.pendingPurchaseSimulation.create({
    data: { conversationText: "quiero comprar algo", missingField: "price" },
  });
  const reminderNote = await seedNote({ type: "recordatorio", rawText: "turno con el dentista" });
  const queuedReminder = await db.reminder.create({
    data: {
      noteId: reminderNote.id,
      parsedDatetime: new Date(Date.now() + 86400000),
      status: "queued",
      calendarEventId: null,
    },
  });

  const outcome = await handlePurchaseFeasibilityReply("no");

  expect(outcome).toBe("cancelled");
  expect(await db.pendingPurchaseSimulation.count()).toBe(0);
  expect(mockSendSelfMessage).toHaveBeenCalledWith("Dale, no sigo con esa consulta.");
  expect(mockCreate).not.toHaveBeenCalled();

  const promoted = await db.reminder.findUnique({ where: { id: queuedReminder.id } });
  expect(promoted?.status).toBe("awaiting_confirmation");
});

test("handlePurchaseFeasibilityReply with no PendingPurchaseSimulation returns no_pending", async () => {
  const outcome = await handlePurchaseFeasibilityReply("6 cuotas");
  expect(outcome).toBe("no_pending");
});

// --- resendPendingPurchaseFeasibilityPrompt --------------------------------

test("resendPendingPurchaseFeasibilityPrompt: sin fila pendiente no manda nada y nunca lanza", async () => {
  await expect(resendPendingPurchaseFeasibilityPrompt()).resolves.toBeUndefined();
  expect(mockSendSelfMessage).not.toHaveBeenCalled();
});

test("resendPendingPurchaseFeasibilityPrompt: con fila pendiente re-manda la pregunta correspondiente a missingField", async () => {
  await db.pendingPurchaseSimulation.create({
    data: { conversationText: "quiero comprar algo de 500.000", missingField: "mode" },
  });

  await resendPendingPurchaseFeasibilityPrompt();

  expect(mockSendSelfMessage).toHaveBeenCalledWith(
    expect.stringContaining("¿Lo pensás pagar en cuotas, de contado")
  );
});
