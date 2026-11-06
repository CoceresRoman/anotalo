import { randomUUID } from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";

// Only the Groq class itself is replaced, same pattern as query.test.ts.
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

import db from "../db";
import { CUOTA_EXPENSE_CATEGORY } from "../cuotas";
import {
  DEBT_AJUSTADA_MAX,
  DEBT_COMODA_MAX,
  MARGIN_AJUSTADA_MAX,
  MARGIN_COMODA_MAX,
  NO_HISTORY_MESSAGE,
  NO_HISTORY_SAVINGS_MESSAGE,
  aguinaldoBonusByMonth,
  aguinaldoBonusForMonth,
  averagePastIncomeAndExpense,
  committedCuotasByMonth,
  composeFeasibilityAnswer,
  composeSavingsProjectionAnswer,
  currentMonthRealBalance,
  evaluateContadoPurchase,
  evaluateCuotasPurchase,
  evaluateFeasibility,
  evaluateSavingsGoal,
  extractPurchaseParams,
  frenchInstallmentCents,
  projectMonthlySavingsCapacity,
} from "./purchaseFeasibility";

// Queues the next Groq chat-completion response as JSON — used for
// extractPurchaseParams (the first call).
function mockGroqChatToReturn(payload: unknown) {
  const content = typeof payload === "string" ? payload : JSON.stringify(payload);
  mockCreate.mockResolvedValueOnce({ choices: [{ message: { content } }] });
}

// Same mechanism as mockGroqChatToReturn, named separately so a test reads
// as "returns this free text" — used for composeFeasibilityAnswer (the
// second call), which returns free text, not JSON.
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
  category: string | null;
  occurredAt: string;
  currency?: string;
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
    data: {
      noteId: note.id,
      amountCents,
      category,
      occurredAt: new Date(occurredAt),
      ...(currency ? { currency } : {}),
    },
  });
}

async function seedIncome({
  amountCents,
  isSalary,
  occurredAt,
  currency,
}: {
  amountCents: number;
  isSalary: boolean;
  occurredAt: string;
  currency?: string;
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
    data: {
      noteId: note.id,
      amountCents,
      isSalary,
      occurredAt: new Date(occurredAt),
      ...(currency ? { currency } : {}),
    },
  });
}

beforeEach(async () => {
  await db.recurringPayment.deleteMany();
  await db.income.deleteMany();
  await db.expense.deleteMany();
  await db.saving.deleteMany();
  await db.note.deleteMany();
  await db.recurringItem.deleteMany();
  await db.recurringGroup.deleteMany();
  mockCreate.mockReset();
});

test("frenchInstallmentCents: TNA 48%, 12 cuotas, financia $1.200.000 — cuota fija del sistema francés", () => {
  const cuota = frenchInstallmentCents(120_000_00, 48, 12);
  // Verificar contra el cálculo manual: i = 0.48/12 = 0.04; cuota = capital * [i(1+i)^12] / [(1+i)^12 - 1]
  expect(cuota).toBeGreaterThan(0);
  expect(cuota * 12).toBeGreaterThan(120_000_00); // con interés, el total pagado siempre supera el capital
});

test("frenchInstallmentCents: tasa 0% no divide por cero — cuota = financedCents / N", () => {
  expect(frenchInstallmentCents(600_000_00, 0, 6)).toBe(Math.round(600_000_00 / 6));
});

test("evaluateCuotasPurchase: cuota <50% del margen todos los meses y deuda <30% del ingreso -> comoda", () => {
  const result = evaluateCuotasPurchase({
    financedCents: 30_000,
    installments: 3,
    cuotaCents: 10_000,
    purchaseYearMonth: "2026-01",
    avgIncomeCents: 100_000,
    avgExpenseCents: 50_000,
    existingCommittedByMonth: {},
  });

  expect(result.verdict).toBe("comoda");
  expect(result.worstMarginConsumptionRatio).toBeCloseTo(0.2);
  expect(result.worstDebtRatio).toBeCloseTo(0.1);
});

test("evaluateCuotasPurchase: cuota consume 60% del margen un mes -> ajustada aunque la deuda sea comoda", () => {
  const result = evaluateCuotasPurchase({
    financedCents: 60_000,
    installments: 2,
    cuotaCents: 30_000,
    purchaseYearMonth: "2026-01",
    avgIncomeCents: 120_000,
    avgExpenseCents: 70_000,
    existingCommittedByMonth: {},
  });

  // margen libre = 120_000 - 70_000 = 50_000; ratio = 30_000 / 50_000 = 0.6 (ajustada)
  expect(result.worstMarginConsumptionRatio).toBeCloseTo(0.6);
  // deuda = 30_000 / 120_000 = 0.25 (comoda)
  expect(result.worstDebtRatio).toBeCloseTo(0.25);
  expect(result.verdict).toBe("ajustada");
});

test("evaluateCuotasPurchase: marginAfterNewCents negativo en el último mes -> no_factible con el valor real (no clampeado)", () => {
  const result = evaluateCuotasPurchase({
    financedCents: 30_000,
    installments: 3,
    cuotaCents: 10_000,
    purchaseYearMonth: "2026-01",
    avgIncomeCents: 100_000,
    avgExpenseCents: 50_000,
    existingCommittedByMonth: { "2026-03": 45_000 },
  });

  expect(result.verdict).toBe("no_factible");
  const lastMonth = result.months.find((m) => m.yearMonth === "2026-03");
  expect(lastMonth).toBeDefined();
  expect(lastMonth!.marginAfterNewCents).toBe(-5_000);
});

test("evaluateCuotasPurchase: worstDebtRatio toma el peor mes del horizonte, no el primero ni un promedio", () => {
  const result = evaluateCuotasPurchase({
    financedCents: 30_000,
    installments: 3,
    cuotaCents: 10_000,
    purchaseYearMonth: "2026-01",
    avgIncomeCents: 200_000,
    avgExpenseCents: 50_000,
    existingCommittedByMonth: {
      "2026-01": 10_000,
      "2026-02": 20_000,
      "2026-03": 30_000,
    },
  });

  // mes 1: (10_000+10_000)/200_000 = 0.1; mes 2: 0.15; mes 3: 0.2
  expect(result.worstDebtRatio).toBeCloseTo(0.2);
});

test("evaluateCuotasPurchase: sin existingCommittedByMonth no tira excepción y existingCommittedCents es 0 en cada mes", () => {
  const result = evaluateCuotasPurchase({
    financedCents: 20_000,
    installments: 2,
    cuotaCents: 10_000,
    purchaseYearMonth: "2026-01",
    avgIncomeCents: 100_000,
    avgExpenseCents: 50_000,
    existingCommittedByMonth: {},
  });

  expect(result.months).toHaveLength(2);
  for (const month of result.months) {
    expect(month.existingCommittedCents).toBe(0);
  }
});

test("aguinaldoBonusForMonth: junio y diciembre dan la mitad del sueldo promedio, cualquier otro mes da 0", () => {
  expect(aguinaldoBonusForMonth("2026-06", 1_000_000_00)).toBe(500_000_00);
  expect(aguinaldoBonusForMonth("2026-12", 1_000_000_00)).toBe(500_000_00);
  expect(aguinaldoBonusForMonth("2026-07", 1_000_000_00)).toBe(0);
});

test("aguinaldoBonusForMonth: redondea Math.round(avgSalaryCents / 2) cuando el sueldo promedio es impar", () => {
  expect(aguinaldoBonusForMonth("2026-06", 1_000_000_01)).toBe(Math.round(1_000_000_01 / 2));
});

test("aguinaldoBonusByMonth: devuelve el bono solo para los meses del horizonte que son junio o diciembre", () => {
  const result = aguinaldoBonusByMonth(["2026-05", "2026-06", "2026-07", "2026-12", "2027-01"], 1_000_000_00);

  expect(result["2026-06"]).toBe(500_000_00);
  expect(result["2026-12"]).toBe(500_000_00);
  expect(result["2026-05"]).toBeUndefined();
  expect(result["2026-07"]).toBeUndefined();
  expect(result["2027-01"]).toBeUndefined();
});

test("evaluateCuotasPurchase: un mes con aguinaldo tiene mejor margen Y mejor ratio de endeudamiento que sin aguinaldo, los demás meses no cambian", () => {
  const baseInput = {
    financedCents: 300_000,
    installments: 3,
    cuotaCents: 100_000,
    purchaseYearMonth: "2026-05", // horizonte: mayo, junio, julio
    avgIncomeCents: 500_000,
    avgExpenseCents: 200_000,
    existingCommittedByMonth: { "2026-05": 50_000, "2026-06": 50_000, "2026-07": 50_000 },
  };

  const sinBono = evaluateCuotasPurchase(baseInput);
  const conBono = evaluateCuotasPurchase({
    ...baseInput,
    aguinaldoBonusByMonth: { "2026-06": 500_000 },
  });

  // mayo (sin aguinaldo): IDÉNTICO entre ambos — el bono nunca afecta un mes
  // sin aguinaldo.
  expect(conBono.months[0]).toEqual(sinBono.months[0]);
  expect(conBono.months[0].yearMonth).toBe("2026-05");

  // junio (con aguinaldo): mejor margen Y mejor (menor) ratio de
  // endeudamiento implícito que sin aguinaldo.
  const juneSinBono = sinBono.months[1];
  const juneConBono = conBono.months[1];
  expect(juneConBono.yearMonth).toBe("2026-06");
  expect(juneConBono.marginAfterNewCents).toBeGreaterThan(juneSinBono.marginAfterNewCents);

  const debtRatioSinBono = (juneSinBono.existingCommittedCents + juneSinBono.newCuotaCents) / baseInput.avgIncomeCents;
  const debtRatioConBono =
    (juneConBono.existingCommittedCents + juneConBono.newCuotaCents) / (baseInput.avgIncomeCents + 500_000);
  expect(debtRatioConBono).toBeLessThan(debtRatioSinBono);

  // julio (sin aguinaldo): también IDÉNTICO entre ambos.
  expect(conBono.months[2]).toEqual(sinBono.months[2]);
  expect(conBono.months[2].yearMonth).toBe("2026-07");
});

