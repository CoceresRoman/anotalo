// Matching de notas candidatas a borrar por un pedido en lenguaje natural por
// WhatsApp (p. ej. "borrá esa", "eliminá la idea de los libros"). Función
// pura: solo lee de la DB, sin I/O de WhatsApp ni efectos secundarios — la
// usa el flujo de borrado para decidir si un pedido de borrado es inequívoco, ambiguo o
// no tiene match.
import type { Note, Reminder } from "@prisma/client";
import db from "../db";

export type DeletableNote = Note & { reminder: Reminder | null };

export type DeleteMatchResult =
  | { kind: "none" }
  | { kind: "single"; note: DeletableNote }
  | { kind: "ambiguous"; notes: DeletableNote[] };

// Palabras de comando/relleno sin valor discriminante para encontrar la nota
// ("borrá la idea de los libros" → lo único que importa es "libros"). Las
// entradas de más de una palabra ("por favor") se separan en tokens
// individuales al armar el set, así cada palabra se filtra por sí misma.
const STOPWORDS = new Set(
  [
    "borra",
    "borrá",
    "borrame",
    "eliminá",
    "elimina",
    "eliminame",
    "saca",
    "sacá",
    "esa",
    "eso",
    "esta",
    "este",
    "la",
    "el",
    "de",
    "del",
    "último",
    "ultima",
    "nota",
    "idea",
    "recordatorio",
    "por favor",
    "dale",
  ].flatMap((phrase) => phrase.split(" "))
);

const MAX_CANDIDATES = 20;
const MAX_AMBIGUOUS = 5;

function extractKeywords(requestText: string): string[] {
  const lower = requestText.toLowerCase();
  const words = lower.match(/[a-zñáéíóúü]+/gi) ?? [];
  return words.filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

// The take limit is applied PER note-type group, not across all four types
// at once: gastos (frequent, plus one per cuota payment) would otherwise
// crowd older ideas/recordatorios out of a single shared limit — a
// regression of the pre-existing idea/recordatorio delete behavior.
const CANDIDATE_TYPE_GROUPS: string[][] = [
  ["idea", "recordatorio"],
  ["gasto", "ingreso", "ahorro"],
];

async function recentCandidatesOfTypes(types: string[]): Promise<DeletableNote[]> {
  return (await db.note.findMany({
    where: {
      type: { in: types },
      NOT: { reminder: { status: { in: ["awaiting_confirmation", "confirming"] } } },
    },
    include: { reminder: true },
    orderBy: { createdAt: "desc" },
    take: MAX_CANDIDATES,
  })) as DeletableNote[];
}

export async function findDeleteCandidates(requestText: string): Promise<DeleteMatchResult> {
  const perGroup = await Promise.all(CANDIDATE_TYPE_GROUPS.map(recentCandidatesOfTypes));
  // Re-merge into a single newest-first list: the pronoun fallback and the
  // tie-break below both rely on candidates being ordered by createdAt desc.
  const candidates = perGroup
    .flat()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const keywords = extractKeywords(requestText);

  // Pedido puramente pronominal ("borrá esa"): no hay palabra que elegir
  // entre candidatas, así que se asume la más reciente.
  if (keywords.length === 0) {
    if (candidates.length === 0) return { kind: "none" };
    return { kind: "single", note: candidates[0]! };
  }

  const scored = candidates
    .map((note) => {
      const text = note.rawText.toLowerCase();
      const score = keywords.filter((keyword) => text.includes(keyword)).length;
      return { note, score };
    })
    .filter((entry) => entry.score > 0);

  if (scored.length === 0) return { kind: "none" };

  const maxScore = Math.max(...scored.map((entry) => entry.score));
  // candidates ya viene ordenado por createdAt desc, y el filtro preserva
  // ese orden.
  const top = scored.filter((entry) => entry.score === maxScore).map((entry) => entry.note);

  if (top.length === 1) return { kind: "single", note: top[0]! };
  return { kind: "ambiguous", notes: top.slice(0, MAX_AMBIGUOUS) };
}
