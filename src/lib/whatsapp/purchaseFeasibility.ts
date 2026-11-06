// Matemática pura de factibilidad de compra (sin acceso a DB ni a red):
// amortización francesa, evaluación de una compra financiada en cuotas, y
// evaluación de una compra pagada en contado — más los agregados
// de ingreso/gasto/cuotas desde la DB que alimentan esa matemática pura.
// Este mismo archivo se extiende con las llamadas a Groq para extraer
// los parámetros de la compra desde el mensaje del usuario — ese código
// NUNCA debe calcular esta aritmética, solo invocarla.
import Groq from "groq-sdk";
import { z } from "zod";
import { addMonthsToYearMonth, CUOTA_EXPENSE_CATEGORY, isActiveInMonth } from "../cuotas";
import { config } from "../config";
import db from "../db";
import { formatCents } from "../money";
import { argentinaDateParts, argentinaMonthRange, toArgentinaDateString } from "../timezone";

export type ExtractedPurchaseParams = {
  priceCents?: number;
  mode?: "cuotas" | "contado" | "ambos" | "ahorrar" | "recurrente";
  installments?: number;
  downPaymentCents?: number;
  hasInterest?: boolean;
  tnaPercent?: number;
  totalToPayCents?: number;
  // true si el mensaje suena educativo (clase, curso, capacitación) — solo
  // afecta el TONO de la respuesta final (composeFeasibilityAnswer), nunca
  // el veredicto ni ningún número calculado.
  isInvestment?: boolean;
};

export type MonthProjection = {
  yearMonth: string;
  existingCommittedCents: number;
  newCuotaCents: number;
  marginBeforeNewCents: number;
  marginAfterNewCents: number;
};

export type CuotasEvaluation = {
  cuotaCents: number;
  financedCents: number;
  financingCostCents: number;
  // Costo de financiar como % del capital financiado (financingCostCents /
  // financedCents) — se calcula acá en TS,
  // nunca en la redacción de Groq, para que el segundo llamado pueda
  // mencionar un porcentaje sin tener que estimarlo él mismo.
  financingCostPercent: number;
  months: MonthProjection[];
  worstDebtRatio: number;
  worstMarginConsumptionRatio: number;
  // El margen (en $) del peor mes del horizonte — el mínimo de
  // marginAfterNewCents entre todos los meses proyectados. Mismo criterio
  // "manda el peor caso" que ya usan worstDebtRatio/worstMarginConsumptionRatio;
  // se expone aparte para que composeFeasibilityAnswer pueda citarlo sin
  // tener que recorrer `months` ni calcular un mínimo por su cuenta.
  worstMarginAfterNewCents: number;
  verdict: "comoda" | "ajustada" | "no_factible";
};

export type ContadoEvaluation = {
  realBalanceCents: number;
  priceCents: number;
  remainderCents: number;
  consumptionRatio: number;
  verdict: "comoda" | "ajustada" | "no_factible";
};

export const MARGIN_COMODA_MAX = 0.5;
export const MARGIN_AJUSTADA_MAX = 0.8;
export const DEBT_COMODA_MAX = 0.3;
export const DEBT_AJUSTADA_MAX = 0.4;

/**
 * Cuota fija del sistema francés para financiar `financedCents` en
 * `installments` cuotas a una TNA de `tnaPercent` (ej. 48 = 48%/año).
 * Con tasa 0% no hay nada que amortizar con interés: cuota = capital / N,
 * evitando la división por cero de la fórmula general ((1+i)^n - 1 con i=0).
 */
export function frenchInstallmentCents(financedCents: number, tnaPercent: number, installments: number): number {
  if (tnaPercent === 0) return Math.round(financedCents / installments);
  const monthlyRate = tnaPercent / 100 / 12;
  const factor = Math.pow(1 + monthlyRate, installments);
  return Math.round((financedCents * monthlyRate * factor) / (factor - 1));
}

/**
 * Proyecta mes a mes, desde `purchaseYearMonth`, el impacto de una cuota
 * nueva sobre el margen libre (ingreso - gasto - compromisos existentes) y
 * sobre la deuda total respecto del ingreso. El veredicto toma siempre el
 * PEOR mes del horizonte para cada ratio, nunca el mes de la compra ni un
 * promedio.
 */
export function evaluateCuotasPurchase(input: {
  financedCents: number;
  installments: number;
  cuotaCents: number;
  purchaseYearMonth: string;
  avgIncomeCents: number;
  avgExpenseCents: number;
  existingCommittedByMonth: Record<string, number>;
  // Opcional — bono de aguinaldo estimado por mes ("YYYY-MM" -> centavos),
  // ver aguinaldoBonusByMonth más abajo. Sin este campo (undefined), el
  // comportamiento es IDÉNTICO al que tenía esta función antes de que
  // existiera: backward compatible con todo caller existente.
  aguinaldoBonusByMonth?: Record<string, number>;
}): CuotasEvaluation {
  const {
    financedCents,
    installments,
    cuotaCents,
    purchaseYearMonth,
    avgIncomeCents,
    avgExpenseCents,
    existingCommittedByMonth,
    aguinaldoBonusByMonth,
  } = input;

  const months: MonthProjection[] = [];
  let worstMarginConsumptionRatio = -Infinity;
  let worstDebtRatio = -Infinity;
  let worstMarginAfterNewCents = Infinity;
  let hasNegativeMargin = false;

  for (let i = 0; i < installments; i++) {
    const yearMonth = addMonthsToYearMonth(purchaseYearMonth, i);
    const existingCommittedCents = existingCommittedByMonth[yearMonth] ?? 0;
    // El aguinaldo de ESE mes (0 si el mes no tiene bono o no se pasó el
    // mapa) se suma al ingreso ANTES de calcular tanto el margen como el
    // ratio de endeudamiento de ese mes — nunca solo uno de los dos (ver
    // El aguinaldo nunca puede empeorar un
    // resultado, solo mejorarlo).
    const incomeThisMonth = avgIncomeCents + (aguinaldoBonusByMonth?.[yearMonth] ?? 0);
    const marginBeforeNewCents = incomeThisMonth - avgExpenseCents - existingCommittedCents;
    const marginAfterNewCents = marginBeforeNewCents - cuotaCents;

    months.push({
      yearMonth,
      existingCommittedCents,
      newCuotaCents: cuotaCents,
      marginBeforeNewCents,
      marginAfterNewCents,
    });

    if (marginAfterNewCents < 0) hasNegativeMargin = true;
    worstMarginAfterNewCents = Math.min(worstMarginAfterNewCents, marginAfterNewCents);

    const marginConsumptionRatio = marginBeforeNewCents > 0 ? cuotaCents / marginBeforeNewCents : Infinity;
    worstMarginConsumptionRatio = Math.max(worstMarginConsumptionRatio, marginConsumptionRatio);

    const debtRatio = incomeThisMonth > 0 ? (existingCommittedCents + cuotaCents) / incomeThisMonth : Infinity;
    worstDebtRatio = Math.max(worstDebtRatio, debtRatio);
  }

  const financingCostCents = cuotaCents * installments - financedCents;
  const financingCostPercent = financedCents > 0 ? financingCostCents / financedCents : 0;

  let verdict: "comoda" | "ajustada" | "no_factible";
  if (
    hasNegativeMargin ||
    worstMarginConsumptionRatio > MARGIN_AJUSTADA_MAX ||
    worstDebtRatio > DEBT_AJUSTADA_MAX
  ) {
    verdict = "no_factible";
  } else if (worstMarginConsumptionRatio >= MARGIN_COMODA_MAX || worstDebtRatio >= DEBT_COMODA_MAX) {
    verdict = "ajustada";
  } else {
    verdict = "comoda";
  }

  return {
    cuotaCents,
    financedCents,
    financingCostCents,
    financingCostPercent,
    months,
    worstDebtRatio,
    worstMarginConsumptionRatio,
    worstMarginAfterNewCents,
    verdict,
  };
}

