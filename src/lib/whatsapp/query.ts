// Answers a natural-language question about previously stored notes
// (gastos, ideas, recordatorios), using Groq's hosted chat-completions LLM
// twice: once to turn the question into a structured date/category/type
// filter, and once to compose a natural-language answer from the rows that
// filter actually matched in `db`. The discipline requirement (see the
// a deliberate design choice) is that the second call is only ever given rows that
// really exist in the database — never left to answer from its own
// training-data knowledge — and that a genuinely empty result set produces
// an honest "no encontré nada" reply instead of a fabricated one.
import type { Expense, Note, Reminder } from "@prisma/client";
import Groq from "groq-sdk";
import { z } from "zod";
import { config } from "../config";
import db from "../db";
import { formatAmount } from "../money";
import {
  ARGENTINA_TZ,
  ARGENTINA_UTC_OFFSET,
  argentinaDayBoundary,
  toArgentinaDateString,
  toArgentinaIsoString,
} from "../timezone";

// Same deprecated-model issue as classify.ts — see its comment for how
// this was found (a live 404 model_not_found against Groq's API).
const MODEL = "openai/gpt-oss-120b";

const NO_RESULTS_MESSAGE = "No encontré nada para eso.";
const FAILURE_MESSAGE = "No pude buscar eso ahora, probá de nuevo en un rato.";

// Same four values as classify.ts's NoteType — duplicated here rather than
// imported as a zod schema because zod needs the literal union spelled out,
// same as classify.ts's own classificationSchema does.
const dateFilterSchema = z.object({
  dateFrom: z.string(),
  dateTo: z.string(),
  category: z.string().optional(),
  type: z.enum(["gasto", "idea", "recordatorio", "no_identificado"]).optional(),
});

type DateFilter = z.infer<typeof dateFilterSchema>;

type NoteWithRelations = Note & { expense: Expense | null; reminder: Reminder | null };

const FALLBACK_WINDOW_DAYS = 30;

// Used whenever the first Groq call fails outright or hands back something
// that doesn't parse/validate — never left unfiltered, so a broken
// extraction still searches a bounded (if imprecise) window instead of the
// entire note history.
// Days are Argentina calendar days, never UTC or the server's own.
function defaultFilter(nowIso: string): DateFilter {
  const now = new Date(nowIso);
  const from = new Date(now.getTime() - FALLBACK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { dateFrom: toArgentinaDateString(from), dateTo: toArgentinaDateString(now) };
}

function buildFilterSystemPrompt(nowIso: string): string {
  return `Sos un asistente que traduce preguntas en lenguaje natural sobre notas personales (gastos, ideas y recordatorios) guardadas en una base de datos, a un filtro de búsqueda.

El usuario vive en Argentina: su zona horaria es ${ARGENTINA_TZ} (UTC${ARGENTINA_UTC_OFFSET}, sin horario de verano), y las fechas del filtro son días calendario de Argentina.

La fecha y hora actual de referencia es ${toArgentinaIsoString(new Date(nowIso))} (hora de Argentina; equivale a ${nowIso} en UTC). Resolvé toda fecha relativa mencionada en la pregunta (por ejemplo "el miércoles", "ayer", "este mes") tomando esa fecha/hora de Argentina como referencia.

Respondé EXCLUSIVAMENTE con un objeto JSON (sin texto adicional, sin markdown, sin explicaciones) con esta forma:
{
  "dateFrom": "YYYY-MM-DD",
  "dateTo": "YYYY-MM-DD",
  "category": string,
  "type": "gasto" | "idea" | "recordatorio" | "no_identificado"
}

Reglas:
- "dateFrom" y "dateTo" son obligatorios y delimitan el rango de fechas relevante para la pregunta (inclusive). Si la pregunta menciona un solo día, usá ese mismo día para ambos.
- Incluí "category" solo si la pregunta menciona una categoría de gasto específica (por ejemplo "comida", "transporte").
- Incluí "type" solo si la pregunta se refiere claramente a un tipo de nota en particular ("gasto", "idea" o "recordatorio").
- Si no podés determinar un rango razonable a partir de la pregunta, usá los últimos 30 días hasta la fecha de referencia.
- No incluyas en el JSON los campos que no correspondan.`;
}

// Tries the real extraction; any failure (network error, malformed JSON,
// schema mismatch) falls back to the last 30 days rather than throwing —
// this failure mode is contained here, separate from the outer
// catch-all, because a bad filter should still attempt a (bounded) search
// instead of immediately giving up with the generic apology.
async function extractDateFilter(questionText: string, nowIso: string): Promise<DateFilter> {
  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const completion = await groq.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildFilterSystemPrompt(nowIso) },
        { role: "user", content: questionText },
      ],
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) return defaultFilter(nowIso);

    const json: unknown = JSON.parse(content);
    const parsed = dateFilterSchema.safeParse(json);
    if (!parsed.success) return defaultFilter(nowIso);

    return parsed.data;
  } catch {
    return defaultFilter(nowIso);
  }
}

