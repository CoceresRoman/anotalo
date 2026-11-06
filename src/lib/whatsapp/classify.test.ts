import { beforeEach, expect, test, vi } from "vitest";

// Only the Groq class itself is replaced, same pattern as transcribe.test.ts.
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

import { classifyMessage } from "./classify";

function mockGroqChatToReturn(payload: unknown) {
  const content = typeof payload === "string" ? payload : JSON.stringify(payload);
  mockCreate.mockResolvedValueOnce({ choices: [{ message: { content } }] });
}

function mockGroqChatToThrow() {
  mockCreate.mockRejectedValueOnce(new Error("Groq API error"));
}

beforeEach(() => {
  mockCreate.mockReset();
});

test("classifyMessage extracts amount and infers a category for an expense message", async () => {
  mockGroqChatToReturn({ intent: "capture", noteType: "gasto", amountCents: 320000, category: "Comida" });
  const result = await classifyMessage("compré un café, 3200 pesos", "2026-10-28T10:00:00Z");
  expect(result).toEqual({
    intent: "capture",
    noteType: "gasto",
    amountCents: 320000,
    category: "Comida",
    parsedDatetime: undefined,
  });
});

test("classifyMessage falls back to no_identificado when the Groq response is invalid JSON", async () => {
  mockGroqChatToReturn("not json");
  const result = await classifyMessage("algo raro", "2026-10-28T10:00:00Z");
  expect(result).toEqual({ intent: "capture", noteType: "no_identificado" });
});

test("classifyMessage falls back to no_identificado when the Groq call throws", async () => {
  mockGroqChatToThrow();
  const result = await classifyMessage("algo raro", "2026-10-28T10:00:00Z");
  expect(result).toEqual({ intent: "capture", noteType: "no_identificado" });
});

test("classifyMessage falls back to no_identificado when the response fails schema validation", async () => {
  mockGroqChatToReturn({ intent: "capture", noteType: "not-a-real-type" });
  const result = await classifyMessage("algo raro", "2026-10-28T10:00:00Z");
  expect(result).toEqual({ intent: "capture", noteType: "no_identificado" });
});

test("classifyMessage returns a query intent as-is, without expense fields", async () => {
  mockGroqChatToReturn({ intent: "query" });
  const result = await classifyMessage("¿cuánto gasté este mes?", "2026-10-28T10:00:00Z");
  expect(result).toEqual({ intent: "query" });
});

test("classifyMessage passes the current time and a forward-resolution instruction to the model", async () => {
  mockGroqChatToReturn({ intent: "capture", noteType: "idea" });
  await classifyMessage("recordame pensar en esto", "2026-10-28T10:00:00Z");

  expect(mockCreate).toHaveBeenCalledTimes(1);
  const params = mockCreate.mock.calls[0]![0];
  const systemMessage = params.messages.find((m: { role: string }) => m.role === "system");
  expect(systemMessage.content).toContain("2026-10-28T10:00:00Z");
  // Ambiguous weekday references must resolve forward
  // (the next future occurrence), never backward into the past.
  expect(systemMessage.content.toLowerCase()).toMatch(/futur/);
});

test("classifyMessage returns a recordatorio's parsedDatetime from the model", async () => {
  mockGroqChatToReturn({
    intent: "capture",
    noteType: "recordatorio",
    parsedDatetime: "2026-10-30T15:00:00-03:00",
  });
  const result = await classifyMessage("recordame el viernes a las 15", "2026-10-28T10:00:00Z");
  expect(result).toEqual({
    intent: "capture",
    noteType: "recordatorio",
    parsedDatetime: "2026-10-30T15:00:00-03:00",
  });
});