// Aísla específicamente la mitad "ratio de endeudamiento" de la regla —
// a diferencia del test de arriba, acá el único mes del horizonte es el mes
// bonificado, así que worstDebtRatio NO puede venir de ningún otro mes: si
// el aguinaldo dejara de aplicarse al denominador del ratio de
// endeudamiento (una regresión que solo tocara esa línea), este test
// fallaría aunque el de margen siguiera pasando. Los valores esperados se
// calculan acá con números literales, nunca reutilizando
// existingCommittedCents/newCuotaCents calculados por la función bajo
// prueba, para no terminar comparando la función contra sí misma.
test("evaluateCuotasPurchase: con un único mes de horizonte (el bonificado), el aguinaldo también mejora worstDebtRatio específicamente", () => {
  const input = {
    financedCents: 50_000,
    installments: 1,
    cuotaCents: 50_000,
    purchaseYearMonth: "2026-12",
    avgIncomeCents: 500_000,
    avgExpenseCents: 100_000,
    existingCommittedByMonth: { "2026-12": 50_000 },
  };

  const sinBono = evaluateCuotasPurchase(input);
  const conBono = evaluateCuotasPurchase({ ...input, aguinaldoBonusByMonth: { "2026-12": 500_000 } });

  // Único mes del horizonte: worstDebtRatio es necesariamente el de
  // diciembre, sin otro mes que pueda "ganar" el máximo y esconder una
  // regresión en esa línea específica.
  expect(sinBono.worstDebtRatio).toBeCloseTo((50_000 + 50_000) / 500_000); // 0.2
  expect(conBono.worstDebtRatio).toBeCloseTo((50_000 + 50_000) / (500_000 + 500_000)); // 0.1
  expect(conBono.worstDebtRatio).toBeLessThan(sinBono.worstDebtRatio);
});

// Caso más fuerte todavía: el aguinaldo hace que el VEREDICTO cambie
// (no_factible -> comoda) puramente porque el ratio de endeudamiento cruza
// DEBT_AJUSTADA_MAX/DEBT_COMODA_MAX, con worstMarginConsumptionRatio bien
// por debajo de sus propios umbrales en AMBOS casos (nunca es el factor
// decisivo) — si una regresión rompiera específicamente el uso del
// aguinaldo en el ratio de endeudamiento, el veredicto con bono seguiría
// siendo no_factible en vez de comoda, haciendo la regresión visible
// incluso sin mirar los ratios en crudo.
test("evaluateCuotasPurchase: el aguinaldo cambia el veredicto de no_factible a comoda solo por el ratio de endeudamiento, con el margen lejos de sus propios umbrales en ambos casos", () => {
  const input = {
    financedCents: 150_000,
    installments: 1,
    cuotaCents: 150_000,
    purchaseYearMonth: "2026-12",
    avgIncomeCents: 1_000_000,
    avgExpenseCents: 100_000,
    existingCommittedByMonth: { "2026-12": 300_000 },
  };

  const sinBono = evaluateCuotasPurchase(input);
  const conBono = evaluateCuotasPurchase({ ...input, aguinaldoBonusByMonth: { "2026-12": 1_000_000 } });

  // Sin bono: ratio de endeudamiento = (300_000+150_000)/1_000_000 = 0.45,
  // por encima de DEBT_AJUSTADA_MAX (0.4) -> no_factible, aunque el consumo
  // de margen (150_000/600_000 = 0.25) esté lejos de cualquier umbral.
  expect(sinBono.worstDebtRatio).toBeCloseTo(0.45);
  expect(sinBono.worstMarginConsumptionRatio).toBeLessThan(MARGIN_COMODA_MAX);
  expect(sinBono.verdict).toBe("no_factible");

  // Con bono: el mismo ratio cae a (300_000+150_000)/2_000_000 = 0.225, por
  // debajo de DEBT_COMODA_MAX (0.3) -> comoda. El consumo de margen mejora
  // también (150_000/1_600_000 ≈ 0.094) pero sigue lejos de cualquier
  // umbral en ambos casos — nunca es él quien decide el veredicto.
  expect(conBono.worstDebtRatio).toBeCloseTo(0.225);
  expect(conBono.worstMarginConsumptionRatio).toBeLessThan(MARGIN_COMODA_MAX);
  expect(conBono.verdict).toBe("comoda");
});

test("evaluateCuotasPurchase: llamado sin aguinaldoBonusByMonth es idéntico a llamarlo con un mapa sin entradas para el horizonte", () => {
  const input = {
    financedCents: 300_000,
    installments: 3,
    cuotaCents: 100_000,
    purchaseYearMonth: "2026-01", // horizonte: enero, febrero, marzo — no cruza junio ni diciembre
    avgIncomeCents: 500_000,
    avgExpenseCents: 200_000,
    existingCommittedByMonth: {},
  };

  const sinMapa = evaluateCuotasPurchase(input);
  const conMapaVacioParaEseHorizonte = evaluateCuotasPurchase({ ...input, aguinaldoBonusByMonth: {} });

  expect(conMapaVacioParaEseHorizonte).toEqual(sinMapa);
});

test("evaluateContadoPurchase: precio <50% del saldo real -> comoda", () => {
  const result = evaluateContadoPurchase({ priceCents: 100_000, realBalanceCents: 300_000 });
  expect(result.consumptionRatio).toBeCloseTo(100_000 / 300_000);
  expect(result.verdict).toBe("comoda");
});

test("evaluateContadoPurchase: precio entre 50% y 80% del saldo real -> ajustada", () => {
  const result = evaluateContadoPurchase({ priceCents: 200_000, realBalanceCents: 300_000 });
  expect(result.consumptionRatio).toBeCloseTo(200_000 / 300_000);
  expect(result.verdict).toBe("ajustada");
});

test("evaluateContadoPurchase: precio mayor al saldo real (remainder negativo) -> no_factible", () => {
  const result = evaluateContadoPurchase({ priceCents: 400_000, realBalanceCents: 300_000 });
  expect(result.remainderCents).toBe(-100_000);
  expect(result.verdict).toBe("no_factible");
});

test("evaluateContadoPurchase: saldo real <= 0 -> no_factible directo sin dividir por cero/negativo", () => {
  const zero = evaluateContadoPurchase({ priceCents: 50_000, realBalanceCents: 0 });
  expect(zero.verdict).toBe("no_factible");
  expect(Number.isNaN(zero.consumptionRatio)).toBe(false);

  const negative = evaluateContadoPurchase({ priceCents: 50_000, realBalanceCents: -20_000 });
  expect(negative.verdict).toBe("no_factible");
  expect(Number.isNaN(negative.consumptionRatio)).toBe(false);
});

test("evaluateSavingsGoal: acumula la capacidad mensual hasta alcanzar lo que falta", () => {
  const result = evaluateSavingsGoal({
    priceCents: 1_000_000,
    alreadySavedCents: 200_000,
    purchaseYearMonth: "2026-01",
    avgIncomeCents: 300_000,
    avgExpenseCents: 100_000, // capacidad constante: 200_000/mes
    existingCommittedByMonth: {},
    maxMonths: 24,
  });

  // falta 800_000; a 200_000/mes: 4 meses exactos.
  expect(result.remainingToSaveCents).toBe(800_000);
  expect(result.monthsNeeded).toBe(4);
  expect(result.verdict).toBe("viable");
});

test("evaluateSavingsGoal: un mes con margen negativo contribuye 0, nunca resta del acumulado", () => {
  const result = evaluateSavingsGoal({
    priceCents: 300_000,
    alreadySavedCents: 0,
    purchaseYearMonth: "2026-01",
    avgIncomeCents: 200_000,
    avgExpenseCents: 50_000, // margen base: 150_000/mes
    // Febrero tiene cuotas comprometidas mayores al margen -> capacidad
    // clampeada a 0 ese mes, nunca negativa.
    existingCommittedByMonth: { "2026-02": 500_000 },
    maxMonths: 24,
  });

  // enero: 150_000 (acumulado 150_000); febrero: 0 (acumulado SIGUE en
  // 150_000, no retrocede); marzo: 150_000 (acumulado 300_000, alcanza).
  expect(result.monthsNeeded).toBe(3);
  expect(result.verdict).toBe("viable");
});

test("evaluateSavingsGoal: lo ya ahorrado cubre el precio entero -> monthsNeeded 0", () => {
  const result = evaluateSavingsGoal({
    priceCents: 500_000,
    alreadySavedCents: 600_000,
    purchaseYearMonth: "2026-01",
    avgIncomeCents: 100_000,
    avgExpenseCents: 50_000,
    existingCommittedByMonth: {},
    maxMonths: 24,
  });

  expect(result.remainingToSaveCents).toBe(0);
  expect(result.monthsNeeded).toBe(0);
  expect(result.verdict).toBe("viable");
});

test("evaluateSavingsGoal: si no alcanza dentro de maxMonths, verdict no_viable y monthsNeeded null", () => {
  const result = evaluateSavingsGoal({
    priceCents: 10_000_000,
    alreadySavedCents: 0,
    purchaseYearMonth: "2026-01",
    avgIncomeCents: 150_000,
    avgExpenseCents: 100_000, // capacidad 50_000/mes * 6 meses = 300_000, muy por debajo del precio.
    existingCommittedByMonth: {},
    maxMonths: 6,
  });

  expect(result.monthsNeeded).toBeNull();
  expect(result.verdict).toBe("no_viable");
});

