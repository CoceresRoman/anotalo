import { randomUUID } from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";
import db from "../db";

// Only the Groq class itself is replaced, same pattern as classify.test.ts
// and transcribe.test.ts.
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

import { answerQuery } from "./query";

// Queues the next Groq chat-completion response as JSON — used for the
// first call (date/category/type filter extraction).
function mockGroqChatToReturn(payload: unknown) {
  const content = typeof payload === "string" ? payload : JSON.stringify(payload);
  mockCreate.mockResolvedValueOnce({ choices: [{ message: { content } }] });
}

// Same mechanism as mockGroqChatToReturn, named separately so a test
// reads as "first call returns X, second call returns Y" — used for the
// second call (composing the natural-language answer from matched rows,
// which is free text, not JSON).
function mockGroqChatToReturnOnNextCall(text: string) {
  mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: text } }] });
}

function mockGroqChatToThrow() {
  mockCreate.mockRejectedValueOnce(new Error("Groq API error"));
}

async function seedExpense({
  amountCents,
  category,
  occurredAt,
  currency,
}: {
  amountCents: number;
  category: string;
  occurredAt: string;
  currency?: string;
}) {
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
      amountCents,
      category,
      occurredAt: new Date(occurredAt),
      ...(currency ? { currency } : {}),
    },
  });
}

async function seedIdea({ rawText, createdAt }: { rawText: string; createdAt: string }) {
  return db.note.create({
    data: {
      rawText,
      source: "text",
      type: "idea",
      whatsappMessageId: randomUUID(),
      createdAt: new Date(createdAt),
    },
  });
}

beforeEach(async () => {
  await db.expense.deleteMany();
  await db.reminder.deleteMany();
  await db.note.deleteMany();
  mockCreate.mockReset();
});

test("answerQuery answers from the actual stored notes, not from the LLM's own knowledge", async () => {
  await seedExpense({ amountCents: 320000, category: "comida", occurredAt: "2026-10-28" }); // a Wednesday
  mockGroqChatToReturn({ dateFrom: "2026-10-26", dateTo: "2026-10-28" }); // first call: extract range
  mockGroqChatToReturnOnNextCall("El miércoles anotaste un gasto de comida por $3.200."); // second call: compose answer
  const answer = await answerQuery("¿qué compré el miércoles?", "2026-10-29T09:00:00Z");
  expect(answer).toContain("3.200");
  expect(mockCreate).toHaveBeenCalledTimes(2);
});

test("answerQuery says nothing was found instead of fabricating an answer when no rows match", async () => {
  mockGroqChatToReturn({ dateFrom: "2026-01-01", dateTo: "2026-01-02" });
  const answer = await answerQuery("¿qué gasté el 1 de enero?", "2026-10-29T09:00:00Z");
  expect(answer.toLowerCase()).toContain("no encontré");
  // The no-results short-circuit must skip the second (compose-answer) call.
  expect(mockCreate).toHaveBeenCalledTimes(1);
});

test("answerQuery passes the matched rows (not the raw question alone) as grounding context to the compose-answer call", async () => {
  await seedExpense({ amountCents: 150000, category: "transporte", occurredAt: "2026-10-15" });
  mockGroqChatToReturn({ dateFrom: "2026-10-01", dateTo: "2026-10-31" });
  mockGroqChatToReturnOnNextCall("Gastaste $1.500 en transporte el 15/10.");

  const answer = await answerQuery("¿cuánto gasté en transporte este mes?", "2026-10-29T09:00:00Z");

  expect(answer).toBe("Gastaste $1.500 en transporte el 15/10.");
  const secondCallParams = mockCreate.mock.calls[1]![0];
  const systemMessage = secondCallParams.messages.find((m: { role: string }) => m.role === "system");
  expect(systemMessage.content).toContain("transporte");
  expect(systemMessage.content).toContain("1.500");
});

test("answerQuery applies the extracted category filter, excluding matches from other categories in the same date range", async () => {
  await seedExpense({ amountCents: 500000, category: "comida", occurredAt: "2026-10-15" });
  await seedExpense({ amountCents: 200000, category: "transporte", occurredAt: "2026-10-15" });
  mockGroqChatToReturn({ dateFrom: "2026-10-01", dateTo: "2026-10-31", category: "transporte" });
  mockGroqChatToReturnOnNextCall("Gastaste $2.000 en transporte.");

  const answer = await answerQuery("¿cuánto gasté en transporte este mes?", "2026-10-29T09:00:00Z");

  expect(answer).toBe("Gastaste $2.000 en transporte.");
  const secondCallParams = mockCreate.mock.calls[1]![0];
  const systemMessage = secondCallParams.messages.find((m: { role: string }) => m.role === "system");
  expect(systemMessage.content).toContain("transporte");
  expect(systemMessage.content).not.toContain("comida");
});