// The model must be told the user's timezone explicitly and be asked
// for an offset-qualified datetime — on a UTC server, "mañana a las 10"
// resolved as 10:00Z would be shown as "10:00" and land in Calendar at
// 07:00 Argentina time.
test("classifyMessage tells the model the user's timezone is Argentina and requires a -03:00 offset", async () => {
  mockGroqChatToReturn({ intent: "capture", noteType: "idea" });
  await classifyMessage("algo", "2026-10-28T13:00:00.000Z");

  const params = mockCreate.mock.calls[0]![0];
  const system: string = params.messages.find((m: { role: string }) => m.role === "system").content;
  expect(system).toContain("America/Argentina/Buenos_Aires");
  expect(system).toContain("-03:00");
  // "now" rendered as Argentina wall-clock time, not only as UTC.
  expect(system).toContain("2026-10-28T10:00:00-03:00");
});

for (const [label, value] of [
  ["no offset at all", "2026-10-30T15:00:00"],
  ["a bare UTC 'Z' instead of the Argentina offset", "2026-10-30T15:00:00Z"],
  ["a non-Argentina offset", "2026-10-30T15:00:00+02:00"],
  ["free text", "el viernes a las 15"],
  ["an impossible date", "2026-13-45T15:00:00-03:00"],
] as const) {
  test(`classifyMessage drops a recordatorio's parsedDatetime with ${label} (falls back to null, never trusted)`, async () => {
    mockGroqChatToReturn({ intent: "capture", noteType: "recordatorio", parsedDatetime: value });
    const result = await classifyMessage("recordame el viernes a las 15", "2026-10-28T10:00:00Z");
    expect(result.intent).toBe("capture");
    expect(result.noteType).toBe("recordatorio");
    expect(result.parsedDatetime).toBeNull();
  });
}

// "always resolve forward" is enforced in code, not only requested.
test("classifyMessage drops a parsedDatetime that resolves to the past relative to now", async () => {
  mockGroqChatToReturn({
    intent: "capture",
    noteType: "recordatorio",
    parsedDatetime: "2026-10-23T15:00:00-03:00",
  });
  const result = await classifyMessage("recordame el viernes a las 15", "2026-10-28T10:00:00Z");
  expect(result.parsedDatetime).toBeNull();
});

// Non-ARS amounts are flagged so they're never summed into peso totals.
test("classifyMessage returns a normalized non-ARS currency for a gasto", async () => {
  mockGroqChatToReturn({
    intent: "capture",
    noteType: "gasto",
    amountCents: 5000,
    category: "suscripciones",
    currency: "usd",
  });
  const result = await classifyMessage("pagué u$s 50 de netflix", "2026-10-28T10:00:00Z");
  expect(result.currency).toBe("USD");
  expect(result.amountCents).toBe(5000);
});

test("classifyMessage ignores a malformed currency instead of failing the whole classification", async () => {
  mockGroqChatToReturn({ intent: "capture", noteType: "gasto", amountCents: 100, currency: "dólares" });
  const result = await classifyMessage("gasté 1 dólar", "2026-10-28T10:00:00Z");
  expect(result.noteType).toBe("gasto");
  expect(result.currency).toBeUndefined();
});

test("classifyMessage returns a delete intent as-is, without capture/query fields", async () => {
  mockGroqChatToReturn({ intent: "delete" });
  const result = await classifyMessage("borrá esa", "2026-10-28T10:00:00Z");
  expect(result).toEqual({ intent: "delete" });
});

test("classifyMessage returns a delete intent for a request naming a previously captured note", async () => {
  mockGroqChatToReturn({ intent: "delete" });
  const result = await classifyMessage(
    "eliminá la idea de la app de libros",
    "2026-10-28T10:00:00Z"
  );
  expect(result.intent).toBe("delete");
});

test("classifyMessage's prompt tells the model 'delete' only applies to a previously captured note", async () => {
  mockGroqChatToReturn({ intent: "capture", noteType: "idea" });
  await classifyMessage("algo", "2026-10-28T10:00:00Z");
  const system: string = mockCreate.mock.calls[0]![0].messages[0].content;
  expect(system).toContain('"delete"');
  expect(system.toLowerCase()).toContain("borrar");
});