test("evaluateSavingsGoal: un mes con aguinaldo acelera el resultado (menos meses que sin aguinaldo)", () => {
  const base = {
    priceCents: 1_000_000,
    alreadySavedCents: 0,
    purchaseYearMonth: "2026-05", // horizonte: mayo, junio, julio, ...
    avgIncomeCents: 200_000,
    avgExpenseCents: 100_000, // capacidad base: 100_000/mes
    existingCommittedByMonth: {},
    maxMonths: 24,
  };

  const sinAguinaldo = evaluateSavingsGoal(base);
  const conAguinaldo = evaluateSavingsGoal({
    ...base,
    aguinaldoBonusByMonth: { "2026-06": 500_000 }, // junio, segundo mes del horizonte
  });

  expect(sinAguinaldo.monthsNeeded).not.toBeNull();
  expect(conAguinaldo.monthsNeeded).not.toBeNull();
  expect(conAguinaldo.monthsNeeded!).toBeLessThan(sinAguinaldo.monthsNeeded!);
});

test("exported thresholds tienen los valores exactos del brief", () => {
  expect(MARGIN_COMODA_MAX).toBe(0.5);
  expect(MARGIN_AJUSTADA_MAX).toBe(0.8);
  expect(DEBT_COMODA_MAX).toBe(0.3);
  expect(DEBT_AJUSTADA_MAX).toBe(0.4);
});

const NOW_ISO = "2026-11-03T12:00:00-03:00"; // mes en curso: 2026-11

test("averagePastIncomeAndExpense: promedia los 3 meses cerrados anteriores, excluyendo la cuota del gasto y cualquier ingreso que no sea sueldo", async () => {
  // Probe anterior a agosto: establece que la app ya trackeaba ANTES de que
  // arrancara agosto, así que los 3 meses (ago/sep/oct) quedan cubiertos
  // por completo — sin esto, agosto sería el primer mes parcial de uso y
  // quedaría excluido (ver el chequeo de cobertura).
  await seedExpense({ amountCents: 1, category: "Otros", occurredAt: "2026-07-15T12:00:00-03:00" });
  // 2026-08
  await seedIncome({ amountCents: 100_000, isSalary: true, occurredAt: "2026-08-10T12:00:00-03:00" });
  // No sueldo (isSalary: false): nunca entra en avgIncomeCents — es un
  // ingreso puntual, no se proyecta como recurrente.
  await seedIncome({ amountCents: 50_000, isSalary: false, occurredAt: "2026-08-15T12:00:00-03:00" });
  await seedExpense({ amountCents: 60_000, category: "Comida", occurredAt: "2026-08-20T12:00:00-03:00" });
  await seedExpense({ amountCents: 20_000, category: CUOTA_EXPENSE_CATEGORY, occurredAt: "2026-08-20T12:00:00-03:00" });
  // 2026-09
  await seedIncome({ amountCents: 200_000, isSalary: true, occurredAt: "2026-09-10T12:00:00-03:00" });
  await seedExpense({ amountCents: 70_000, category: "Otros", occurredAt: "2026-09-20T12:00:00-03:00" });
  await seedExpense({ amountCents: 30_000, category: CUOTA_EXPENSE_CATEGORY, occurredAt: "2026-09-20T12:00:00-03:00" });
  // 2026-10
  await seedIncome({ amountCents: 300_000, isSalary: true, occurredAt: "2026-10-10T12:00:00-03:00" });
  await seedExpense({ amountCents: 80_000, category: "Otros", occurredAt: "2026-10-20T12:00:00-03:00" });
  await seedExpense({ amountCents: 40_000, category: CUOTA_EXPENSE_CATEGORY, occurredAt: "2026-10-20T12:00:00-03:00" });
  // 2026-11 (mes en curso) -- NO debe entrar en el promedio aunque sea el más reciente
  await seedIncome({ amountCents: 999_999_99, isSalary: true, occurredAt: "2026-11-01T12:00:00-03:00" });
  await seedExpense({ amountCents: 999_999_99, category: "Otros", occurredAt: "2026-11-01T12:00:00-03:00" });

  const result = await averagePastIncomeAndExpense(NOW_ISO);

  expect(result.monthsUsed).toBe(3);
  expect(result.avgIncomeCents).toBe(Math.round((100_000 + 200_000 + 300_000) / 3));
  expect(result.avgSalaryCents).toBe(Math.round((100_000 + 200_000 + 300_000) / 3));
  expect(result.avgExpenseCents).toBe(Math.round((60_000 + 70_000 + 80_000) / 3));
});

test("averagePastIncomeAndExpense: un mes con datos pero sin ningún movimiento ANTES de que arrancara queda excluido por ser el primer mes parcial de uso (Bug real del usuario)", async () => {
  // Caso real que reportó el usuario: la función de finanzas recién arrancó a
  // mitad de octubre, así que octubre es el primer mes de uso y nunca tuvo
  // un mes calendario completo — promediarlo como si lo fuera infla el
  // "promedio" con 2-3 días de gasto, no 30. La respuesta honesta es "no
  // hay historial todavía" (monthsUsed 0), no una estimación con esos
  // pocos días.
  await seedExpense({ amountCents: 41_880, category: "Otros", occurredAt: "2026-10-30T12:00:00-03:00" });
  await seedIncome({ amountCents: 300_000, isSalary: true, occurredAt: "2026-10-30T12:00:00-03:00" });

  const result = await averagePastIncomeAndExpense(NOW_ISO);

  expect(result).toEqual({ avgIncomeCents: 0, avgExpenseCents: 0, avgSalaryCents: 0, monthsUsed: 0 });
});

test("averagePastIncomeAndExpense: con un mes cerrado y cubierto por completo, monthsUsed es 1 y el promedio es el de ese único mes", async () => {
  // Probe anterior a octubre: establece cobertura completa para octubre sin
  // que el probe mismo (fuera de la ventana de 3 meses) afecte el promedio.
  await seedExpense({ amountCents: 1, category: "Otros", occurredAt: "2026-09-15T12:00:00-03:00" });
  await seedIncome({ amountCents: 300_000, isSalary: true, occurredAt: "2026-10-10T12:00:00-03:00" });
  await seedExpense({ amountCents: 80_000, category: "Otros", occurredAt: "2026-10-20T12:00:00-03:00" });

  const result = await averagePastIncomeAndExpense(NOW_ISO);

  expect(result.monthsUsed).toBe(1);
  expect(result.avgIncomeCents).toBe(300_000);
  expect(result.avgExpenseCents).toBe(80_000);
});

test("averagePastIncomeAndExpense: sueldo $0 en un mes cerrado y cubierto usa el sueldo ya cargado del mes en curso como respaldo", async () => {
  // Un mes CERRADO y cubierto (septiembre, cubierto por el probe de
  // agosto) tuvo gasto real pero ningún sueldo cargado ese mes puntual —
  // distinto del caso del usuario (que no tenía NINGÚN mes cerrado todavía):
  // acá sí hay un mes cerrado completo, solo que sin sueldo ese mes.
  await seedExpense({ amountCents: 1, category: "Otros", occurredAt: "2026-08-15T12:00:00-03:00" });
  await seedExpense({ amountCents: 41_880, category: "Otros", occurredAt: "2026-09-15T12:00:00-03:00" });
  await seedIncome({ amountCents: 850_000, isSalary: true, occurredAt: "2026-11-01T12:00:00-03:00" });
  // Ingreso no-sueldo del mes en curso: nunca debe usarse como respaldo.
  await seedIncome({ amountCents: 999_999, isSalary: false, occurredAt: "2026-11-01T12:00:00-03:00" });

  const result = await averagePastIncomeAndExpense(NOW_ISO);

  expect(result.monthsUsed).toBe(1);
  expect(result.avgExpenseCents).toBe(41_880);
  expect(result.avgIncomeCents).toBe(850_000);
  expect(result.avgSalaryCents).toBe(850_000);
});

test("averagePastIncomeAndExpense: sin sueldo cargado ni en meses cerrados ni en el mes en curso, el sueldo promedio sigue en $0", async () => {
  await seedExpense({ amountCents: 1, category: "Otros", occurredAt: "2026-08-15T12:00:00-03:00" });
  await seedExpense({ amountCents: 41_880, category: "Otros", occurredAt: "2026-09-15T12:00:00-03:00" });

  const result = await averagePastIncomeAndExpense(NOW_ISO);

  expect(result.monthsUsed).toBe(1);
  expect(result.avgExpenseCents).toBe(41_880);
  expect(result.avgIncomeCents).toBe(0);
});

test("averagePastIncomeAndExpense: sin datos en ningún mes cerrado devuelve ceros sin dividir por cero", async () => {
  const result = await averagePastIncomeAndExpense(NOW_ISO);

  expect(result).toEqual({ avgIncomeCents: 0, avgExpenseCents: 0, avgSalaryCents: 0, monthsUsed: 0 });
});

test("averagePastIncomeAndExpense: avgIncomeCents/avgSalaryCents nunca incluyen un ingreso que no sea sueldo", async () => {
  await seedExpense({ amountCents: 1, category: "Otros", occurredAt: "2026-08-15T12:00:00-03:00" });
  // 2026-09: sueldo 200_000 + otro ingreso (no sueldo) 50_000.
  await seedIncome({ amountCents: 200_000, isSalary: true, occurredAt: "2026-09-10T12:00:00-03:00" });
  await seedIncome({ amountCents: 50_000, isSalary: false, occurredAt: "2026-09-15T12:00:00-03:00" });
  await seedExpense({ amountCents: 70_000, category: "Otros", occurredAt: "2026-09-20T12:00:00-03:00" });
  // 2026-10: sueldo 300_000, sin otro ingreso.
  await seedIncome({ amountCents: 300_000, isSalary: true, occurredAt: "2026-10-10T12:00:00-03:00" });
  await seedExpense({ amountCents: 80_000, category: "Otros", occurredAt: "2026-10-20T12:00:00-03:00" });

  const result = await averagePastIncomeAndExpense(NOW_ISO);

  expect(result.monthsUsed).toBe(2);
  // El ingreso "otro" (no sueldo) de 2026-09 nunca entra: ni en
  // avgSalaryCents ni en avgIncomeCents, que ahora son la misma cifra —
  // un ingreso puntual no se proyecta como recurrente (ver decisión en el
  // doc comment de averagePastIncomeAndExpense).
  expect(result.avgSalaryCents).toBe(Math.round((200_000 + 300_000) / 2));
  expect(result.avgIncomeCents).toBe(Math.round((200_000 + 300_000) / 2));
});