/**
 * Evalúa pagar `priceCents` de una sola vez contra el saldo real disponible.
 * Un saldo real no positivo nunca puede dar "comoda": sin dividir por cero
 * ni por un negativo, se trata como consumptionRatio infinito.
 */
export function evaluateContadoPurchase(input: {
  priceCents: number;
  realBalanceCents: number;
}): ContadoEvaluation {
  const { priceCents, realBalanceCents } = input;
  const remainderCents = realBalanceCents - priceCents;
  const consumptionRatio = realBalanceCents > 0 ? priceCents / realBalanceCents : Infinity;

  let verdict: "comoda" | "ajustada" | "no_factible";
  if (remainderCents < 0 || consumptionRatio > MARGIN_AJUSTADA_MAX) {
    verdict = "no_factible";
  } else if (consumptionRatio >= MARGIN_COMODA_MAX) {
    verdict = "ajustada";
  } else {
    verdict = "comoda";
  }

  return { realBalanceCents, priceCents, remainderCents, consumptionRatio, verdict };
}

export type SavingsGoalEvaluation = {
  alreadySavedCents: number;
  remainingToSaveCents: number;
  monthsNeeded: number | null;
  verdict: "viable" | "no_viable";
};

/**
 * Evalúa cuántos meses faltan para juntar `priceCents` arrancando de
 * `alreadySavedCents` ya ahorrado, acumulando mes a mes (desde
 * `purchaseYearMonth`, hasta `maxMonths`) la misma capacidad libre que usa
 * `evaluateCuotasPurchase` (ingreso promedio + aguinaldo si corresponde −
 * gasto promedio − cuotas comprometidas ya conocidas de ese mes). Un mes con
 * margen negativo (cuotas comprometidas mayores al ingreso disponible) nunca
 * resta del acumulado — contribuye 0, simplemente no hace avanzar el conteo
 * ese mes. Si `maxMonths` se agota sin alcanzar lo que falta, el resultado es
 * honesto: `monthsNeeded: null` (no hay un número de meses que ofrecer) y
 * `verdict: "no_viable"`, nunca un número inventado por fuera del horizonte
 * evaluado.
 */
export function evaluateSavingsGoal(input: {
  priceCents: number;
  alreadySavedCents: number;
  purchaseYearMonth: string;
  avgIncomeCents: number;
  avgExpenseCents: number;
  existingCommittedByMonth: Record<string, number>;
  aguinaldoBonusByMonth?: Record<string, number>;
  maxMonths: number;
}): SavingsGoalEvaluation {
  const {
    priceCents,
    alreadySavedCents,
    purchaseYearMonth,
    avgIncomeCents,
    avgExpenseCents,
    existingCommittedByMonth,
    aguinaldoBonusByMonth,
    maxMonths,
  } = input;

  const remainingToSaveCents = Math.max(0, priceCents - alreadySavedCents);
  if (remainingToSaveCents === 0) {
    return { alreadySavedCents, remainingToSaveCents, monthsNeeded: 0, verdict: "viable" };
  }

  let accumulatedCents = 0;
  for (let i = 0; i < maxMonths; i++) {
    const yearMonth = addMonthsToYearMonth(purchaseYearMonth, i);
    const capacityCents = Math.max(
      0,
      avgIncomeCents +
        (aguinaldoBonusByMonth?.[yearMonth] ?? 0) -
        avgExpenseCents -
        (existingCommittedByMonth[yearMonth] ?? 0)
    );
    accumulatedCents += capacityCents;
    if (accumulatedCents >= remainingToSaveCents) {
      return { alreadySavedCents, remainingToSaveCents, monthsNeeded: i + 1, verdict: "viable" };
    }
  }

  return { alreadySavedCents, remainingToSaveCents, monthsNeeded: null, verdict: "no_viable" };
}

/** [start, end) de un mes calendario de Argentina, a partir de un "YYYY-MM". */
function monthRangeFor(yearMonth: string): { start: Date; end: Date } {
  const [year, month] = yearMonth.split("-").map(Number);
  return argentinaMonthRange(year, month - 1);
}

/**
 * Promedio de ingreso/gasto de los 3 meses CALENDARIO CERRADOS anteriores al
 * mes en curso (el mes en curso, aunque ya tenga movimientos, nunca entra —
 * todavía no terminó, así que no es representativo de un mes completo).
 * Excluye del gasto la categoría de pago de cuotas (CUOTA_EXPENSE_CATEGORY):
 * ese compromiso ya se proyecta aparte, mes a mes, vía
 * committedCuotasByMonth/isActiveInMonth — sumarlo también acá lo contaría
 * dos veces en evaluateCuotasPurchase.
 *
 * Un mes solo cuenta si está CUBIERTO POR COMPLETO por el historial de la
 * app: el movimiento (Expense o Income, moneda default) más antiguo que
 * existe en toda la base tiene que ser anterior al inicio de ese mes. Sin
 * este chequeo, el primer mes que un usuario usa la app (por ejemplo, si
 * arrancó a mitad de mes) entraría al promedio como si fuera un mes
 * completo — el gasto quedaría artificialmente bajo (son los gastos de
 * unos pocos días, no de 30) y es exactamente el bug real que reportó el usuario
 * (la función de finanzas arrancó el 30/10, así que octubre nunca tuvo un
 * mes completo de datos). Además de la cobertura, `monthsUsed` sigue
 * contando solo los meses donde hubo algún movimiento propio (sueldo+gasto
 * > 0); uno totalmente vacío ni suma ni cuenta en el denominador, y si los
 * 3 meses quedan afuera (por cobertura o por estar vacíos) el promedio es
 * 0/0 → se devuelve directamente en cero sin dividir, y evaluateFeasibility/
 * projectMonthlySavingsCapacity cortan a "no_history": sin un mes cerrado
 * completo no hay nada honesto que promediar todavía.
 *
 * El ingreso que se promedia es SOLO el marcado como sueldo (isSalary:
 * true) — nunca cualquier otro ingreso (reembolsos, laburos sueltos, etc.).
 * Es la base que se proyecta como recurrente en los próximos 1-24 meses
 * (evaluateCuotasPurchase/evaluateSavingsGoal), así que un ingreso puntual
 * no puede inflarla: algo que pasó una vez no se puede asumir que se repite
 * todos los meses futuros. `avgSalaryCents` queda igual a `avgIncomeCents`
 * a propósito (misma fuente) — se mantienen los dos campos para no romper
 * a quien ya consume `avgSalaryCents` para el aguinaldo.
 *
 * Si el sueldo promedio de los meses CERRADOS (ya cubiertos) da $0 — por
 * ejemplo, un mes con gasto real pero sin sueldo cargado ese mes puntual —
 * usa como respaldo el sueldo ya cargado del mes en curso (ver
 * `currentMonthSalaryCents`). Este respaldo NUNCA se usa cuando
 * `monthsUsed` es 0: ahí la respuesta honesta es "no hay historial
 * todavía", no una estimación con el mes en curso.
 */
