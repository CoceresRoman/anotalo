import { expect, test, vi } from "vitest";

// Mismo mock que purchaseFeasibility.test.ts: solo se reemplaza la clase
// Groq, igual que query.test.ts.
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

import { extractReceiptFromImage, type ReceiptExtraction } from "./ocrReceipt";

function mockGroqChatToReturn(payload: unknown) {
  const content = typeof payload === "string" ? payload : JSON.stringify(payload);
  mockCreate.mockResolvedValueOnce({ choices: [{ message: { content } }] });
}

function mockGroqChatToThrow() {
  mockCreate.mockRejectedValueOnce(new Error("Groq API error"));
}

test("extractReceiptFromImage: ticket legible con alta confianza devuelve los 4 campos", async () => {
  mockGroqChatToReturn({
    readable: true,
    amountCents: 1_250_000,
    category: "Mercado",
    date: "2026-11-03",
    confidencePercent: 92,
  });
  const result = await extractReceiptFromImage(Buffer.from("fake"), "2026-11-04T12:00:00-03:00");
  expect(result).toEqual({
    amountCents: 1_250_000,
    category: "Mercado",
    occurredAt: new Date("2026-11-03T00:00:00-03:00"),
    confidencePercent: 92,
  });
});

test("extractReceiptFromImage: ticket sin fecha usa el momento de envío como respaldo", async () => {
  mockGroqChatToReturn({
    readable: true,
    amountCents: 50_000,
    category: "Comida",
    date: null,
    confidencePercent: 80,
  });
  const result = await extractReceiptFromImage(Buffer.from("fake"), "2026-11-04T12:00:00-03:00");
  expect((result as ReceiptExtraction).occurredAt).toEqual(new Date("2026-11-04T12:00:00-03:00"));
});

test("extractReceiptFromImage: fecha claramente inválida (futura) usa el momento de envío como respaldo", async () => {
  mockGroqChatToReturn({
    readable: true,
    amountCents: 50_000,
    category: "Comida",
    date: "2099-01-01",
    confidencePercent: 80,
  });
  const result = await extractReceiptFromImage(Buffer.from("fake"), "2026-11-04T12:00:00-03:00");
  expect((result as ReceiptExtraction).occurredAt).toEqual(new Date("2026-11-04T12:00:00-03:00"));
});

test("extractReceiptFromImage: fecha claramente inválida (más de 180 días en el pasado) usa el momento de envío como respaldo", async () => {
  mockGroqChatToReturn({
    readable: true,
    amountCents: 50_000,
    category: "Comida",
    date: "2026-01-01",
    confidencePercent: 80,
  });
  const result = await extractReceiptFromImage(Buffer.from("fake"), "2026-11-04T12:00:00-03:00");
  expect((result as ReceiptExtraction).occurredAt).toEqual(new Date("2026-11-04T12:00:00-03:00"));
});

test("extractReceiptFromImage: Groq marca la imagen como no legible", async () => {
  mockGroqChatToReturn({ readable: false });
  const result = await extractReceiptFromImage(Buffer.from("fake"), "2026-11-04T12:00:00-03:00");
  expect(result).toBe("unreadable");
});

test("extractReceiptFromImage: falla de red devuelve 'failed', nunca 'unreadable'", async () => {
  mockGroqChatToThrow();
  const result = await extractReceiptFromImage(Buffer.from("fake"), "2026-11-04T12:00:00-03:00");
  expect(result).toBe("failed");
});

test("extractReceiptFromImage: JSON con forma inválida devuelve 'failed'", async () => {
  mockGroqChatToReturn({ readable: true, amountCents: "no es un número" });
  const result = await extractReceiptFromImage(Buffer.from("fake"), "2026-11-04T12:00:00-03:00");
  expect(result).toBe("failed");
});