test("committedCuotasByMonth: suma solo los items activos (isActiveInMonth) para cada mes pedido", async () => {
  // Indefinida (sin totalInstallments): activa en todos los meses pedidos.
  await db.recurringItem.create({
    data: { name: "Netflix", amountCents: 5_000, startInstallment: 1, startYearMonth: "2026-01", totalInstallments: null },
  });
  // Termina a mitad del horizonte: activa en 2026-11 y 2026-12, inactiva en 2027-01.
  await db.recurringItem.create({
    data: { name: "PS5", amountCents: 20_000, startInstallment: 11, startYearMonth: "2026-11", totalInstallments: 12 },
  });
  // Todavía no empieza en 2026-11 (arranca en 2026-12): inactiva en 2026-11.
  await db.recurringItem.create({
    data: { name: "Compra futura", amountCents: 15_000, startInstallment: 1, startYearMonth: "2026-12", totalInstallments: 6 },
  });

  const result = await committedCuotasByMonth(["2026-11", "2026-12", "2027-01"]);

  expect(result["2026-11"]).toBe(5_000 + 20_000); // Netflix + PS5 (cuota 11); Compra futura no empezó.
  expect(result["2026-12"]).toBe(5_000 + 20_000 + 15_000); // PS5 cuota 12 (<=12, última); Compra futura cuota 1.
  expect(result["2027-01"]).toBe(5_000 + 15_000); // PS5 ya terminó (cuota 13 > 12); Compra futura cuota 2.
});

test("currentMonthRealBalance: es exactamente ingresos - gastos del mes en curso, SIN excluir la categoría de cuotas", async () => {
  await seedIncome({ amountCents: 300_000, isSalary: true, occurredAt: "2026-11-02T12:00:00-03:00" });
  await seedIncome({ amountCents: 50_000, isSalary: false, occurredAt: "2026-11-03T12:00:00-03:00" });
  await seedExpense({ amountCents: 80_000, category: "Otros", occurredAt: "2026-11-01T12:00:00-03:00" });
  // A diferencia de averagePastIncomeAndExpense, esta SÍ debe restar la cuota.
  await seedExpense({ amountCents: 20_000, category: CUOTA_EXPENSE_CATEGORY, occurredAt: "2026-11-01T12:00:00-03:00" });
  // Fuera del mes en curso: no debe contar.
  await seedExpense({ amountCents: 999_999_99, category: "Otros", occurredAt: "2026-10-15T12:00:00-03:00" });

  const result = await currentMonthRealBalance(NOW_ISO);

  expect(result).toBe(300_000 + 50_000 - 80_000 - 20_000);
});

test("extractPurchaseParams: barra en 6 cuotas sin interés", async () => {
  mockGroqChatToReturn({ priceCents: 29_900_000, mode: "cuotas", installments: 6, hasInterest: false });
  const result = await extractPurchaseParams("quiero comprarme una barra de $299.000 en 6 cuotas sin interés");
  expect(result).toEqual({ priceCents: 29_900_000, mode: "cuotas", installments: 6, hasInterest: false });
});

test("extractPurchaseParams: moto con entrega y TNA", async () => {
  mockGroqChatToReturn({
    priceCents: 500_000_000,
    mode: "cuotas",
    installments: 18,
    downPaymentCents: 100_000_000,
    hasInterest: true,
    tnaPercent: 55,
  });
  const result = await extractPurchaseParams(
    "quiero una moto de $5.000.000, entrego $1.000.000, el resto a tasa 55% TNA en 18 cuotas"
  );
  expect(result.downPaymentCents).toBe(100_000_000);
  expect(result.tnaPercent).toBe(55);
});

test("extractPurchaseParams: falla de Groq devuelve objeto vacío, nunca inventa un valor", async () => {
  mockGroqChatToThrow();
  const result = await extractPurchaseParams("cualquier cosa");
  expect(result).toEqual({});
});

test("extractPurchaseParams: respuesta con forma inválida devuelve objeto vacío", async () => {
  mockGroqChatToReturn({ priceCents: "no es un número" });
  const result = await extractPurchaseParams("cualquier cosa");
  expect(result).toEqual({});
});

test("extractPurchaseParams: JSON malformado devuelve objeto vacío, nunca lanza", async () => {
  mockGroqChatToReturn("esto no es json");
  const result = await extractPurchaseParams("cualquier cosa");
  expect(result).toEqual({});
});

async function seedOnePastMonthOfHistory() {
  // Probe anterior a octubre, fuera de la ventana de 3 meses (que es
  // ago/sep/oct para NOW_ISO 2026-11-03): establece que la app ya
  // trackeaba antes de que arrancara octubre, así que octubre queda
  // CUBIERTO POR COMPLETO (ver el chequeo de cobertura en
  // averagePastIncomeAndExpense) sin que el probe mismo entre al promedio.
  await seedExpense({ amountCents: 1, category: "Otros", occurredAt: "2026-09-15T12:00:00-03:00" });
  // 2026-10 es un mes calendario cerrado anterior a NOW_ISO (2026-11-03) —
  // un único mes con movimientos alcanza para monthsUsed > 0.
  await seedIncome({ amountCents: 300_000, isSalary: true, occurredAt: "2026-10-10T12:00:00-03:00" });
  await seedExpense({ amountCents: 80_000, category: "Otros", occurredAt: "2026-10-20T12:00:00-03:00" });
}

test("evaluateFeasibility: sin historial (monthsUsed 0) devuelve el literal no_history", async () => {
  const result = await evaluateFeasibility({ priceCents: 100_000, mode: "contado" }, NOW_ISO);
  expect(result).toBe("no_history");
});

test("evaluateFeasibility: mode cuotas con historial -> cuotas definido, contado ausente", async () => {
  await seedOnePastMonthOfHistory();

  const result = await evaluateFeasibility(
    { priceCents: 12_000_000, mode: "cuotas", installments: 12, hasInterest: false },
    NOW_ISO
  );

  expect(result).not.toBe("no_history");
  const feasibility = result as Exclude<typeof result, "no_history">;
  expect(feasibility.cuotas).toBeDefined();
  expect(feasibility.contado).toBeUndefined();
  expect(feasibility.cuotas!.cuotaCents).toBe(1_000_000);
});

test("evaluateFeasibility: mode contado con historial -> contado definido, cuotas ausente", async () => {
  await seedOnePastMonthOfHistory();
  await seedIncome({ amountCents: 500_000, isSalary: true, occurredAt: "2026-11-02T12:00:00-03:00" });

  const result = await evaluateFeasibility({ priceCents: 100_000, mode: "contado" }, NOW_ISO);

  expect(result).not.toBe("no_history");
  const feasibility = result as Exclude<typeof result, "no_history">;
  expect(feasibility.contado).toBeDefined();
  expect(feasibility.cuotas).toBeUndefined();
});

test("evaluateFeasibility: mode ambos -> cuotas y contado definidos", async () => {
  await seedOnePastMonthOfHistory();
  await seedIncome({ amountCents: 500_000, isSalary: true, occurredAt: "2026-11-02T12:00:00-03:00" });

  const result = await evaluateFeasibility(
    { priceCents: 12_000_000, mode: "ambos", installments: 12, hasInterest: false },
    NOW_ISO
  );

  expect(result).not.toBe("no_history");
  const feasibility = result as Exclude<typeof result, "no_history">;
  expect(feasibility.cuotas).toBeDefined();
  expect(feasibility.contado).toBeDefined();
});

test("evaluateFeasibility: hasInterest true con totalToPayCents -> cuotaCents = totalToPayCents/installments, sin aplicar frenchInstallmentCents", async () => {
  await seedOnePastMonthOfHistory();

  const result = await evaluateFeasibility(
    {
      priceCents: 100_000,
      mode: "cuotas",
      installments: 5,
      hasInterest: true,
      totalToPayCents: 125_000,
    },
    NOW_ISO
  );

  expect(result).not.toBe("no_history");
  const feasibility = result as Exclude<typeof result, "no_history">;
  // financedCents = 100_000 (sin entrega). Si esta rama usara
  // frenchInstallmentCents con alguna tasa implícita, el resultado no
  // sería este cociente exacto — es una división, no una amortización.
  expect(feasibility.cuotas!.cuotaCents).toBe(Math.round(125_000 / 5));
});

test("evaluateFeasibility: hasInterest true con tnaPercent -> usa frenchInstallmentCents", async () => {
  await seedOnePastMonthOfHistory();

  const result = await evaluateFeasibility(
    {
      priceCents: 120_000_00,
      mode: "cuotas",
      installments: 12,
      hasInterest: true,
      tnaPercent: 48,
    },
    NOW_ISO
  );

  expect(result).not.toBe("no_history");
  const feasibility = result as Exclude<typeof result, "no_history">;
  expect(feasibility.cuotas!.cuotaCents).toBe(frenchInstallmentCents(120_000_00, 48, 12));
});

test("evaluateFeasibility: hasInterest ausente/false -> financingCostCents es 0", async () => {
  await seedOnePastMonthOfHistory();

  const result = await evaluateFeasibility({ priceCents: 12_000_000, mode: "cuotas", installments: 12 }, NOW_ISO);

  expect(result).not.toBe("no_history");
  const feasibility = result as Exclude<typeof result, "no_history">;
  expect(feasibility.cuotas!.financingCostCents).toBe(0);
});

