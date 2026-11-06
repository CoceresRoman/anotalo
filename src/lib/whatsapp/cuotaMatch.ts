// Matching de cuotas/agrupadores candidatos a pagar por un pedido en
// lenguaje natural por WhatsApp (p. ej. "pagué el gimnasio", "pagué la
// tarjeta mastercard"). Función pura: solo lee de la DB, sin I/O de WhatsApp
// ni efectos secundarios — la usa el flujo de pago de cuotas para decidir si un pedido de pago
// es inequívoco, ambiguo o no tiene match. Mismo algoritmo que
// deleteMatch.ts — stopwords/scoring/empate→ambiguo —, duplicado a
// propósito en vez de compartido: el pool de candidatos de este archivo
// (items sueltos + agrupadores) no tiene equivalente en deleteMatch.ts, así
// que forzar un import entre los dos complicaría más de lo que ahorra.
import type { RecurringGroup, RecurringItem } from "@prisma/client";
import db from "../db";
import { isActiveInMonth } from "../cuotas";

export type CuotaCandidate =
  | { kind: "item"; item: RecurringItem }
  | { kind: "group"; group: RecurringGroup; items: RecurringItem[] }; // items = los activos y sin pagar este mes bajo ese grupo

export type CuotaMatchResult =
  | { kind: "none" }
  | { kind: "single"; candidate: CuotaCandidate }
  | { kind: "ambiguous"; candidates: CuotaCandidate[] };

// Palabras de comando/relleno sin valor discriminante para encontrar la
// cuota/agrupador ("pagué la tarjeta mastercard" → lo único que importa es
// "tarjeta mastercard"). Las entradas de más de una palabra ("por favor")
// se separan en tokens individuales al armar el set, así cada palabra se
// filtra por sí misma.
const STOPWORDS = new Set(
  [
    "pagué",
    "pague",
    "pago",
    "pagar",
    "pagá",
    "paga",
    "pagame",
    "pagala",
    "pagalo",
    "esa",
    "eso",
    "esta",
    "este",
    "la",
    "el",
    "de",
    "del",
    "cuota",
    "cuotas",
    "ya",
    "por favor",
    "dale",
  ].flatMap((phrase) => phrase.split(" "))
);

const MAX_AMBIGUOUS = 5;

function extractKeywords(requestText: string): string[] {
  const lower = requestText.toLowerCase();
  const words = lower.match(/[a-zñáéíóúü]+/gi) ?? [];
  return words.filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

function candidateName(candidate: CuotaCandidate): string {
  return candidate.kind === "item" ? candidate.item.name : candidate.group.name;
}

export async function findCuotaCandidates(requestText: string, yearMonth: string): Promise<CuotaMatchResult> {
  const items = await db.recurringItem.findMany({
    include: { group: true, payments: { where: { yearMonth } } },
    orderBy: { createdAt: "desc" },
  });

  const filtered = items.filter((item) => isActiveInMonth(item, yearMonth) && item.payments.length === 0);

  // Pool de candidatos: cada item filtrado aporta siempre su propio
  // candidato "item" (matcheable por su propio nombre, agrupado o no — así
  // se puede pagar un item suelto aun si está bajo un grupo). Además, cada
  // grupo con al menos un item filtrado aporta UN candidato "group" (con el
  // nombre del agrupador, no el de sus items), posicionado en el pool donde
  // aparece su item filtrado más reciente — items ya vienen ordenados por
  // createdAt desc, así que esto es lo más cercano a "grupo más reciente
  // primero" que se puede derivar sin un createdAt propio en RecurringGroup.
  const candidates: CuotaCandidate[] = [];
  const groupSlotIndex = new Map<string, number>();
  const groupItemsAccum = new Map<string, RecurringItem[]>();

  for (const item of filtered) {
    candidates.push({ kind: "item", item });
    if (item.groupId && item.group) {
      if (!groupSlotIndex.has(item.groupId)) {
        groupSlotIndex.set(item.groupId, candidates.length);
        groupItemsAccum.set(item.groupId, []);
        candidates.push({ kind: "group", group: item.group, items: [] });
      }
      groupItemsAccum.get(item.groupId)!.push(item);
    }
  }

  groupSlotIndex.forEach((index, groupId) => {
    const slot = candidates[index];
    if (slot && slot.kind === "group") {
      slot.items = groupItemsAccum.get(groupId)!;
    }
  });

  const keywords = extractKeywords(requestText);

  // Pedido sin palabras discriminantes ("pagué esa", pero también "pagué la
  // tv" o "pagué 500", porque extractKeywords descarta palabras cortas y
  // dígitos): no hay con qué elegir entre candidatos. A diferencia de
  // deleteMatch.ts (cuyo "single" siempre termina en una confirmación
  // sí/no), acá "single" paga en el acto — así que solo se resuelve solo
  // cuando hay UN único candidato posible; con 2+ se lista y se pregunta,
  // nunca se adivina.
  if (keywords.length === 0) {
    if (candidates.length === 0) return { kind: "none" };
    if (candidates.length === 1) return { kind: "single", candidate: candidates[0]! };
    return { kind: "ambiguous", candidates: candidates.slice(0, MAX_AMBIGUOUS) };
  }

  const scored = candidates
    .map((candidate) => {
      const text = candidateName(candidate).toLowerCase();
      const score = keywords.filter((keyword) => text.includes(keyword)).length;
      return { candidate, score };
    })
    .filter((entry) => entry.score > 0);

  if (scored.length === 0) return { kind: "none" };

  const maxScore = Math.max(...scored.map((entry) => entry.score));
  // candidates ya viene ordenado de más reciente a más viejo, y el filtro
  // preserva ese orden.
  const top = scored.filter((entry) => entry.score === maxScore).map((entry) => entry.candidate);

  if (top.length === 1) return { kind: "single", candidate: top[0]! };
  return { kind: "ambiguous", candidates: top.slice(0, MAX_AMBIGUOUS) };
}
