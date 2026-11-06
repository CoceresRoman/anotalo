import Groq from "groq-sdk";
import { z } from "zod";
import { EXPENSE_CATEGORIES, type ExpenseCategory } from "../expenseCategories";
import { argentinaDayBoundary } from "../timezone";

// Modelo de visión de Groq. Verificar disponibilidad contra el endpoint en
// vivo (GET /openai/v1/models), NO contra docs o agregadores: Groq deprecó
// el modelo anterior (meta-llama/llama-4-scout-17b-16e-instruct, apagado el
// 2026-07-17) y toda llamada a un modelo decomisionado devuelve error → el
// bot respondía "Tuve un problema técnico leyendo la foto" en cada intento.
// qwen/qwen3.8-27b confirmado vía la API real: acepta imagen + response_format
// json_object y devuelve el schema esperado.
const MODEL = "qwen/qwen3.8-27b";

// Umbral de confianza para decidir auto-carga vs. confirmación. Esta
// función solo lo exporta como constante compartida; NO decide nada con
// él — solo extrae y devuelve `confidencePercent` crudo.
export const RECEIPT_CONFIDENCE_THRESHOLD = 70;

// Cuántos días en el pasado, respecto al momento de envío, se toleran antes
// de tratar la fecha impresa como "claramente inválida" (spec: "de hace
// años") y caer al respaldo de nowIso. Deliberadamente conservador: largo
// para no rechazar a alguien cargando varios meses de tickets atrasados,
// corto para agarrar una fecha realmente vieja o mal leída (ej. Groq
// confundiendo día/mes, "03/11/2026" leído como 11 de marzo en vez de 3 de
// noviembre). En una sola constante, nunca repetido como número mágico.
export const RECEIPT_MAX_PAST_DAYS = 180;

export type ReceiptExtraction = {
  amountCents: number;
  category: ExpenseCategory;
  occurredAt: Date;
  confidencePercent: number;
};

// Discriminada por "readable": cuando es `true` el resto de los campos se
// valida estrictamente; cuando es `false` el resto puede faltar u omitirse
// (Groq no está obligado a mandarlos), de ahí el `.passthrough()`.
const receiptSchema = z.discriminatedUnion("readable", [
  z.object({
    readable: z.literal(true),
    amountCents: z.number().int().positive(),
    category: z.enum(EXPENSE_CATEGORIES),
    date: z.string().nullable(),
    confidencePercent: z.number().min(0).max(100),
  }),
  z.object({ readable: z.literal(false) }).passthrough(),
]);

const VALID_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function buildExtractionSystemPrompt(): string {
  return `Sos un asistente que lee la foto de un ticket o factura de compra y extrae sus datos EXACTAMENTE como aparecen impresos. NUNCA calculás, sumás ni inferís nada que no esté escrito en el ticket — si un dato no se puede leer con confianza, reflejalo bajando "confidencePercent", nunca lo inventes.

Respondé EXCLUSIVAMENTE con un objeto JSON (sin texto adicional, sin markdown, sin explicaciones) con esta forma:
{
  "readable": boolean,
  "amountCents": number,
  "category": "Comida" | "Mercado" | "Transporte" | "Servicios" | "Salud" | "Ocio" | "Otros",
  "date": "YYYY-MM-DD" | null,
  "confidencePercent": number
}

Reglas:
- "readable": false cuando la imagen NO es un ticket/factura o cuando no se puede leer ningún dato usable de ella. En ese caso podés omitir el resto de los campos.
- "amountCents": el monto TOTAL final pagado (no un subtotal ni un ítem suelto), en centavos (ej. $12.500 -> 1250000).
- "category": tiene que ser EXACTAMENTE uno de los 7 valores de la lista. Usá "Mercado" para cualquier ticket de un supermercado o almacén, tenga un solo producto o veinte — el criterio real es el tipo de comercio (supermercado/almacén), nunca si la compra mezcla distintos tipos de productos.
- "date": la fecha de la compra tal como aparece impresa en el ticket, en formato "YYYY-MM-DD". Si el ticket no muestra una fecha legible, usá null — nunca inventes una. IMPORTANTE: los tickets argentinos imprimen la fecha como DD/MM/AAAA (día antes que mes), NUNCA como MM/DD — no la leas como si fuera formato estadounidense. Por ejemplo, "03/11/2026" impreso en el ticket es el 3 de noviembre de 2026 ("2026-11-03"), nunca el 11 de marzo.
- "confidencePercent": tu autoevaluación HONESTA (0 a 100) de qué tan segura es la lectura de "amountCents" y "category" en conjunto. Nunca pongas un número alto por defecto: si la imagen está borrosa, cortada, o el monto es ambiguo, reflejalo con un número bajo.`;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Resuelve la fecha de la compra con el mismo respaldo en los 4 casos no
// confiables: ausente, no parseable, futura respecto al momento de envío
// (ningún ticket real tiene fecha futura), o más de RECEIPT_MAX_PAST_DAYS
// en el pasado (spec: "de hace años" — señal de fecha mal leída, ej. un
// day/month swap) — nunca bloquea ni devuelve "failed" por esto, siempre
// cae a `nowIso`.
function resolveOccurredAt(date: string | null, nowIso: string): Date {
  const now = new Date(nowIso);
  if (date === null || !VALID_DATE_RE.test(date)) return now;

  const parsed = argentinaDayBoundary(date, false);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() > now.getTime()) return now;

  const daysInPast = (now.getTime() - parsed.getTime()) / MS_PER_DAY;
  if (daysInPast > RECEIPT_MAX_PAST_DAYS) return now;

  return parsed;
}