export async function averagePastIncomeAndExpense(
  nowIso: string
): Promise<{ avgIncomeCents: number; avgExpenseCents: number; avgSalaryCents: number; monthsUsed: number }> {
  const currentYearMonth = toArgentinaDateString(new Date(nowIso)).slice(0, 7);
  const pastYearMonths = [-1, -2, -3].map((n) => addMonthsToYearMonth(currentYearMonth, n));

  const [earliestExpense, earliestIncome] = await Promise.all([
    db.expense.aggregate({ _min: { occurredAt: true }, where: { currency: config.defaultCurrency } }),
    db.income.aggregate({ _min: { occurredAt: true }, where: { currency: config.defaultCurrency } }),
  ]);
  const earliestCandidates = [earliestExpense._min.occurredAt, earliestIncome._min.occurredAt].filter(
    (d): d is Date => d !== null
  );
  const earliestActivityDate =
    earliestCandidates.length > 0 ? new Date(Math.min(...earliestCandidates.map((d) => d.getTime()))) : null;

  let totalSalaryCents = 0;
  let totalExpenseCents = 0;
  let monthsUsed = 0;

  for (const yearMonth of pastYearMonths) {
    const range = monthRangeFor(yearMonth);
    // Cobertura: este mes solo cuenta si la app ya trackeaba movimientos
    // ANTES de que empezara — si no, es un mes parcial (el primero de uso)
    // y promediarlo distorsiona el resultado.
    if (!earliestActivityDate || earliestActivityDate > range.start) continue;

    const [expenseAgg, salaryAgg] = await Promise.all([
      db.expense.aggregate({
        _sum: { amountCents: true },
        where: {
          currency: config.defaultCurrency,
          category: { not: CUOTA_EXPENSE_CATEGORY },
          occurredAt: { gte: range.start, lt: range.end },
        },
      }),
      // Solo el ingreso marcado como sueldo (isSalary: true) de este mes —
      // alimenta tanto avgIncomeCents/avgSalaryCents como el aguinaldo
      // (mitad del sueldo promedio), nunca cualquier otro ingreso.
      db.income.aggregate({
        _sum: { amountCents: true },
        where: {
          currency: config.defaultCurrency,
          isSalary: true,
          occurredAt: { gte: range.start, lt: range.end },
        },
      }),
    ]);

    const expenseCents = expenseAgg._sum.amountCents ?? 0;
    const salaryCents = salaryAgg._sum.amountCents ?? 0;

    if (salaryCents + expenseCents > 0) {
      totalSalaryCents += salaryCents;
      totalExpenseCents += expenseCents;
      monthsUsed += 1;
    }
  }

  if (monthsUsed === 0) {
    return { avgIncomeCents: 0, avgExpenseCents: 0, avgSalaryCents: 0, monthsUsed: 0 };
  }

  const avgSalaryCents = Math.round(totalSalaryCents / monthsUsed);
  const avgExpenseCents = Math.round(totalExpenseCents / monthsUsed);

  // Respaldo: hay al menos un mes CERRADO y cubierto, pero ninguno tuvo
  // sueldo cargado (ej. el sueldo de este mes puntual se cargó recién en el
  // mes en curso). Usar el sueldo ya cargado del mes en curso en vez de un
  // $0 que se sabe que está mal — nunca cualquier otro ingreso del mes en
  // curso, mismo criterio que arriba.
  if (avgSalaryCents === 0) {
    const currentSalary = await currentMonthSalaryCents(nowIso);
    if (currentSalary > 0) {
      return { avgIncomeCents: currentSalary, avgExpenseCents, avgSalaryCents: currentSalary, monthsUsed };
    }
  }

  return { avgIncomeCents: avgSalaryCents, avgExpenseCents, avgSalaryCents, monthsUsed };
}

/**
 * Bono de aguinaldo estimado para `yearMonth`: la mitad del sueldo promedio
 * si el mes es junio ("06") o diciembre ("12") — los dos meses legales de
 * pago del aguinaldo en Argentina — y 0 para cualquier otro mes. Pura, sin
 * acceso a DB: recibe `avgSalaryCents` ya calculado por
 * `averagePastIncomeAndExpense`.
 */
export function aguinaldoBonusForMonth(yearMonth: string, avgSalaryCents: number): number {
  const month = yearMonth.slice(5, 7);
  return month === "06" || month === "12" ? Math.round(avgSalaryCents / 2) : 0;
}

/**
 * Mapa "YYYY-MM" -> bono de aguinaldo para cada mes de `yearMonths` que sea
 * junio o diciembre (los meses que no son junio/diciembre ni siquiera
 * aparecen como clave, dado que `aguinaldoBonusForMonth` daría 0 para
 * ellos) — pensado para pasarse directo como
 * `aguinaldoBonusByMonth` a `evaluateCuotasPurchase`.
 */
export function aguinaldoBonusByMonth(yearMonths: string[], avgSalaryCents: number): Record<string, number> {
  const result: Record<string, number> = {};
  for (const yearMonth of yearMonths) {
    const bonus = aguinaldoBonusForMonth(yearMonth, avgSalaryCents);
    if (bonus > 0) result[yearMonth] = bonus;
  }
  return result;
}