// El usuario dio una tasa, pero la extracción
// no marcó "hasInterest: true" explícitamente — igual tiene que tratarse
// como una compra con interés (no asumir 0% silenciosamente).
test("evaluateFeasibility: tnaPercent dado sin hasInterest explícito -> igual se trata como interés", async () => {
  await seedOnePastMonthOfHistory();

  const result = await evaluateFeasibility(
    { priceCents: 120_000_00, mode: "cuotas", installments: 12, tnaPercent: 48 },
    NOW_ISO
  );

  expect(result).not.toBe("no_history");
  const feasibility = result as Exclude<typeof result, "no_history">;
  expect(feasibility.cuotas!.cuotaCents).toBe(frenchInstallmentCents(120_000_00, 48, 12));
  expect(feasibility.cuotas!.financingCostCents).toBeGreaterThan(0);
});

// $299.000 en 7 cuotas sin interés no divide
// exacto (299.000/7 = 42.714,2857...) — Math.round introduce un residuo de
// unos pocos centavos en cuotaCents * installments - financedCents, que
// financingCostCents tiene que seguir siendo exactamente 0, nunca ese
// residuo.
test("evaluateFeasibility: $299.000 en 7 cuotas sin interés -> financingCostCents exactamente 0, no el residuo de redondeo", async () => {
  await seedOnePastMonthOfHistory();

  const result = await evaluateFeasibility({ priceCents: 299_000_00, mode: "cuotas", installments: 7 }, NOW_ISO);

  expect(result).not.toBe("no_history");
  const feasibility = result as Exclude<typeof result, "no_history">;
  // Confirma que el escenario realmente no divide exacto (si no, el test no
  // probaría nada): cuotaCents * installments !== financedCents.
  const financedCents = 299_000_00;
  const cuotaCents = feasibility.cuotas!.cuotaCents;
  expect(cuotaCents * 7).not.toBe(financedCents);
  expect(feasibility.cuotas!.financingCostCents).toBe(0);
  expect(feasibility.cuotas!.financingCostPercent).toBe(0);
});

// El saldo de "contado" tiene que restar las
// cuotas de este mes todavía NO pagadas, sin restar de nuevo una cuota ya
// pagada (que ya está dentro del gasto del mes).
test("evaluateFeasibility: mode contado resta solo la cuota de este mes todavía no pagada, no la ya pagada", async () => {
  await seedOnePastMonthOfHistory();

  const paidItem = await db.recurringItem.create({
    data: { name: "Gimnasio", amountCents: 20_000_00, startInstallment: 1, startYearMonth: "2026-11", totalInstallments: null },
  });
  await db.recurringItem.create({
    data: { name: "PS5", amountCents: 15_000_00, startInstallment: 1, startYearMonth: "2026-11", totalInstallments: 6 },
  });

  // La cuota de paidItem YA se pagó este mes: Note + Expense (categoría de
  // cuota) + RecurringPayment ligándolos.
  const paymentNote = await db.note.create({
    data: {
      rawText: "pago de gimnasio",
      source: "text",
      type: "gasto",
      whatsappMessageId: `test:${randomUUID()}`,
    },
  });
  await db.expense.create({
    data: {
      noteId: paymentNote.id,
      amountCents: 20_000_00,
      category: CUOTA_EXPENSE_CATEGORY,
      occurredAt: new Date("2026-11-05T12:00:00-03:00"),
    },
  });
  await db.recurringPayment.create({
    data: { itemId: paidItem.id, yearMonth: "2026-11", noteId: paymentNote.id },
  });

  // Ingreso y gasto habitual (no-cuota) de este mes, para armar el saldo
  // base antes de restar la cuota pendiente.
  await seedIncome({ amountCents: 300_000_00, isSalary: true, occurredAt: "2026-11-02T12:00:00-03:00" });
  await seedExpense({ amountCents: 50_000_00, category: "Otros", occurredAt: "2026-11-01T12:00:00-03:00" });

  const result = await evaluateFeasibility({ priceCents: 100_000_00, mode: "contado" }, NOW_ISO);

  expect(result).not.toBe("no_history");
  const feasibility = result as Exclude<typeof result, "no_history">;
  // currentMonthRealBalance = 300_000_00 (ingreso) - 50_000_00 (gasto
  // "Otros") - 20_000_00 (gasto de la cuota YA pagada) = 230_000_00.
  // unpaidCommittedCuotasForMonth = 15_000_00 (solo unpaidItem; paidItem ya
  // tiene payment este mes). Saldo final para contado: 230_000_00 -
  // 15_000_00 = 215_000_00 — la cuota pagada NO se resta dos veces.
  expect(feasibility.contado!.realBalanceCents).toBe(215_000_00);
});

test("evaluateFeasibility: modo cuotas con horizonte que cruza diciembre usa el aguinaldo sin que el llamador lo pida explícitamente", async () => {
  // Historial cerrado con sueldo, para tener un avgSalaryCents > 0 real.
  await seedIncome({ amountCents: 500_000_00, isSalary: true, occurredAt: "2026-08-10T12:00:00-03:00" });
  await seedExpense({ amountCents: 200_000_00, category: "Otros", occurredAt: "2026-08-20T12:00:00-03:00" });
  await seedIncome({ amountCents: 500_000_00, isSalary: true, occurredAt: "2026-09-10T12:00:00-03:00" });
  await seedExpense({ amountCents: 200_000_00, category: "Otros", occurredAt: "2026-09-20T12:00:00-03:00" });
  await seedIncome({ amountCents: 500_000_00, isSalary: true, occurredAt: "2026-10-10T12:00:00-03:00" });
  await seedExpense({ amountCents: 200_000_00, category: "Otros", occurredAt: "2026-10-20T12:00:00-03:00" });

  // NOW_ISO es 2026-11-03: una compra en 2 cuotas (noviembre, diciembre)
  // cruza diciembre.
  const result = await evaluateFeasibility(
    { priceCents: 100_000_00, mode: "cuotas", installments: 2, hasInterest: false },
    NOW_ISO
  );

  expect(result).not.toBe("no_history");
  const feasibility = result as Exclude<typeof result, "no_history">;
  const december = feasibility.cuotas!.months.find((m) => m.yearMonth === "2026-12");
  expect(december).toBeDefined();

  // Comparar contra el mismo caso pero con un NOW_ISO cuyo horizonte de 2
  // cuotas (enero-febrero) NO cruza diciembre — ningún mes de ese resultado
  // debe tener el aguinaldo aplicado, así que su margen en el mes
  // equivalente debe ser estrictamente peor (menor) que el de diciembre
  // arriba, pese a partir de los mismos ingresos/gastos históricos.
  const NOW_ISO_NO_DECEMBER = "2027-01-03T12:00:00-03:00"; // horizonte: 2027-01, 2027-02
  const resultSinDiciembre = await evaluateFeasibility(
    { priceCents: 100_000_00, mode: "cuotas", installments: 2, hasInterest: false },
    NOW_ISO_NO_DECEMBER
  );
  expect(resultSinDiciembre).not.toBe("no_history");
  const feasibilitySinDiciembre = resultSinDiciembre as Exclude<typeof resultSinDiciembre, "no_history">;
  const firstMonthSinDiciembre = feasibilitySinDiciembre.cuotas!.months[0];

  // Mismo avgIncomeCents/avgExpenseCents/cuotaCents en ambos casos (mismo
  // historial, mismo precio sin interés) — la única diferencia posible en
  // marginAfterNewCents es el aguinaldo de diciembre.
  expect(december!.marginAfterNewCents).toBeGreaterThan(firstMonthSinDiciembre.marginAfterNewCents);
});

test("composeFeasibilityAnswer: manda los números ya calculados en el system prompt y devuelve el texto tal cual", async () => {
  mockGroqChatToReturnOnNextCall("Te queda cómoda: la cuota es de $100.000 por mes.");

  const result = await composeFeasibilityAnswer("¿me conviene comprarla en cuotas?", {
    avgIncomeCents: 100_000_00,
    avgExpenseCents: 50_000_00,
    monthsUsed: 3,
    cuotas: {
      cuotaCents: 100_000_00,
      financedCents: 1_200_000_00,
      financingCostCents: 0,
      financingCostPercent: 0,
      months: [],
      worstDebtRatio: 0.1,
      worstMarginConsumptionRatio: 0.2,
      worstMarginAfterNewCents: 400_000_00,
      verdict: "comoda",
    },
  });

  expect(result).toBe("Te queda cómoda: la cuota es de $100.000 por mes.");
  const systemMessage = mockCreate.mock.calls[0]![0].messages.find((m: { role: string }) => m.role === "system");
  expect(systemMessage.content).toContain("100.000");
  expect(systemMessage.content).toContain("comoda");
});

test("composeFeasibilityAnswer: con cuotas y contado, el system prompt pide comparar las dos opciones", async () => {
  mockGroqChatToReturnOnNextCall("Te conviene más al contado.");

  await composeFeasibilityAnswer("¿me conviene en cuotas o al contado?", {
    avgIncomeCents: 100_000_00,
    avgExpenseCents: 50_000_00,
    monthsUsed: 3,
    cuotas: {
      cuotaCents: 100_000_00,
      financedCents: 1_200_000_00,
      financingCostCents: 50_000_00,
      financingCostPercent: 50_000_00 / 1_200_000_00,
      months: [],
      worstDebtRatio: 0.1,
      worstMarginConsumptionRatio: 0.2,
      worstMarginAfterNewCents: 400_000_00,
      verdict: "comoda",
    },
    contado: {
      realBalanceCents: 1_500_000_00,
      priceCents: 1_200_000_00,
      remainderCents: 300_000_00,
      consumptionRatio: 0.8,
      verdict: "ajustada",
    },
  });

  const systemMessage = mockCreate.mock.calls[0]![0].messages.find((m: { role: string }) => m.role === "system");
  expect(systemMessage.content.toLowerCase()).toContain("comparalas");
});