// Accepts either a plain "YYYY-MM-DD" date (an Argentina calendar day) or a
// full ISO datetime string, since the model is only asked for the former
// but nothing stops it from handing back the latter. A datetime without an
// explicit offset is read as Argentina time — never as the server's local
// time, which is what `new Date("...T10:00")` would otherwise do.
function parseDateBoundary(value: string, endOfDay: boolean): Date {
  if (!value.includes("T")) return argentinaDayBoundary(value, endOfDay);
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(value);
  return new Date(hasOffset ? value : `${value}${ARGENTINA_UTC_OFFSET}`);
}

function formatNoteForContext(note: NoteWithRelations): string {
  // Dates rendered in Argentina time so "el miércoles" lines up with
  // the day the user actually lived, not the UTC day.
  if (note.expense) {
    const date = toArgentinaDateString(note.expense.occurredAt);
    const category = note.expense.category ?? "sin categoría";
    return `- Gasto de ${formatAmount(note.expense.amountCents, note.expense.currency, config.locale)} en "${category}" el ${date} (texto original: "${note.rawText}")`;
  }
  if (note.reminder) {
    const date = note.reminder.parsedDatetime ? toArgentinaIsoString(note.reminder.parsedDatetime) : "sin fecha";
    return `- Recordatorio (${note.reminder.status}) para ${date}: "${note.rawText}"`;
  }
  const date = toArgentinaDateString(note.createdAt);
  return `- Nota de tipo "${note.type}" del ${date}: "${note.rawText}"`;
}

function buildAnswerSystemPrompt(context: string): string {
  return `Sos un asistente que responde preguntas sobre notas personales (gastos, ideas y recordatorios) ya guardadas.

Respondé la pregunta del usuario EXCLUSIVAMENTE en base a los siguientes datos encontrados. No inventes ni agregues información que no esté en estos datos; si no alcanzan para responder con precisión, decilo honestamente.

Datos encontrados:
${context}

Respondé en español, en un mensaje breve y natural, como para WhatsApp.`;
}

// The second Groq call. Only ever invoked with rows that actually matched
// in the database (never when `matches` is empty — see answerQuery), so
// the model always has real, grounded data to answer from.
async function composeAnswer(questionText: string, matches: NoteWithRelations[]): Promise<string> {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const context = matches.map(formatNoteForContext).join("\n");

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: buildAnswerSystemPrompt(context) },
      { role: "user", content: questionText },
    ],
  });

  const content = completion.choices?.[0]?.message?.content;
  // A missing/empty response here is still a failure, even though it
  // didn't throw — treated as one so the caller's catch-all turns it into
  // the same honest apology rather than an empty WhatsApp message.
  if (!content) throw new Error("Groq returned no content for the composed answer");

  return content.trim();
}

export async function answerQuery(questionText: string, nowIso: string): Promise<string> {
  try {
    const filter = await extractDateFilter(questionText, nowIso);
    let from = parseDateBoundary(filter.dateFrom, false);
    let to = parseDateBoundary(filter.dateTo, true);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      const fallback = defaultFilter(nowIso);
      from = parseDateBoundary(fallback.dateFrom, false);
      to = parseDateBoundary(fallback.dateTo, true);
    }

    // Fetched unfiltered at the Prisma level and matched in-memory below:
    // the "relevant date" for a note depends on its type (an expense's
    // occurredAt, a reminder's parsedDatetime, or the note's own
    // createdAt for ideas/no_identificado), which a single Prisma `where`
    // can't express cleanly over an optional 1-1 relation. The personal,
    // single-user scale of this app's note history makes this fine.
    const notes = (await db.note.findMany({
      include: { expense: true, reminder: true },
      orderBy: { createdAt: "asc" },
    })) as NoteWithRelations[];

    const matches = notes.filter((note) => {
      const relevantDate = note.expense?.occurredAt ?? note.reminder?.parsedDatetime ?? note.createdAt;
      if (relevantDate < from || relevantDate > to) return false;
      if (filter.type && note.type !== filter.type) return false;
      if (filter.category && note.expense?.category?.toLowerCase() !== filter.category.toLowerCase()) {
        return false;
      }
      return true;
    });

    // Never fabricated: a genuinely empty result set short-circuits to a
    // fixed, honest message and skips the second Groq call entirely,
    // rather than asking the model to "answer" from no data at all.
    if (matches.length === 0) return NO_RESULTS_MESSAGE;

    return await composeAnswer(questionText, matches);
  } catch {
    return FAILURE_MESSAGE;
  }
}