/**
 * Ingreso marcado como sueldo (isSalary: true) del mes en curso — usado
 * como respaldo por `averagePastIncomeAndExpense` cuando el promedio de
 * meses cerrados da sueldo $0. Mismo rango de mes/filtro de moneda que
 * `currentMonthRealBalance`, pero solo el lado del sueldo: nunca cualquier
 * otro ingreso del mes en curso, para no proyectar algo puntual como si
 * fuera recurrente.
 */
export async function currentMonthSalaryCents(nowIso: string): Promise<number> {
  const now = new Date(nowIso);
  const nowParts = argentinaDateParts(now);
  const monthRange = argentinaMonthRange(Number(nowParts.year), Number(nowParts.month) - 1);

  const salaryAgg = await db.income.aggregate({
    _sum: { amountCents: true },
    where: {
      currency: config.defaultCurrency,
      isSalary: true,
      occurredAt: { gte: monthRange.start, lt: monthRange.end },
    },
  });

  return salaryAgg._sum.amountCents ?? 0;
}

/**
 * Total comprometido en cuotas para cada `yearMonth` pedido: un solo
 * `findMany` de TODOS los RecurringItem (mismo patrón que `cuotaItems` en
 * /api/dashboard), y por cada mes pedido se suma `amountCents` únicamente
 * de los items donde `isActiveInMonth` da true ese mes — un item que ya
 * terminó sus cuotas o que todavía no arrancó no cuenta para ese mes.
 */
export async function committedCuotasByMonth(yearMonths: string[]): Promise<Record<string, number>> {
  const items = await db.recurringItem.findMany();

  const result: Record<string, number> = {};
  for (const yearMonth of yearMonths) {
    result[yearMonth] = items
      .filter((item) => isActiveInMonth(item, yearMonth))
      .reduce((sum, item) => sum + item.amountCents, 0);
  }
  return result;
}

/**
 * Cuotas comprometidas de `yearMonth` que TODAVÍA NO se pagaron — a
 * diferencia de `committedCuotasByMonth` (que suma el TOTAL comprometido sin
 * importar si ya se pagó), acá se excluye cualquier item que ya tenga un
 * RecurringPayment ese mes, para no restarlo dos veces: una cuota ya pagada
 * ya salió de la plata disponible por el lado del gasto (dentro de
 * `currentMonthRealBalance`), así que sumarla de nuevo acá la contaría dos
 * veces. Mismo patrón que `cuotasPendientesCents` en
 * src/app/api/dashboard/route.ts:94-113: un solo `findMany` con los pagos de
 * ESE mes incluidos, filtrado por `isActiveInMonth`, y solo los items SIN un
 * payment ese mes suman su `amountCents`.
 */
export async function unpaidCommittedCuotasForMonth(yearMonth: string): Promise<number> {
  const items = await db.recurringItem.findMany({
    include: { payments: { where: { yearMonth } } },
  });

  let unpaidCents = 0;
  for (const item of items) {
    if (!isActiveInMonth(item, yearMonth)) continue;
    if (item.payments.length === 0) unpaidCents += item.amountCents;
  }
  return unpaidCents;
}

/**
 * Saldo real del mes en curso — EXACTAMENTE la misma fórmula que
 * `saldoCents` en src/app/api/dashboard/route.ts (sueldoCents +
 * otrosIngresosCents - monthExpenseCents - ahorroMesCents), con el mismo
 * filtro de moneda y el mismo rango de mes (argentinaMonthRange sobre el
 * "YYYY-MM" actual). ahorroMesCents es el neto de los movimientos de
 * Ahorros de ESTE mes (depósitos positivos, retiros negativos): plata
 * apartada este mes ya no está disponible para comprar de contado, y un
 * retiro neto la devuelve — si este saldo no lo restara, el modo "contado"
 * contaría como disponible lo que el dashboard ya descontó.
 * A diferencia de averagePastIncomeAndExpense, acá NO se excluye la
 * categoría de pago de cuotas: este es el saldo real de la plata, no una
 * proyección de compromisos — una cuota ya pagada este mes ya salió de la
 * cuenta, así que tiene que restar.
 */
export async function currentMonthRealBalance(nowIso: string): Promise<number> {
  const now = new Date(nowIso);
  const nowParts = argentinaDateParts(now);
  const monthRange = argentinaMonthRange(Number(nowParts.year), Number(nowParts.month) - 1);

  const [sueldoAgg, otrosIngresosAgg, monthExpenseAgg, ahorroMesAgg] = await Promise.all([
    db.income.aggregate({
      _sum: { amountCents: true },
      where: {
        isSalary: true,
        currency: config.defaultCurrency,
        occurredAt: { gte: monthRange.start, lt: monthRange.end },
      },
    }),
    db.income.aggregate({
      _sum: { amountCents: true },
      where: {
        isSalary: false,
        currency: config.defaultCurrency,
        occurredAt: { gte: monthRange.start, lt: monthRange.end },
      },
    }),
    db.expense.aggregate({
      _sum: { amountCents: true },
      where: { currency: config.defaultCurrency, occurredAt: { gte: monthRange.start, lt: monthRange.end } },
    }),
    // Mismo where que ahorroMesAgg en src/app/api/dashboard/route.ts.
    db.saving.aggregate({
      _sum: { amountCents: true },
      where: { currency: config.defaultCurrency, occurredAt: { gte: monthRange.start, lt: monthRange.end } },
    }),
  ]);

  const sueldoCents = sueldoAgg._sum.amountCents ?? 0;
  const otrosIngresosCents = otrosIngresosAgg._sum.amountCents ?? 0;
  const monthExpenseCents = monthExpenseAgg._sum.amountCents ?? 0;
  const ahorroMesCents = ahorroMesAgg._sum.amountCents ?? 0;

  return sueldoCents + otrosIngresosCents - monthExpenseCents - ahorroMesCents;
}

// Extracción (Groq #1) de los parámetros de una compra desde texto
// libre, el orquestador puro-TS que combina esos parámetros con la
// matemática y los agregados de DB de arriba, y la
// redacción final (Groq #2) de la respuesta de WhatsApp a partir de los
// números que ese orquestador ya calculó. Mismo criterio de disciplina que
// src/lib/whatsapp/query.ts: la primera llamada a Groq SOLO extrae
// estructura (nunca calcula, nunca suma, y cualquier falla —red, JSON
// inválido, forma inválida— cae a `{}` en vez de lanzar o inventar un
// default); la segunda SOLO redacta en lenguaje natural a partir de datos
// ya calculados acá (nunca inventa un número, y SÍ lanza si Groq no
// devuelve contenido — eso es una falla real para que la maneje quien
// llame, igual que composeAnswer en query.ts).
const MODEL = "openai/gpt-oss-120b";

export const NO_HISTORY_MESSAGE =
  "Todavía no tengo suficiente historial de ingresos y gastos (necesito al menos un mes cerrado con movimientos) para evaluar esta compra.";