test("composeFeasibilityAnswer: lanza si Groq no devuelve contenido, nunca una respuesta vacía", async () => {
  mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: null } }] });

  await expect(
    composeFeasibilityAnswer("¿me conviene?", {
      avgIncomeCents: 100_000_00,
      avgExpenseCents: 50_000_00,
      monthsUsed: 3,
    })
  ).rejects.toThrow();
});

test("NO_HISTORY_MESSAGE es una respuesta honesta y no vacía", () => {
  expect(NO_HISTORY_MESSAGE.length).toBeGreaterThan(0);
});

// Fix round (task review): NO_HISTORY_SAVINGS_MESSAGE es el mensaje propio
// de proyeccion_ahorro — distinto de NO_HISTORY_MESSAGE y sin ninguna
// referencia a una compra (NO_HISTORY_MESSAGE habla de "evaluar esta
// compra", que confundiría a quien solo preguntó cuánto puede ahorrar).
test("NO_HISTORY_SAVINGS_MESSAGE es una respuesta honesta, no vacía, y no menciona una compra", () => {
  expect(NO_HISTORY_SAVINGS_MESSAGE.length).toBeGreaterThan(0);
  expect(NO_HISTORY_SAVINGS_MESSAGE).not.toBe(NO_HISTORY_MESSAGE);
  expect(NO_HISTORY_SAVINGS_MESSAGE.toLowerCase()).not.toContain("compra");
});

// Con monthsUsed 1 o 2 (poco historial, pero
// seguís usándolo — el algoritmo no cambia), el prompt tiene que
// instruirle a Groq que lo mencione, sin dejarlo como un veredicto que
// suena tan confiable como con 3 meses completos.
test("composeFeasibilityAnswer: con monthsUsed 1, el system prompt instruye mencionar poco historial", async () => {
  mockGroqChatToReturnOnNextCall("Con poco historial, te queda cómoda.");

  await composeFeasibilityAnswer("¿me conviene?", {
    avgIncomeCents: 100_000_00,
    avgExpenseCents: 50_000_00,
    monthsUsed: 1,
    contado: {
      realBalanceCents: 100_000_00,
      priceCents: 50_000_00,
      remainderCents: 50_000_00,
      consumptionRatio: 0.5,
      verdict: "comoda",
    },
  });

  const systemMessage = mockCreate.mock.calls[0]![0].messages.find((m: { role: string }) => m.role === "system");
  expect(systemMessage.content).toContain("poco historial");
});

test("composeFeasibilityAnswer: con monthsUsed 2, el system prompt también instruye mencionar poco historial", async () => {
  mockGroqChatToReturnOnNextCall("Con poco historial, te queda cómoda.");

  await composeFeasibilityAnswer("¿me conviene?", {
    avgIncomeCents: 100_000_00,
    avgExpenseCents: 50_000_00,
    monthsUsed: 2,
    contado: {
      realBalanceCents: 100_000_00,
      priceCents: 50_000_00,
      remainderCents: 50_000_00,
      consumptionRatio: 0.5,
      verdict: "comoda",
    },
  });

  const systemMessage = mockCreate.mock.calls[0]![0].messages.find((m: { role: string }) => m.role === "system");
  expect(systemMessage.content).toContain("poco historial");
});

test("composeFeasibilityAnswer: con monthsUsed 3 (historial completo), el system prompt NO menciona poco historial", async () => {
  mockGroqChatToReturnOnNextCall("Te queda cómoda.");

  await composeFeasibilityAnswer("¿me conviene?", {
    avgIncomeCents: 100_000_00,
    avgExpenseCents: 50_000_00,
    monthsUsed: 3,
    contado: {
      realBalanceCents: 100_000_00,
      priceCents: 50_000_00,
      remainderCents: 50_000_00,
      consumptionRatio: 0.5,
      verdict: "comoda",
    },
  });

  const systemMessage = mockCreate.mock.calls[0]![0].messages.find((m: { role: string }) => m.role === "system");
  expect(systemMessage.content).not.toContain("poco historial");
});

// ---------------------------------------------------------------------------
// ProjectMonthlySavingsCapacity / composeSavingsProjectionAnswer
// ---------------------------------------------------------------------------

test("projectMonthlySavingsCapacity: margen libre real del mes pedido, incluye el aguinaldo cuando targetYearMonth es diciembre", async () => {
  // Probe anterior a agosto para que los 3 meses queden cubiertos por completo.
  await seedExpense({ amountCents: 1, category: "Otros", occurredAt: "2026-07-15T12:00:00-03:00" });
  await seedIncome({ amountCents: 500_000_00, isSalary: true, occurredAt: "2026-08-10T12:00:00-03:00" });
  await seedExpense({ amountCents: 200_000_00, category: "Otros", occurredAt: "2026-08-20T12:00:00-03:00" });
  await seedIncome({ amountCents: 500_000_00, isSalary: true, occurredAt: "2026-09-10T12:00:00-03:00" });
  await seedExpense({ amountCents: 200_000_00, category: "Otros", occurredAt: "2026-09-20T12:00:00-03:00" });
  await seedIncome({ amountCents: 500_000_00, isSalary: true, occurredAt: "2026-10-10T12:00:00-03:00" });
  await seedExpense({ amountCents: 200_000_00, category: "Otros", occurredAt: "2026-10-20T12:00:00-03:00" });

  const result = await projectMonthlySavingsCapacity("2026-12", NOW_ISO);

  expect(result).not.toBe("no_history");
  const r = result as Exclude<typeof result, "no_history">;
  expect(r.monthsUsed).toBe(3);
  // avgIncome = avgSalary = 500_000_00, avgExpense = 200_000_00, aguinaldo (diciembre) = 250_000_00,
  // sin cuotas comprometidas.
  expect(r.capacityCents).toBe(500_000_00 + 250_000_00 - 200_000_00);

  // Mismo historial, pero un mes que NO es junio/diciembre: sin aguinaldo.
  const resultNoBonus = await projectMonthlySavingsCapacity("2026-07", NOW_ISO);
  expect(resultNoBonus).not.toBe("no_history");
  const rNoBonus = resultNoBonus as Exclude<typeof resultNoBonus, "no_history">;
  expect(rNoBonus.capacityCents).toBe(500_000_00 - 200_000_00);
  expect(r.capacityCents).toBeGreaterThan(rNoBonus.capacityCents);
});

test("projectMonthlySavingsCapacity: resta las cuotas comprometidas del mes pedido, sin recorte artificial", async () => {
  // Probe anterior a octubre para que quede cubierto por completo.
  await seedExpense({ amountCents: 1, category: "Otros", occurredAt: "2026-09-15T12:00:00-03:00" });
  await seedIncome({ amountCents: 300_000, isSalary: true, occurredAt: "2026-10-10T12:00:00-03:00" });
  await seedExpense({ amountCents: 80_000, category: "Otros", occurredAt: "2026-10-20T12:00:00-03:00" });
  await db.recurringItem.create({
    data: { name: "PS5", amountCents: 20_000, startInstallment: 1, startYearMonth: "2026-11", totalInstallments: 6 },
  });

  const result = await projectMonthlySavingsCapacity("2026-11", NOW_ISO);

  expect(result).not.toBe("no_history");
  const r = result as Exclude<typeof result, "no_history">;
  // margen libre honesto: ingreso promedio - gasto promedio - cuota comprometida — sin ningún
  // porcentaje "recomendado" aplicado por encima.
  expect(r.capacityCents).toBe(300_000 - 80_000 - 20_000);
});

test("projectMonthlySavingsCapacity: sin historial devuelve el literal 'no_history'", async () => {
  const result = await projectMonthlySavingsCapacity("2026-12", NOW_ISO);
  expect(result).toBe("no_history");
});

test("composeSavingsProjectionAnswer: manda capacityCents ya formateado y pide usar únicamente esa cifra", async () => {
  mockGroqChatToReturnOnNextCall("El mes que viene podrías ahorrar $150.000.");

  const result = await composeSavingsProjectionAnswer("¿cuánto puedo ahorrar el mes que viene?", "2026-12", {
    capacityCents: 150_000_00,
    monthsUsed: 3,
    aguinaldoBonusCents: 0,
  });

  expect(result).toBe("El mes que viene podrías ahorrar $150.000.");
  const systemMessage = mockCreate.mock.calls[0]![0].messages.find((m: { role: string }) => m.role === "system");
  expect(systemMessage.content).toContain("150.000");
  expect(systemMessage.content.toLowerCase()).toContain("únicamente esta cifra");
});

test("composeSavingsProjectionAnswer: lanza si Groq no devuelve contenido, nunca una respuesta vacía", async () => {
  mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: null } }] });

  await expect(
    composeSavingsProjectionAnswer("¿cuánto puedo ahorrar?", "2026-12", { capacityCents: 100_000_00, monthsUsed: 3, aguinaldoBonusCents: 0 })
  ).rejects.toThrow();
});

test("composeSavingsProjectionAnswer: con monthsUsed 1, el system prompt instruye mencionar poco historial", async () => {
  mockGroqChatToReturnOnNextCall("Con poco historial, podrías ahorrar $100.000.");

  await composeSavingsProjectionAnswer("¿cuánto puedo ahorrar?", "2026-12", {
    capacityCents: 100_000_00,
    monthsUsed: 1,
    aguinaldoBonusCents: 0,
  });

  const systemMessage = mockCreate.mock.calls[0]![0].messages.find((m: { role: string }) => m.role === "system");
  expect(systemMessage.content).toContain("poco historial");
});