test("classifyMessage asks the model for a currency code", async () => {
  mockGroqChatToReturn({ intent: "capture", noteType: "idea" });
  await classifyMessage("algo", "2026-10-28T10:00:00Z");
  const system: string = mockCreate.mock.calls[0]![0].messages[0].content;
  expect(system).toContain('"currency"');
  expect(system).toContain("ARS");
});

test("classifyMessage passes through intent 'pago_cuota' when Groq returns it", async () => {
  mockGroqChatToReturn({ intent: "pago_cuota" });
  const result = await classifyMessage("pagué la tarjeta mastercard", "2026-10-28T10:00:00Z");
  expect(result).toEqual({ intent: "pago_cuota" });
});

test("classifyMessage classifies 'cobré el sueldo, cobré $1.000.000' as noteType 'ingreso' with isSalary true", async () => {
  mockGroqChatToReturn({
    intent: "capture",
    noteType: "ingreso",
    amountCents: 100000000,
    isSalary: true,
  });
  const result = await classifyMessage("cobré el sueldo, cobré $1.000.000", "2026-10-28T10:00:00Z");
  expect(result).toEqual({
    intent: "capture",
    noteType: "ingreso",
    amountCents: 100000000,
    isSalary: true,
  });
});

test("classifyMessage classifies 'recibí 5000 de un laburo extra' as noteType 'ingreso' with isSalary false", async () => {
  mockGroqChatToReturn({
    intent: "capture",
    noteType: "ingreso",
    amountCents: 500000,
    isSalary: false,
  });
  const result = await classifyMessage("recibí 5000 de un laburo extra", "2026-10-28T10:00:00Z");
  expect(result).toEqual({
    intent: "capture",
    noteType: "ingreso",
    amountCents: 500000,
    isSalary: false,
  });
});

// A hallucinated category (outside the fixed 6-value list)
// must never throw away the rest of the classification — noteType and
// amountCents must still come through, with category simply omitted (same
// .catch(undefined) pattern already used for currency).
test("classifyMessage omits a hallucinated category outside the fixed list, without losing the rest of the message", async () => {
  mockGroqChatToReturn({
    intent: "capture",
    noteType: "gasto",
    amountCents: 320000,
    category: "super",
  });
  const result = await classifyMessage("compré en el super, 3200 pesos", "2026-10-28T10:00:00Z");
  expect(result.noteType).toBe("gasto");
  expect(result.amountCents).toBe(320000);
  expect(result.category).toBeUndefined();
});

test("classifyMessage defaults isSalary to false when Groq omits it on an ingreso", async () => {
  mockGroqChatToReturn({ intent: "capture", noteType: "ingreso", amountCents: 500000 });
  const result = await classifyMessage("recibí 5000", "2026-10-28T10:00:00Z");
  expect(result).toEqual({
    intent: "capture",
    noteType: "ingreso",
    amountCents: 500000,
  });
  // classify.ts never forces a default here — persist.ts does.
  expect(result.isSalary).not.toBe(true);
});

test("classifyMessage: pregunta de factibilidad en cuotas sin interés", async () => {
  mockGroqChatToReturn({ intent: "factibilidad_compra" });
  const result = await classifyMessage(
    "me quiero comprar una barra de entrenamiento de $299.000 en 6 cuotas sin interés, ¿puedo sin dificultarme la economía?",
    "2026-10-28T10:00:00Z"
  );
  expect(result.intent).toBe("factibilidad_compra");
});

test("classifyMessage: pregunta de factibilidad financiada con entrega y tasa", async () => {
  mockGroqChatToReturn({ intent: "factibilidad_compra" });
  const result = await classifyMessage(
    "quiero una moto de $5.000.000, entrego $1.000.000, financio el resto a tasa 55%, ¿me conviene?",
    "2026-10-28T10:00:00Z"
  );
  expect(result.intent).toBe("factibilidad_compra");
});

test("classifyMessage: una consulta normal sigue siendo query, no factibilidad_compra", async () => {
  mockGroqChatToReturn({ intent: "query" });
  const result = await classifyMessage("¿cuánto gasté este mes en comida?", "2026-10-28T10:00:00Z");
  expect(result.intent).toBe("query");
});