// proyeccion_ahorro's own no-history
// message — NO_HISTORY_MESSAGE above talks about "evaluar esta compra",
// which would be confusing for a pure savings-capacity question that never
// mentioned any purchase. Purely additive: NO_HISTORY_MESSAGE itself and
// every factibilidad_compra call site stay untouched.
export const NO_HISTORY_SAVINGS_MESSAGE =
  "Todavía no tengo suficiente historial de ingresos y gastos (necesito al menos un mes cerrado con movimientos) para calcular esto.";

const extractionSchema = z.object({
  priceCents: z.number().int().positive().optional(),
  mode: z.enum(["cuotas", "contado", "ambos", "ahorrar", "recurrente"]).optional(),
  installments: z.number().int().positive().optional(),
  downPaymentCents: z.number().int().nonnegative().optional(),
  hasInterest: z.boolean().optional(),
  tnaPercent: z.number().positive().optional(),
  totalToPayCents: z.number().int().positive().optional(),
  isInvestment: z.boolean().optional(),
});

function buildExtractionSystemPrompt(): string {
  return `Sos un asistente que traduce un mensaje sobre una posible compra, en lenguaje natural, a parámetros estructurados. NUNCA calculás ni sumás nada — solo extraés los datos que el usuario menciona explícitamente, tal como los dice.

Respondé EXCLUSIVAMENTE con un objeto JSON (sin texto adicional, sin markdown, sin explicaciones) con esta forma:
{
  "priceCents": number,
  "mode": "cuotas" | "contado" | "ambos" | "ahorrar" | "recurrente",
  "installments": number,
  "downPaymentCents": number,
  "hasInterest": boolean,
  "tnaPercent": number,
  "totalToPayCents": number,
  "isInvestment": boolean
}

Reglas:
- "priceCents" es el precio total de la compra, en centavos (ej. $299.000 -> 29900000).
- "mode": "cuotas" si el mensaje habla de pagar en cuotas, "contado" si habla de pagar de una vez, "ambos" si menciona las dos opciones o pregunta cuál conviene, "ahorrar" si el mensaje habla de querer ahorrar o juntar plata para comprar algo en el futuro (sin preguntar todavía cómo pagarlo), "recurrente" si el mensaje habla de un gasto nuevo que se repite todos los meses sin fecha de fin (ej. una cuota de gimnasio, clases, una suscripción) y da cuánto sale por mes.
- "installments": solo si "mode" es "cuotas" o "ambos" y el mensaje da la cantidad de cuotas.
- "downPaymentCents": solo si el mensaje menciona una entrega, anticipo o adelanto, en centavos.
- "hasInterest": true SOLO si el mensaje implica explícitamente un costo financiero (palabras como "tasa", "interés", "crédito", "financio", "termino pagando"). Si no hay ninguna señal de ese tipo, omitilo.
- Si "hasInterest" es true, incluí COMO MÁXIMO UNO de estos dos campos (nunca los dos juntos): "tnaPercent" si el mensaje da una tasa anual, o "totalToPayCents" si el mensaje da el total final que se termina pagando.
- "isInvestment": true SOLO si "mode" es "recurrente" y el mensaje suena a algo educativo o de capacitación (palabras como "clase", "curso", "capacitación", "carrera"). Si no hay ninguna señal de ese tipo, omitilo.
- No incluyas en el JSON ningún campo que el mensaje no respalde explícitamente.
- Nunca calculés, sumés ni infieras un valor a partir de otros (por ejemplo, nunca calculés una cuota, un total o una tasa) — solo repetí lo que el mensaje ya dice.`;
}

/**
 * La primera llamada a Groq: SOLO extrae estructura de `conversationText`,
 * nunca calcula nada. Mismo manejo de fallos que extractDateFilter en
 * query.ts/classifyMessage en classify.ts: cualquier error de red, JSON
 * inválido, o fallo de `safeParse` devuelve un resultado vacío — nunca
 * lanza. A diferencia de extractDateFilter (que cae a una ventana de 30
 * días), acá no hay un "default seguro" posible para los parámetros de una
 * compra, así que `{}` — y no un valor inventado — es la única salida
 * honesta.
 */
export async function extractPurchaseParams(conversationText: string): Promise<ExtractedPurchaseParams> {
  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const completion = await groq.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildExtractionSystemPrompt() },
        { role: "user", content: conversationText },
      ],
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) return {};

    const json: unknown = JSON.parse(content);
    const parsed = extractionSchema.safeParse(json);
    if (!parsed.success) return {};

    return parsed.data;
  } catch {
    return {};
  }
}

export type FeasibilityResult = {
  avgIncomeCents: number;
  avgExpenseCents: number;
  monthsUsed: number;
  cuotas?: CuotasEvaluation;
  contado?: ContadoEvaluation;
  ahorro?: SavingsGoalEvaluation;
  // Solo tono: cuando true, composeFeasibilityAnswer menciona que esto
  // podría ser una inversión en el usuario — nunca cambia verdict/cifras.
  isInvestment?: boolean;
  // Suma de los bonos de aguinaldo (no-cero) de los meses que el cálculo
  // efectivamente usó. Presente solo cuando es > 0: el spec exige que la
  // respuesta lo presente como ESTIMACIÓN, nunca como un hecho confirmado,
  // y buildFeasibilitySystemPrompt necesita saber que participó.
  aguinaldoAppliedCents?: number;
};

// Suma los bonos de `bonuses` solo para los meses de `yearMonths` — los
// meses que el cálculo realmente recorrió, no todo el mapa.
function sumAguinaldoBonuses(bonuses: Record<string, number>, yearMonths: string[]): number {
  return yearMonths.reduce((total, yearMonth) => total + (bonuses[yearMonth] ?? 0), 0);
}

/**
 * El orquestador: combina los parámetros YA extraídos (no vuelve a llamar
 * a Groq) con la matemática pura y los agregados de DB.
 * Si no hay historial (monthsUsed === 0) corta inmediatamente al literal
 * "no_history" ANTES de calcular cualquier cuota, margen o ratio — sin un
 * promedio representativo de ingreso/gasto no hay nada contra lo que
 * evaluar la compra.
 */