// ---------------------------------------------------------------------------
// Modo "ahorrar" en evaluateFeasibility/composeFeasibilityAnswer
// ---------------------------------------------------------------------------

test("evaluateFeasibility: modo ahorrar resta el total acumulado de Saving del precio antes de proyectar", async () => {
  await seedOnePastMonthOfHistory();

  const savingNote = await db.note.create({
    data: {
      rawText: "ahorro de prueba",
      source: "text",
      type: "ahorro",
      whatsappMessageId: `test:${randomUUID()}`,
    },
  });
  await db.saving.create({
    data: { noteId: savingNote.id, amountCents: 400_000_00, occurredAt: new Date("2026-01-15T12:00:00-03:00") },
  });

  const result = await evaluateFeasibility({ priceCents: 819_999_00, mode: "ahorrar" }, NOW_ISO);

  expect(result).not.toBe("no_history");
  const feasibility = result as Exclude<typeof result, "no_history">;
  expect(feasibility.cuotas).toBeUndefined();
  expect(feasibility.contado).toBeUndefined();
  expect(feasibility.ahorro).toBeDefined();
  expect(feasibility.ahorro!.alreadySavedCents).toBe(400_000_00);
  expect(feasibility.ahorro!.remainingToSaveCents).toBe(819_999_00 - 400_000_00);
});

test("composeFeasibilityAnswer: con ahorro presente, el system prompt informa lo ya ahorrado y los meses que faltan, sin pedir mencionar un veredicto cómoda/ajustada", async () => {
  mockGroqChatToReturnOnNextCall("Te faltan 4 meses para juntarlo.");

  const result = await composeFeasibilityAnswer("quiero ahorrar para una bici", {
    avgIncomeCents: 100_000_00,
    avgExpenseCents: 50_000_00,
    monthsUsed: 3,
    ahorro: {
      alreadySavedCents: 200_000_00,
      remainingToSaveCents: 800_000_00,
      monthsNeeded: 4,
      verdict: "viable",
    },
  });

  expect(result).toBe("Te faltan 4 meses para juntarlo.");
  const systemMessage = mockCreate.mock.calls[0]![0].messages.find((m: { role: string }) => m.role === "system");
  expect(systemMessage.content).toContain("200.000");
  expect(systemMessage.content).toContain("800.000");
  expect(systemMessage.content).not.toContain("cómoda/ajustada/no factible");
});

test("composeSavingsProjectionAnswer: con monthsUsed 3 (historial completo), el system prompt NO menciona poco historial", async () => {
  mockGroqChatToReturnOnNextCall("Podrías ahorrar $100.000.");

  await composeSavingsProjectionAnswer("¿cuánto puedo ahorrar?", "2026-12", {
    capacityCents: 100_000_00,
    monthsUsed: 3,
    aguinaldoBonusCents: 0,
  });

  const systemMessage = mockCreate.mock.calls[0]![0].messages.find((m: { role: string }) => m.role === "system");
  expect(systemMessage.content).not.toContain("poco historial");
});

// ---------------------------------------------------------------------------
// Modo "recurrente" — gasto nuevo sin fecha de fin
// ---------------------------------------------------------------------------

test("extractPurchaseParams: 'clases de inglés 50000 por mes' extrae mode recurrente e isInvestment true", async () => {
  mockGroqChatToReturn({ priceCents: 5_000_000, mode: "recurrente", isInvestment: true });
  const result = await extractPurchaseParams("quiero tomar clases de inglés que me salen 50000 por mes, ¿puedo?");
  expect(result.mode).toBe("recurrente");
  expect(result.isInvestment).toBe(true);
});

test("evaluateFeasibility: modo recurrente evalúa 6 meses con el mismo semáforo que cuotas, financingCostCents siempre 0", async () => {
  await seedOnePastMonthOfHistory();

  // margen base = 300_000 (ingreso) - 80_000 (gasto) = 220_000; una cuota
  // mensual de 200_000 consume ~91% de ese margen (> MARGIN_AJUSTADA_MAX) en
  // TODOS los meses del horizonte -> no_factible, mismo criterio que usaría
  // "cuotas" para el mismo consumo de margen.
  const result = await evaluateFeasibility({ priceCents: 200_000, mode: "recurrente" }, NOW_ISO);

  expect(result).not.toBe("no_history");
  const feasibility = result as Exclude<typeof result, "no_history">;
  expect(feasibility.cuotas).toBeDefined();
  expect(feasibility.contado).toBeUndefined();
  expect(feasibility.ahorro).toBeUndefined();
  // Horizonte fijo de 6 meses, sin financiamiento: cuotaCents es el monto
  // mensual tal cual (priceCents reinterpretado), financedCents es 0.
  expect(feasibility.cuotas!.months).toHaveLength(6);
  expect(feasibility.cuotas!.cuotaCents).toBe(200_000);
  expect(feasibility.cuotas!.financedCents).toBe(0);
  // Nunca cuotaCents * 6 - 0: no hay nada financiado, así que el costo de
  // financiar no es significativo para este modo.
  expect(feasibility.cuotas!.financingCostCents).toBe(0);
  expect(feasibility.cuotas!.financingCostPercent).toBe(0);
  expect(feasibility.cuotas!.verdict).toBe("no_factible");
});

test("evaluateFeasibility: modo recurrente con cuota cómoda da verdict comoda, igual que cuotas lo haría con el mismo consumo de margen", async () => {
  await seedOnePastMonthOfHistory();

  // margen base = 220_000; una cuota de 20_000 consume ~9% del margen, muy
  // por debajo de MARGIN_COMODA_MAX.
  const result = await evaluateFeasibility({ priceCents: 20_000, mode: "recurrente" }, NOW_ISO);

  expect(result).not.toBe("no_history");
  const feasibility = result as Exclude<typeof result, "no_history">;
  expect(feasibility.cuotas!.verdict).toBe("comoda");
});

test("evaluateFeasibility: modo recurrente con isInvestment true lo propaga al resultado sin tocar verdict ni cifras", async () => {
  await seedOnePastMonthOfHistory();

  const withInvestment = await evaluateFeasibility(
    { priceCents: 20_000, mode: "recurrente", isInvestment: true },
    NOW_ISO
  );
  const withoutInvestment = await evaluateFeasibility({ priceCents: 20_000, mode: "recurrente" }, NOW_ISO);

  expect(withInvestment).not.toBe("no_history");
  expect(withoutInvestment).not.toBe("no_history");
  const feasibilityWith = withInvestment as Exclude<typeof withInvestment, "no_history">;
  const feasibilityWithout = withoutInvestment as Exclude<typeof withoutInvestment, "no_history">;

  expect(feasibilityWith.isInvestment).toBe(true);
  expect(feasibilityWithout.isInvestment).toBeUndefined();
  // Mismo veredicto y mismas cifras en ambos casos — isInvestment es puro tono.
  expect(feasibilityWith.cuotas).toEqual(feasibilityWithout.cuotas);
});

test("composeFeasibilityAnswer: con isInvestment true, el system prompt instruye mencionar que podría ser una inversión, sin pedir cambiar el veredicto", async () => {
  mockGroqChatToReturnOnNextCall("Te queda cómoda, y además es una inversión en vos.");

  await composeFeasibilityAnswer("quiero tomar clases de inglés, ¿puedo pagarlas?", {
    avgIncomeCents: 300_000_00,
    avgExpenseCents: 80_000_00,
    monthsUsed: 3,
    isInvestment: true,
    cuotas: {
      cuotaCents: 20_000_00,
      financedCents: 0,
      financingCostCents: 0,
      financingCostPercent: 0,
      months: [],
      worstDebtRatio: 0.05,
      worstMarginConsumptionRatio: 0.09,
      worstMarginAfterNewCents: 200_000_00,
      verdict: "comoda",
    },
  });

  const systemMessage = mockCreate.mock.calls[0]![0].messages.find((m: { role: string }) => m.role === "system");
  expect(systemMessage.content.toLowerCase()).toContain("inversión");
});

test("composeFeasibilityAnswer: sin isInvestment, el system prompt no menciona inversión", async () => {
  mockGroqChatToReturnOnNextCall("Te queda cómoda.");

  await composeFeasibilityAnswer("¿puedo pagar el gimnasio?", {
    avgIncomeCents: 300_000_00,
    avgExpenseCents: 80_000_00,
    monthsUsed: 3,
    cuotas: {
      cuotaCents: 20_000_00,
      financedCents: 0,
      financingCostCents: 0,
      financingCostPercent: 0,
      months: [],
      worstDebtRatio: 0.05,
      worstMarginConsumptionRatio: 0.09,
      worstMarginAfterNewCents: 200_000_00,
      verdict: "comoda",
    },
  });

  const systemMessage = mockCreate.mock.calls[0]![0].messages.find((m: { role: string }) => m.role === "system");
  expect(systemMessage.content.toLowerCase()).not.toContain("inversión");
});

// ---------------------------------------------------------------------------
// Revisión final de la rama Ahorros: moneda del total acumulado (I-1), total
// negativo en modo ahorrar (I-4), saldo real alineado con el dashboard
// (I-3), y aguinaldo presentado como estimación (I-2).
// ---------------------------------------------------------------------------

async function seedSaving({
  amountCents,
  occurredAt,
  currency,
}: {
  amountCents: number;
  occurredAt: string;
  currency?: string;
}) {
  const note = await db.note.create({
    data: {
      rawText: "ahorro de prueba",
      source: "text",
      type: "ahorro",
      whatsappMessageId: `test:${randomUUID()}`,
    },
  });
  return db.saving.create({
    data: {
      noteId: note.id,
      amountCents,
      occurredAt: new Date(occurredAt),
      ...(currency ? { currency } : {}),
    },
  });
}