/**
 * Manda la foto de un ticket a Groq (modelo de visión) y devuelve los datos
 * estructurados ya validados. Mismo criterio de disciplina que
 * `extractPurchaseParams`/`transcribeAudio`: esta función NUNCA calcula nada
 * por fuera de lo que Groq ya devolvió — solo valida la forma (Zod) y
 * aplica el respaldo de fecha ausente/inválida/futura/demasiado vieja (más
 * de RECEIPT_MAX_PAST_DAYS días en el pasado).
 *
 * Nunca lanza: cualquier error de red, JSON inválido, o forma inválida que
 * Zod rechace devuelve "failed" (falla técnica recuperable) — nunca
 * "unreadable", que es exclusivamente cuando Groq respondió con forma
 * válida pero marcó la imagen como no legible (`readable: false`).
 *
 * Esta función solo extrae: NO decide auto-carga vs. confirmación según
 * `confidencePercent` — eso es responsabilidad del llamador
 * (RECEIPT_CONFIDENCE_THRESHOLD, exportado arriba, es para que ella lo use).
 */
export async function extractReceiptFromImage(
  imageBuffer: Buffer,
  nowIso: string
): Promise<ReceiptExtraction | "unreadable" | "failed"> {
  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const base64Image = imageBuffer.toString("base64");

    const completion = await groq.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildExtractionSystemPrompt() },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }],
        },
      ],
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) {
      console.error("[ocrReceipt] Groq no devolvió contenido para la lectura del ticket");
      return "failed";
    }

    const json: unknown = JSON.parse(content);
    const parsed = receiptSchema.safeParse(json);
    if (!parsed.success) {
      // La forma no matcheó el schema — logueamos los problemas de Zod (no el
      // contenido crudo, que podría traer datos del ticket) para poder
      // diagnosticarlo desde los logs sin filtrar nada sensible.
      console.error("[ocrReceipt] la respuesta de Groq no tiene la forma esperada", parsed.error.issues);
      return "failed";
    }

    if (!parsed.data.readable) return "unreadable";

    const { amountCents, category, date, confidencePercent } = parsed.data;
    return {
      amountCents,
      category,
      occurredAt: resolveOccurredAt(date, nowIso),
      confidencePercent,
    };
  } catch (err) {
    // Sin este log, una falla de la llamada a Groq (modelo deprecado, red,
    // JSON inválido) queda invisible en producción — el caso real que dejó
    // "Tuve un problema técnico leyendo la foto" sin ninguna pista de por qué.
    console.error("[ocrReceipt] la llamada a Groq para leer el ticket falló", err);
    return "failed";
  }
}