export async function evaluateFeasibility(
  params: ExtractedPurchaseParams,
  nowIso: string
): Promise<FeasibilityResult | "no_history"> {
  const { avgIncomeCents, avgExpenseCents, avgSalaryCents, monthsUsed } = await averagePastIncomeAndExpense(nowIso);
  if (monthsUsed === 0) return "no_history";

  const purchaseYearMonth = toArgentinaDateString(new Date(nowIso)).slice(0, 7);
  const priceCents = params.priceCents ?? 0;
  const downPaymentCents = params.downPaymentCents ?? 0;
  const financedCents = priceCents - downPaymentCents;
  const installments = params.installments ?? 1;

  // Si el usuario ya dio una tasa o un
  // total a pagar, ESO ya implica interés, aunque la extracción (Groq,
  // best-effort) no haya marcado "hasInterest: true" explícitamente — no
  // hay razón para ignorar un número que el usuario sí dio. Esta es la
  // única fuente de verdad sobre "hay interés o no", usada tanto para
  // elegir la fórmula de la cuota como para forzar financingCostCents/
  // financingCostPercent a 0 más abajo cuando no corresponde.
  const hasInterestEffective =
    params.hasInterest === true || params.tnaPercent !== undefined || params.totalToPayCents !== undefined;

  // Disciplina de la cuota: si el usuario ya dio el total final a pagar
  // (totalToPayCents), ESE es el dato real de cuánto se termina pagando —
  // dividirlo entre las cuotas es una división, no un cálculo de interés,
  // así que frenchInstallmentCents NUNCA entra en esta rama. Recién cuando
  // lo que se dio es una tasa (tnaPercent) hay algo que amortizar con la
  // fórmula francesa.
  let cuotaCents: number;
  if (hasInterestEffective && params.totalToPayCents !== undefined) {
    cuotaCents = Math.round(params.totalToPayCents / installments);
  } else if (hasInterestEffective && params.tnaPercent !== undefined) {
    cuotaCents = frenchInstallmentCents(financedCents, params.tnaPercent, installments);
  } else {
    cuotaCents = Math.round(financedCents / installments);
  }

  const result: FeasibilityResult = { avgIncomeCents, avgExpenseCents, monthsUsed };
  if (params.isInvestment) result.isInvestment = true;

  if (params.mode === "cuotas" || params.mode === "ambos") {
    const yearMonths = Array.from({ length: installments }, (_, i) => addMonthsToYearMonth(purchaseYearMonth, i));
    const existingCommittedByMonth = await committedCuotasByMonth(yearMonths);
    // El modo "cuotas" (ya shippeado) empieza a beneficiarse del aguinaldo
    // automáticamente, sin que router.ts ni ningún otro llamador tenga que
    // pedirlo explícitamente — se calcula acá mismo, para el horizonte
    // exacto de esta compra, y se pasa siempre.
    const aguinaldoBonuses = aguinaldoBonusByMonth(yearMonths, avgSalaryCents);
    result.cuotas = evaluateCuotasPurchase({
      financedCents,
      installments,
      cuotaCents,
      purchaseYearMonth,
      avgIncomeCents,
      avgExpenseCents,
      existingCommittedByMonth,
      aguinaldoBonusByMonth: aguinaldoBonuses,
    });

    const aguinaldoCents = sumAguinaldoBonuses(aguinaldoBonuses, yearMonths);
    if (aguinaldoCents > 0) result.aguinaldoAppliedCents = aguinaldoCents;

    // Sin interés, financingCostCents/financingCostPercent
    // tienen que ser EXACTAMENTE 0 — nunca el residuo de redondeo de
    // cuotaCents * installments (cuotaCents = Math.round(financedCents /
    // installments) no divide exacto en general; ej. $299.000 en 7 cuotas).
    if (!hasInterestEffective) {
      result.cuotas.financingCostCents = 0;
      result.cuotas.financingCostPercent = 0;
    }
  }

  if (params.mode === "contado" || params.mode === "ambos") {
    const realBalanceCents = await currentMonthRealBalance(nowIso);
    // A diferencia del saldo del dashboard,
    // "¿tengo esta plata ahora?" también tiene que restar las cuotas de
    // este mes que ya están comprometidas pero todavía no se pagaron — si
    // no, el saldo infla la plata realmente disponible para esta compra.
    // Una cuota YA pagada este mes no se resta de nuevo acá: ya salió del
    // lado del gasto dentro de currentMonthRealBalance.
    const unpaidCuotasThisMonthCents = await unpaidCommittedCuotasForMonth(purchaseYearMonth);
    result.contado = evaluateContadoPurchase({
      priceCents,
      realBalanceCents: realBalanceCents - unpaidCuotasThisMonthCents,
    });
  }

  if (params.mode === "ahorrar") {
    // Lo ya ahorrado es el total acumulado de Saving, sumado SIN
    // ningún filtro de fecha — exactamente el mismo db.saving.aggregate que
    // ya usan /api/ahorros y el dashboard para su totalAcumuladoCents:
    // Ahorros es el único concepto de plata de esta app que es un saldo
    // corriente, no algo que resetea cada mes calendario. Sí filtra por
    // moneda: solo la moneda default suma a los totales.
    const totalSavedAgg = await db.saving.aggregate({
      _sum: { amountCents: true },
      where: { currency: config.defaultCurrency },
    });
    // Recortado a 0: el total puede quedar negativo (ej. se borra desde la
    // web un depósito que ya se había retirado), y un "ya ahorrado"
    // negativo haría que la meta pida juntar MÁS que el precio real.
    const alreadySavedCents = Math.max(0, totalSavedAgg._sum.amountCents ?? 0);

    const savingsHorizonMonths = 24;
    const savingsYearMonths = Array.from({ length: savingsHorizonMonths }, (_, i) =>
      addMonthsToYearMonth(purchaseYearMonth, i)
    );
    const existingCommittedByMonth = await committedCuotasByMonth(savingsYearMonths);
    const aguinaldoBonuses = aguinaldoBonusByMonth(savingsYearMonths, avgSalaryCents);

    result.ahorro = evaluateSavingsGoal({
      priceCents,
      alreadySavedCents,
      purchaseYearMonth,
      avgIncomeCents,
      avgExpenseCents,
      existingCommittedByMonth,
      aguinaldoBonusByMonth: aguinaldoBonuses,
      maxMonths: savingsHorizonMonths,
    });

    // Solo los meses que la meta realmente recorrió: monthsNeeded === 0 no
    // proyectó ningún mes, y null recorrió el horizonte completo.
    const monthsWalked = result.ahorro.monthsNeeded ?? savingsHorizonMonths;
    const aguinaldoCents = sumAguinaldoBonuses(aguinaldoBonuses, savingsYearMonths.slice(0, monthsWalked));
    if (aguinaldoCents > 0) result.aguinaldoAppliedCents = aguinaldoCents;
  }

  if (params.mode === "recurrente") {
    // Un gasto nuevo recurrente, sin fecha de fin, se evalúa reusando
    // evaluateCuotasPurchase con un horizonte fijo de 6 meses (mismo
    // horizonte que ya usa /cuotas para su proyección) y sin financiamiento:
    // "priceCents" acá representa cuánto sale por mes, no un precio único,
    // así que se pasa directo como cuotaCents.
    const recurringHorizonMonths = 6;
    const yearMonths = Array.from({ length: recurringHorizonMonths }, (_, i) =>
      addMonthsToYearMonth(purchaseYearMonth, i)
    );
    const existingCommittedByMonth = await committedCuotasByMonth(yearMonths);
    const aguinaldoBonuses = aguinaldoBonusByMonth(yearMonths, avgSalaryCents);

    result.cuotas = evaluateCuotasPurchase({
      financedCents: 0,
      installments: recurringHorizonMonths,
      cuotaCents: priceCents,
      purchaseYearMonth,
      avgIncomeCents,
      avgExpenseCents,
      existingCommittedByMonth,
      aguinaldoBonusByMonth: aguinaldoBonuses,
    });

    // No hay nada financiado en este modo: igual que el caso sin interés de
    // "cuotas", financingCostCents/financingCostPercent tienen
    // que ser EXACTAMENTE 0 — nunca cuotaCents * installments - 0, que no
    // significa nada acá.
    result.cuotas.financingCostCents = 0;
    result.cuotas.financingCostPercent = 0;

    const aguinaldoCents = sumAguinaldoBonuses(aguinaldoBonuses, yearMonths);
    if (aguinaldoCents > 0) result.aguinaldoAppliedCents = aguinaldoCents;
  }

  return result;
}