test("currentMonthRealBalance: es la MISMA fórmula que saldoCents del dashboard (sueldo + otros ingresos - gastos - neto de ahorros del mes)", async () => {
  await seedIncome({ amountCents: 300_000, isSalary: true, occurredAt: "2026-11-02T12:00:00-03:00" });
  await seedIncome({ amountCents: 50_000, isSalary: false, occurredAt: "2026-11-03T12:00:00-03:00" });
  await seedExpense({ amountCents: 80_000, category: "Otros", occurredAt: "2026-11-01T12:00:00-03:00" });
  // Ahorros de este mes: un depósito y un retiro — resta el neto.
  await seedSaving({ amountCents: 40_000, occurredAt: "2026-11-02T12:00:00-03:00" });
  await seedSaving({ amountCents: -10_000, occurredAt: "2026-11-03T08:00:00-03:00" });
  // Fuera del mes en curso o en otra moneda: no cuentan (mismo where que ahorroMesAgg).
  await seedSaving({ amountCents: 999_999, occurredAt: "2026-10-15T12:00:00-03:00" });
  await seedSaving({ amountCents: 777_777, occurredAt: "2026-11-02T12:00:00-03:00", currency: "USD" });

  const result = await currentMonthRealBalance(NOW_ISO);

  const sueldoCents = 300_000;
  const otrosIngresosCents = 50_000;
  const monthExpenseCents = 80_000;
  const ahorroMesCents = 40_000 - 10_000;
  expect(result).toBe(sueldoCents + otrosIngresosCents - monthExpenseCents - ahorroMesCents);
});

test("evaluateFeasibility: modo contado no cuenta como disponible la plata apartada en Ahorros este mes", async () => {
  await seedOnePastMonthOfHistory();
  await seedIncome({ amountCents: 500_000, isSalary: true, occurredAt: "2026-11-02T12:00:00-03:00" });
  await seedSaving({ amountCents: 200_000, occurredAt: "2026-11-02T13:00:00-03:00" });

  const result = await evaluateFeasibility({ priceCents: 100_000, mode: "contado" }, NOW_ISO);

  const feasibility = result as Exclude<typeof result, "no_history">;
  expect(feasibility.contado!.realBalanceCents).toBe(500_000 - 200_000);
});

test("evaluateFeasibility: modo ahorrar solo cuenta como ya ahorrado lo de la moneda default", async () => {
  await seedOnePastMonthOfHistory();
  await seedSaving({ amountCents: 100_000, occurredAt: "2026-09-15T12:00:00-03:00" });
  await seedSaving({ amountCents: 999_999, occurredAt: "2026-09-16T12:00:00-03:00", currency: "USD" });

  const result = await evaluateFeasibility({ priceCents: 300_000, mode: "ahorrar" }, NOW_ISO);

  const feasibility = result as Exclude<typeof result, "no_history">;
  expect(feasibility.ahorro!.alreadySavedCents).toBe(100_000);
  expect(feasibility.ahorro!.remainingToSaveCents).toBe(300_000 - 100_000);
});

test("evaluateFeasibility: modo ahorrar con un total acumulado negativo lo trata como 0, nunca pide juntar más que el precio", async () => {
  await seedOnePastMonthOfHistory();
  // Ej.: se retiró un depósito que después se borró desde la web — el
  // ledger queda en -50.000.
  await seedSaving({ amountCents: -50_000, occurredAt: "2026-09-15T12:00:00-03:00" });

  const result = await evaluateFeasibility({ priceCents: 300_000, mode: "ahorrar" }, NOW_ISO);

  const feasibility = result as Exclude<typeof result, "no_history">;
  expect(feasibility.ahorro!.alreadySavedCents).toBe(0);
  expect(feasibility.ahorro!.remainingToSaveCents).toBe(300_000);
});

test("evaluateFeasibility: aguinaldoAppliedCents queda seteado cuando el horizonte de cuotas o recurrente cruza diciembre", async () => {
  // seedOnePastMonthOfHistory: sueldo promedio 300_000 -> aguinaldo de diciembre 150_000.
  await seedOnePastMonthOfHistory();

  const cuotas = await evaluateFeasibility(
    { priceCents: 100_000, mode: "cuotas", installments: 2, hasInterest: false },
    NOW_ISO
  ); // noviembre, diciembre
  const recurrente = await evaluateFeasibility({ priceCents: 20_000, mode: "recurrente" }, NOW_ISO); // nov-abr

  expect((cuotas as Exclude<typeof cuotas, "no_history">).aguinaldoAppliedCents).toBe(150_000);
  expect((recurrente as Exclude<typeof recurrente, "no_history">).aguinaldoAppliedCents).toBe(150_000);
});

test("evaluateFeasibility: aguinaldoAppliedCents ausente cuando ningún mes del horizonte tiene aguinaldo", async () => {
  await seedOnePastMonthOfHistory();

  const cuotas = await evaluateFeasibility(
    { priceCents: 100_000, mode: "cuotas", installments: 1, hasInterest: false },
    NOW_ISO
  ); // solo noviembre
  const contado = await evaluateFeasibility({ priceCents: 100_000, mode: "contado" }, NOW_ISO);

  expect((cuotas as Exclude<typeof cuotas, "no_history">).aguinaldoAppliedCents).toBeUndefined();
  expect((contado as Exclude<typeof contado, "no_history">).aguinaldoAppliedCents).toBeUndefined();
});

test("evaluateFeasibility: modo ahorrar marca aguinaldo solo si la meta llegó a recorrer diciembre", async () => {
  // Capacidad 220_000/mes, +150_000 en diciembre.
  await seedOnePastMonthOfHistory();

  const alcanzaEnNoviembre = await evaluateFeasibility({ priceCents: 100_000, mode: "ahorrar" }, NOW_ISO);
  const necesitaDiciembre = await evaluateFeasibility({ priceCents: 300_000, mode: "ahorrar" }, NOW_ISO);

  const a = alcanzaEnNoviembre as Exclude<typeof alcanzaEnNoviembre, "no_history">;
  const b = necesitaDiciembre as Exclude<typeof necesitaDiciembre, "no_history">;
  expect(a.ahorro!.monthsNeeded).toBe(1);
  expect(a.aguinaldoAppliedCents).toBeUndefined();
  expect(b.ahorro!.monthsNeeded).toBe(2);
  expect(b.aguinaldoAppliedCents).toBe(150_000);
});

const CUOTAS_COMODA = {
  cuotaCents: 20_000_00,
  financedCents: 40_000_00,
  financingCostCents: 0,
  financingCostPercent: 0,
  months: [],
  worstDebtRatio: 0.05,
  worstMarginConsumptionRatio: 0.09,
  worstMarginAfterNewCents: 200_000_00,
  verdict: "comoda" as const,
};

test("composeFeasibilityAnswer: con aguinaldoAppliedCents, el system prompt pide presentarlo como estimación", async () => {
  mockGroqChatToReturnOnNextCall("Te queda cómoda, contando una estimación de aguinaldo.");

  await composeFeasibilityAnswer("¿puedo comprarlo en 2 cuotas?", {
    avgIncomeCents: 300_000_00,
    avgExpenseCents: 80_000_00,
    monthsUsed: 3,
    cuotas: CUOTAS_COMODA,
    aguinaldoAppliedCents: 150_000_00,
  });

  const systemMessage = mockCreate.mock.calls[0]![0].messages.find((m: { role: string }) => m.role === "system");
  expect(systemMessage.content.toLowerCase()).toContain("estimación");
  expect(systemMessage.content).toContain("150.000");
});

test("composeFeasibilityAnswer: sin aguinaldoAppliedCents, el system prompt no habla de estimación", async () => {
  mockGroqChatToReturnOnNextCall("Te queda cómoda.");

  await composeFeasibilityAnswer("¿puedo comprarlo en 1 cuota?", {
    avgIncomeCents: 300_000_00,
    avgExpenseCents: 80_000_00,
    monthsUsed: 3,
    cuotas: CUOTAS_COMODA,
  });

  const systemMessage = mockCreate.mock.calls[0]![0].messages.find((m: { role: string }) => m.role === "system");
  expect(systemMessage.content.toLowerCase()).not.toContain("estimación");
});

test("projectMonthlySavingsCapacity: devuelve aguinaldoBonusCents (> 0 en diciembre, 0 en otro mes)", async () => {
  await seedOnePastMonthOfHistory();

  const december = await projectMonthlySavingsCapacity("2026-12", NOW_ISO);
  const july = await projectMonthlySavingsCapacity("2027-07", NOW_ISO);

  expect((december as Exclude<typeof december, "no_history">).aguinaldoBonusCents).toBe(150_000);
  expect((july as Exclude<typeof july, "no_history">).aguinaldoBonusCents).toBe(0);
});

test("composeSavingsProjectionAnswer: con aguinaldoBonusCents > 0 pide presentarlo como estimación; con 0 no", async () => {
  mockGroqChatToReturnOnNextCall("En diciembre podrías ahorrar $370.000, contando una estimación de aguinaldo.");
  mockGroqChatToReturnOnNextCall("En julio podrías ahorrar $220.000.");

  await composeSavingsProjectionAnswer("¿cuánto puedo ahorrar?", "2026-12", {
    capacityCents: 370_000_00,
    monthsUsed: 3,
    aguinaldoBonusCents: 150_000_00,
  });
  await composeSavingsProjectionAnswer("¿cuánto puedo ahorrar?", "2027-07", {
    capacityCents: 220_000_00,
    monthsUsed: 3,
    aguinaldoBonusCents: 0,
  });

  const withBonus = mockCreate.mock.calls[0]![0].messages.find((m: { role: string }) => m.role === "system");
  const withoutBonus = mockCreate.mock.calls[1]![0].messages.find((m: { role: string }) => m.role === "system");
  expect(withBonus.content.toLowerCase()).toContain("estimación");
  expect(withBonus.content).toContain("150.000");
  expect(withoutBonus.content.toLowerCase()).not.toContain("estimación");
});