test("classifyMessage: 'aparté 200000 este mes' es noteType ahorro, no ingreso", async () => {
  mockGroqChatToReturn({ intent: "capture", noteType: "ahorro", amountCents: 20_000_000 });
  const result = await classifyMessage("aparté 200000 este mes", "2026-10-28T10:00:00Z");
  expect(result.noteType).toBe("ahorro");
});

test("classifyMessage: una compra normal sigue siendo gasto, no se confunde con ahorro", async () => {
  mockGroqChatToReturn({ intent: "capture", noteType: "gasto", amountCents: 500_000, category: "Comida" });
  const result = await classifyMessage("compré comida por 5000", "2026-10-28T10:00:00Z");
  expect(result.noteType).toBe("gasto");
});

test("classifyMessage: un ingreso normal sigue siendo ingreso, no se confunde con ahorro", async () => {
  mockGroqChatToReturn({ intent: "capture", noteType: "ingreso", amountCents: 500_000, isSalary: false });
  const result = await classifyMessage("recibí 5000 de un laburo extra", "2026-10-28T10:00:00Z");
  expect(result.noteType).toBe("ingreso");
});

test("classifyMessage's prompt distinguishes 'ahorro' from both 'ingreso' and 'gasto'", async () => {
  mockGroqChatToReturn({ intent: "capture", noteType: "idea" });
  await classifyMessage("algo", "2026-10-28T10:00:00Z");
  const system: string = mockCreate.mock.calls[0]![0].messages[0].content;
  expect(system).toContain('"ahorro"');
});

// retiro_ahorro mirrors pago_cuota's optional
// amountCents pattern — present when the message mentions an explicit
// amount, absent (never defaulted to 0) when it doesn't.
test("classifyMessage: 'gasté mi ahorro en el TV, 400000' es intent retiro_ahorro", async () => {
  mockGroqChatToReturn({ intent: "retiro_ahorro", amountCents: 40_000_000 });
  const result = await classifyMessage("gasté mi ahorro en el TV, 400000", "2026-10-28T10:00:00Z");
  expect(result.intent).toBe("retiro_ahorro");
  expect(result.amountCents).toBe(40_000_000);
});

test("classifyMessage: 'gasté todo mi ahorro en el TV' es retiro_ahorro sin amountCents", async () => {
  mockGroqChatToReturn({ intent: "retiro_ahorro" });
  const result = await classifyMessage("gasté todo mi ahorro en el TV", "2026-10-28T10:00:00Z");
  expect(result.intent).toBe("retiro_ahorro");
  expect(result.amountCents).toBeUndefined();
});

// Proyeccion_ahorro — a question about how much the
// user could save/set aside next month, with no object to purchase (unlike
// factibilidad_compra).
test("classifyMessage: '¿cuánto puedo ahorrar el mes que viene?' es intent proyeccion_ahorro", async () => {
  mockGroqChatToReturn({ intent: "proyeccion_ahorro" });
  const result = await classifyMessage("¿cuánto puedo ahorrar el mes que viene?", "2026-10-28T10:00:00Z");
  expect(result.intent).toBe("proyeccion_ahorro");
});

test("classifyMessage: '¿cuánto me sobra para ahorrar?' también es intent proyeccion_ahorro", async () => {
  mockGroqChatToReturn({ intent: "proyeccion_ahorro" });
  const result = await classifyMessage("¿cuánto me sobra para ahorrar?", "2026-10-28T10:00:00Z");
  expect(result.intent).toBe("proyeccion_ahorro");
});

test("classifyMessage's prompt distinguishes 'proyeccion_ahorro' from 'factibilidad_compra'", async () => {
  mockGroqChatToReturn({ intent: "capture", noteType: "idea" });
  await classifyMessage("algo", "2026-10-28T10:00:00Z");
  const system: string = mockCreate.mock.calls[0]![0].messages[0].content;
  expect(system).toContain('"proyeccion_ahorro"');
});