// Formatea un ratio (0.2 -> "20%") para el prompt. Un ratio no finito
// (worstMarginConsumptionRatio/worstDebtRatio pueden ser Infinity cuando el
// margen/ingreso base es <= 0 — ver evaluateCuotasPurchase) nunca se manda
// como "Infinity%": se describe en palabras para que Groq lo redacte sin
// tener que interpretar un valor no numérico.
function fmtPercent(ratio: number): string {
  return Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : "muy por encima del 100%";
}

// Compartida por los dos prompts de redacción que pueden incluir aguinaldo.
function aguinaldoEstimateLine(aguinaldoCents: number, fmt: (cents: number) => string): string {
  return `Esta proyección incluye una ESTIMACIÓN de aguinaldo de ${fmt(aguinaldoCents)}, no un monto confirmado — la respuesta tiene que dejarlo explícito como estimación, nunca como un hecho.`;
}

function buildFeasibilitySystemPrompt(result: FeasibilityResult): string {
  const fmt = (cents: number) => formatCents(cents, config.defaultCurrency, config.locale);

  const lines: string[] = [
    `Sueldo promedio mensual (${result.monthsUsed} mes${result.monthsUsed === 1 ? "" : "es"} de historial): ${fmt(result.avgIncomeCents)}`,
    `Gasto promedio mensual: ${fmt(result.avgExpenseCents)}`,
  ];

  if (result.cuotas) {
    const c = result.cuotas;
    lines.push(
      `Opción en cuotas — cuota mensual: ${fmt(c.cuotaCents)}, monto financiado: ${fmt(c.financedCents)}, veredicto: ${c.verdict}.`
    );
    // Estas cifras ya calculadas en TS
    // (consumo de margen, endeudamiento, margen del peor mes) son las
    // ÚNICAS que Groq puede citar para cualquier comparación o porcentaje —
    // nunca tiene que calcular ni estimar un % por su cuenta.
    lines.push(
      `Consumo del margen libre en el peor mes: ${fmtPercent(c.worstMarginConsumptionRatio)}. Endeudamiento total (todas las cuotas comprometidas, incluida esta, sobre el sueldo promedio) en el peor mes: ${fmtPercent(c.worstDebtRatio)}. Margen libre que queda en el peor mes, después de la cuota nueva: ${fmt(c.worstMarginAfterNewCents)}.`
    );
    if (c.financingCostCents > 0) {
      lines.push(
        `Costo de financiar (lo que se termina pagando de más por el interés): ${fmt(c.financingCostCents)} (${fmtPercent(c.financingCostPercent)} del monto financiado).`
      );
    }
  }

  if (result.contado) {
    const ct = result.contado;
    lines.push(
      `Opción al contado — saldo real disponible este mes (ya restando ingresos/gastos de este mes y las cuotas de este mes todavía pendientes de pagar): ${fmt(ct.realBalanceCents)}, precio: ${fmt(ct.priceCents)}, quedaría: ${fmt(ct.remainderCents)}, consumo de ese saldo: ${fmtPercent(ct.consumptionRatio)}, veredicto: ${ct.verdict}.`
    );
  }

  if (result.ahorro) {
    const a = result.ahorro;
    if (a.monthsNeeded === 0) {
      lines.push(`Meta de ahorro — ya tenés ahorrado ${fmt(a.alreadySavedCents)}, que cubre el precio completo: ya podrías comprarlo.`);
    } else if (a.monthsNeeded !== null) {
      lines.push(
        `Meta de ahorro — ya tenés ahorrado ${fmt(a.alreadySavedCents)}, te falta juntar ${fmt(a.remainingToSaveCents)}, y según tu capacidad de ahorro mensual proyectada te tomaría ${a.monthsNeeded} mes${a.monthsNeeded === 1 ? "" : "es"} más juntarlo.`
      );
    } else {
      lines.push(
        `Meta de ahorro — ya tenés ahorrado ${fmt(a.alreadySavedCents)}, te falta juntar ${fmt(a.remainingToSaveCents)}, y con tu capacidad de ahorro mensual proyectada no se alcanzaría a juntar en los próximos 24 meses.`
      );
    }
  }

  // Sin cuotas ni contado (solo meta de ahorro) no hay un veredicto
  // cómoda/ajustada/no factible que mencionar — esa rama de evaluateFeasibility
  // nunca llena esos dos campos a la vez que ahorro, así que esta instrucción
  // es siempre la correcta para ese caso.
  let closing: string;
  if (result.ahorro && !result.cuotas && !result.contado) {
    closing =
      "Redactá una respuesta breve y natural para WhatsApp, en español, que indique cuántos meses faltan para juntar lo que falta para esta compra (o que ya se juntó todo, o que no se alcanza a juntar en el horizonte evaluado). Usá ÚNICAMENTE las cifras ya calculadas arriba — nunca calculés, sumés ni estimés un número por tu cuenta.";
  } else {
    closing =
      "Redactá una respuesta breve y natural para WhatsApp, en español, que mencione claramente el veredicto (cómoda/ajustada/no factible)" +
      (result.cuotas && result.cuotas.financingCostCents > 0
        ? " y, si corresponde, el costo de financiar contra pagar de contado"
        : "") +
      ". Para cualquier porcentaje o comparación que menciones, usá ÚNICAMENTE las cifras ya calculadas arriba — nunca calculés, sumés ni estimés un número o porcentaje por tu cuenta.";
  }

  if (result.cuotas && result.contado) {
    // Caso mode: "ambos" — el prompt tiene que pedir explícitamente una
    // comparación de las dos opciones, no una respuesta sobre una sola.
    closing +=
      " Como hay tanto una opción en cuotas como al contado, comparalas explícitamente: decí cuál conviene más y por qué, no contestes como si solo hubiera una opción.";
  }

  // Modo "recurrente" con mensaje educativo (clase, curso, capacitación):
  // puramente tono/framing — nunca puede cambiar el veredicto ni ninguna
  // cifra, que ya están fijas arriba.
  if (result.isInvestment) {
    closing +=
      " Mencioná también que esto podría pensarse como una inversión en el usuario mismo, sin que eso cambie el veredicto ni ninguna de las cifras ya calculadas.";
  }

  // Con menos de 3 meses de historial
  // cerrado, el promedio sigue siendo correcto (no se cambia el algoritmo),
  // pero el usuario tiene que saber que se basa en poco historial — nunca
  // un veredicto que suena igual de confiable con 1 mes que con 3.
  if (result.monthsUsed < 3) {
    closing +=
      " Como el promedio de ingreso/gasto se basa en menos de 3 meses de historial, mencioná brevemente que el cálculo se basa en poco historial todavía.";
  }

  // Spec: el aguinaldo es una estimación (la mitad del sueldo promedio), no
  // un ingreso confirmado — sin esta línea Groq lo redacta como un hecho.
  if (result.aguinaldoAppliedCents !== undefined && result.aguinaldoAppliedCents > 0) {
    lines.push(aguinaldoEstimateLine(result.aguinaldoAppliedCents, fmt));
  }

  return `Sos un asistente que redacta, en español y en tono de WhatsApp, la respuesta final de una consulta de factibilidad de compra.

Datos ya calculados — no inventes ni recalculés nada distinto a esto:
${lines.join("\n")}

${closing}`;
}

