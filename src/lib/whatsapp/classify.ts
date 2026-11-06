// Classifies an incoming WhatsApp message (already-transcribed text, for
// audio) into either a query against past notes or a new note to capture,
// using Groq's hosted chat-completions LLM. This module deliberately does
// not persist anything (see persist.ts) or decide routing (see router.ts) —
// it only turns text into a `ClassificationResult`.
import Groq from "groq-sdk";
import { z } from "zod";
import { config } from "../config";
import { EXPENSE_CATEGORIES } from "../expenseCategories";
import { ARGENTINA_UTC_OFFSET, toArgentinaIsoString } from "../timezone";
import * as en from "./prompts/en";
import * as es from "./prompts/es";
import * as pt from "./prompts/pt";

// Selected per `config.locale` (BOT_LOCALE) — each module exports a single
// `buildSystemPrompt(nowIso, timezone, utcOffset)` with the exact same rule
// structure, just translated prose (the 6 EXPENSE_CATEGORIES names stay in
// Spanish in all 3, see prompts/es.ts's header comment).
const prompts = { es, en, pt };

export type NoteType = "gasto" | "idea" | "recordatorio" | "ingreso" | "ahorro" | "no_identificado";

export type ClassificationResult = {
  intent:
    | "capture"
    | "query"
    | "delete"
    | "pago_cuota"
    | "factibilidad_compra"
    | "retiro_ahorro"
    | "proyeccion_ahorro";
  noteType?: NoteType;
  amountCents?: number;
  category?: string;
  // Upper-case currency code; absent means pesos ("ARS", persist.ts's default).
  currency?: string;
  // Always either null/absent or a validated, future, Argentina-offset ISO
  // string ("2026-11-04T15:00:00-03:00") — see validateParsedDatetime.
  parsedDatetime?: string | null;
  // Solo tiene sentido cuando noteType === "ingreso": true si el mensaje
  // menciona la palabra "sueldo", false en cualquier otro ingreso.
  isSalary?: boolean;
};

// Note.type is a plain String column (sqlite has no enum support, see the
// comment above the Note model in prisma/schema.prisma) — this schema is
// what actually enforces the allowed values, at the TypeScript layer, for
// whatever the LLM hands back.
const classificationSchema = z.object({
  intent: z.enum([
    "capture",
    "query",
    "delete",
    "pago_cuota",
    "factibilidad_compra",
    "retiro_ahorro",
    "proyeccion_ahorro",
  ]),
  noteType: z.enum(["gasto", "idea", "recordatorio", "ingreso", "ahorro", "no_identificado"]).optional(),
  amountCents: z.number().int().optional(),
  // A category outside the fixed list (e.g. the model hallucinating a
  // legacy-style lowercase value) must not throw away an otherwise-good
  // classification — same .catch(undefined) pattern as currency below.
  category: z.enum(EXPENSE_CATEGORIES).optional().catch(undefined),
  // A malformed currency must not throw away an otherwise-good
  // classification — it's just dropped (and the expense defaults to ARS).
  currency: z
    .string()
    .transform((c) => c.trim().toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{3}$/))
    .optional()
    .catch(undefined),
  parsedDatetime: z.string().nullable().optional().catch(null),
  isSalary: z.boolean().optional(),
});

// Exactly Argentina's fixed offset: a bare datetime, a "Z", or any other
// offset is exactly the ambiguity at stake (the model resolving "a las
// 10" as 10:00 UTC), so it's rejected rather than guessed at.
const OFFSET_ISO_REGEX = new RegExp(
  `^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.\\d{1,3})?)?${ARGENTINA_UTC_OFFSET}$`
);

// Never trusts the model's compliance: anything that isn't a real,
// Argentina-offset, strictly-future datetime becomes null — which
// persist.ts/enqueueReminder turn into an "ambiguous_no_date" reminder
// (visible in the webapp, never prompted, never sent to Calendar) instead
// of an Invalid Date reaching Prisma or a past/misread time reaching the
// confirmation prompt.
function validateParsedDatetime(value: string | null | undefined, nowIso: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  const match = OFFSET_ISO_REGEX.exec(trimmed);
  if (!match) return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  // Round-trip check: rejects calendar-impossible values JS would silently
  // roll over (e.g. Feb 30 -> Mar 2).
  const [, y, mo, d, h, mi] = match;
  if (!toArgentinaIsoString(date).startsWith(`${y}-${mo}-${d}T${h}:${mi}`)) return null;
  if (date.getTime() <= new Date(nowIso).getTime()) return null;
  return trimmed;
}

// Never thrown to callers: any failure (network error, malformed JSON,
// schema mismatch) falls back to this so a message is never lost — it
// still becomes a persisted Note (via persist.ts), just an unclassified one.
const FALLBACK_RESULT: ClassificationResult = { intent: "capture", noteType: "no_identificado" };

// llama-3.3-70b-versatile was deprecated/removed from Groq's catalog
// (confirmed via a live 404 model_not_found against the real API on
// 2026-10-30) — classifyMessage's catch-all error handling silently
// swallowed that into FALLBACK_RESULT, so every message landed as
// no_identificado with no error anywhere in the logs. Replaced with
// openai/gpt-oss-120b, verified against this project's actual prompt to
// return correct noteType/parsedDatetime (including the exact -03:00
// offset format classify.ts requires) before switching.
const MODEL = "openai/gpt-oss-120b";

export async function classifyMessage(text: string, nowIso: string): Promise<ClassificationResult> {
  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const completion = await groq.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: prompts[config.locale].buildSystemPrompt(nowIso, config.timezone, config.utcOffset),
        },
        { role: "user", content: text },
      ],
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) return FALLBACK_RESULT;

    const json: unknown = JSON.parse(content);
    const parsed = classificationSchema.safeParse(json);
    if (!parsed.success) return FALLBACK_RESULT;

    const result: ClassificationResult = { ...parsed.data };
    if (result.currency === undefined) delete result.currency;
    if (result.isSalary === undefined) delete result.isSalary;
    const parsedDatetime = validateParsedDatetime(parsed.data.parsedDatetime, nowIso);
    if (parsedDatetime === undefined) delete result.parsedDatetime;
    else result.parsedDatetime = parsedDatetime;
    return result;
  } catch {
    return FALLBACK_RESULT;
  }
}