test("answerQuery falls back to the last 30 days when the filter-extraction response is invalid JSON, and still finds a recent note", async () => {
  await seedIdea({ rawText: "una idea reciente", createdAt: "2026-10-20T10:00:00Z" });
  mockGroqChatToReturn("not json"); // first call: malformed -> falls back to a 30-day window
  mockGroqChatToReturnOnNextCall("Anotaste una idea reciente.");

  const answer = await answerQuery("¿qué anoté últimamente?", "2026-10-29T09:00:00Z");

  expect(answer).toBe("Anotaste una idea reciente.");
});

test("answerQuery never throws and returns the apology message when the filter-extraction call throws", async () => {
  mockGroqChatToThrow(); // first call fails outright
  mockGroqChatToReturnOnNextCall("esto no debería importar");

  // Even though extraction fails, the fallback 30-day window plus an empty
  // DB still resolves cleanly to the no-results message, not a throw.
  const answer = await answerQuery("¿qué gasté?", "2026-10-29T09:00:00Z");
  expect(answer.toLowerCase()).toContain("no encontré");
});

test("answerQuery returns the apology message (never throws) when the compose-answer call fails after matches are found", async () => {
  await seedExpense({ amountCents: 320000, category: "comida", occurredAt: "2026-10-28" });
  mockGroqChatToReturn({ dateFrom: "2026-10-26", dateTo: "2026-10-28" });
  mockCreate.mockRejectedValueOnce(new Error("Groq API error on second call"));

  const answer = await answerQuery("¿qué compré el miércoles?", "2026-10-29T09:00:00Z");
  expect(answer).toBe("No pude buscar eso ahora, probá de nuevo en un rato.");
});

test("answerQuery returns the apology message (never throws) when the database query itself fails", async () => {
  mockGroqChatToReturn({ dateFrom: "2026-10-26", dateTo: "2026-10-28" });
  const originalFindMany = db.note.findMany.bind(db.note);
  const findManySpy = vi.spyOn(db.note, "findMany").mockRejectedValueOnce(new Error("DB is down"));

  const answer = await answerQuery("¿qué compré el miércoles?", "2026-10-29T09:00:00Z");

  expect(answer).toBe("No pude buscar eso ahora, probá de nuevo en un rato.");
  // Not mockRestore(): on Prisma's proxied model delegate neither restoring
  // nor the spy's default call-through gives back a working findMany, which
  // silently broke every later test in this file. Re-point the spy at the
  // real (bound) method instead.
  findManySpy.mockImplementation(originalFindMany as never);
});

// "the 28th" means the Argentina calendar day, also on a UTC server.
test("answerQuery filters days by Argentina calendar day, not UTC/server-local day, and shows Argentina dates to the model", async () => {
  const originalTz = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    // 22:30 ART on Oct 28 is already Oct 29 in UTC.
    await seedExpense({ amountCents: 100000, category: "cena", occurredAt: "2026-10-28T22:30:00-03:00" });
    // 22:00 ART on Oct 27 is already Oct 28 in UTC — must NOT match the 28th.
    await seedExpense({ amountCents: 900000, category: "otra", occurredAt: "2026-10-27T22:00:00-03:00" });
    mockGroqChatToReturn({ dateFrom: "2026-10-28", dateTo: "2026-10-28" });
    mockGroqChatToReturnOnNextCall("Gastaste $1.000 en cena.");

    await answerQuery("¿qué gasté el miércoles?", "2026-10-29T12:00:00Z");

    const context: string = mockCreate.mock.calls[1]![0].messages[0].content;
    expect(context).toContain("cena");
    expect(context).toContain("2026-10-28");
    expect(context).not.toContain("otra");
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test("answerQuery tells the filter-extraction model the user's timezone and the current Argentina time", async () => {
  mockGroqChatToReturn({ dateFrom: "2026-01-01", dateTo: "2026-01-02" });
  await answerQuery("¿qué anoté ayer?", "2026-10-29T02:00:00.000Z");
  const system: string = mockCreate.mock.calls[0]![0].messages[0].content;
  expect(system).toContain("America/Argentina/Buenos_Aires");
  // 02:00Z on Oct 29 is still Oct 28 in Argentina — "ayer" must be the 27th.
  expect(system).toContain("2026-10-28T23:00:00-03:00");
});

test("answerQuery labels a non-peso expense with its currency in the grounding context", async () => {
  await seedExpense({ amountCents: 5000, category: "suscripciones", occurredAt: "2026-10-15T12:00:00-03:00", currency: "USD" });
  mockGroqChatToReturn({ dateFrom: "2026-10-01", dateTo: "2026-10-31" });
  mockGroqChatToReturnOnNextCall("Pagaste US$50.");

  await answerQuery("¿cuánto pagué de suscripciones?", "2026-10-29T09:00:00Z");

  const context: string = mockCreate.mock.calls[1]![0].messages[0].content;
  // Rendered via Intl (formatAmount -> formatMoney in src/lib/money.ts), not
  // the old hardcoded CURRENCY_LABELS/.slice(1) hack — es-AR/USD has no
  // space between the symbol and the number ("US$50", not "US$ 50").
  expect(context).toContain("US$50");
});