/**
 * La segunda llamada a Groq: mismo esqueleto que composeAnswer en
 * query.ts. El system prompt lleva ÚNICAMENTE números ya calculados por
 * evaluateFeasibility arriba — esta llamada jamás calcula nada, solo
 * redacta. Si Groq no devuelve contenido, se lanza (no se devuelve
 * silenciosamente un string vacío): igual que composeAnswer, es una falla
 * real para que la maneje quien llame.
 */
export async function composeFeasibilityAnswer(questionText: string, result: FeasibilityResult): Promise<string> {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: buildFeasibilitySystemPrompt(result) },
      { role: "user", content: questionText },
    ],
  });

  const content = completion.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq returned no content for the composed feasibility answer");

  return content.trim();
}

// "¿cuánto puedo ahorrar el mes que viene?" — a
// simpler sibling of evaluateFeasibility/composeFeasibilityAnswer above.
// Unlike factibilidad_compra, there's no object/price to extract (no first
// Groq call at all) and no clarification flow: projectMonthlySavingsCapacity
// reuses the exact same building blocks (averagePastIncomeAndExpense,
// committedCuotasByMonth, aguinaldoBonusForMonth) that evaluateFeasibility
// already uses, and composeSavingsProjectionAnswer mirrors
// composeFeasibilityAnswer's "only redact, never calculate" discipline for
// the second Groq call.
// aguinaldoBonusCents se devuelve (aunque ya esté sumado en capacityCents)
// para que el prompt de redacción pueda marcarlo como estimación.
export type SavingsProjectionResult = { capacityCents: number; monthsUsed: number; aguinaldoBonusCents: number };

/**
 * Margen libre real del mes `targetYearMonth` (ingreso promedio + aguinaldo
 * si ese mes es junio/diciembre − gasto promedio − cuotas comprometidas ya
 * conocidas de ese mes), SIN ningún recorte artificial: a diferencia de un
 * "monto recomendado" más bajo, esta es la cifra honesta del margen
 * completo — ver el design doc. Corta a "no_history" ANTES de calcular
 * nada más, mismo criterio que evaluateFeasibility, cuando no hay ningún
 * mes cerrado con movimientos.
 */
export async function projectMonthlySavingsCapacity(
  targetYearMonth: string,
  nowIso: string
): Promise<SavingsProjectionResult | "no_history"> {
  const { avgIncomeCents, avgExpenseCents, avgSalaryCents, monthsUsed } = await averagePastIncomeAndExpense(nowIso);
  if (monthsUsed === 0) return "no_history";

  const committedByMonth = await committedCuotasByMonth([targetYearMonth]);
  const aguinaldoBonusCents = aguinaldoBonusForMonth(targetYearMonth, avgSalaryCents);
  const capacityCents =
    avgIncomeCents + aguinaldoBonusCents - avgExpenseCents - (committedByMonth[targetYearMonth] ?? 0);

  return { capacityCents, monthsUsed, aguinaldoBonusCents };
}

function buildSavingsProjectionSystemPrompt(targetYearMonth: string, result: SavingsProjectionResult): string {
  const fmt = (cents: number) => formatCents(cents, config.defaultCurrency, config.locale);

  let closing =
    `Redactá una respuesta breve y natural para WhatsApp, en español, que indique cuánto podría ahorrar o apartar el usuario en ${targetYearMonth} según esta cifra ya calculada. ` +
    "Usá ÚNICAMENTE esta cifra — nunca calculés, sumés ni estimés un número distinto por tu cuenta.";

  if (result.monthsUsed < 3) {
    closing +=
      " Como el promedio de ingreso/gasto se basa en menos de 3 meses de historial, mencioná brevemente que el cálculo se basa en poco historial todavía.";
  }

  return `Sos un asistente que redacta, en español y en tono de WhatsApp, la respuesta final de una consulta de cuánto puede ahorrar el usuario el mes que viene.

Datos ya calculados — no inventes ni recalculés nada distinto a esto:
Margen libre proyectado para ${targetYearMonth} (${result.monthsUsed} mes${result.monthsUsed === 1 ? "" : "es"} de historial usados): ${fmt(result.capacityCents)}${
    result.aguinaldoBonusCents > 0 ? `\n${aguinaldoEstimateLine(result.aguinaldoBonusCents, fmt)}` : ""
  }

${closing}`;
}

/**
 * La segunda llamada a Groq de esta consulta: mismo esqueleto que
 * composeFeasibilityAnswer arriba. El system prompt lleva ÚNICAMENTE
 * capacityCents, ya calculado por projectMonthlySavingsCapacity — esta
 * llamada jamás calcula nada, solo redacta. Si Groq no devuelve contenido,
 * se lanza, igual que composeFeasibilityAnswer.
 */
export async function composeSavingsProjectionAnswer(
  questionText: string,
  targetYearMonth: string,
  result: SavingsProjectionResult
): Promise<string> {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: buildSavingsProjectionSystemPrompt(targetYearMonth, result) },
      { role: "user", content: questionText },
    ],
  });

  const content = completion.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq returned no content for the composed savings projection answer");

  return content.trim();
}
