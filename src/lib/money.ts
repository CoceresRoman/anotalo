// Type-only: erased at compile time (isolatedModules + verbatim type
// imports), so this never pulls src/lib/config.ts's `config` singleton
// (which reads process.env) into a client bundle. formatCents/formatAmount
// below take currency/locale as explicit params for exactly that reason —
// see money.test.ts and the API routes (e.g. src/app/api/dashboard/route.ts)
// for how server-only callers source config.defaultCurrency/config.locale
// and client components source the same values from an already-fetched API
// response instead of importing config.ts directly.
import type { BotLocale } from "./config";

// Money is always stored as integer cents (see Expense.amountCents in
// prisma/schema.prisma) so these two helpers are the only place that
// convert between that integer and a human-readable/editable amount string.

// Fixed 3-entry map from the bot's locale to the Intl locale tag used to
// format amounts — not an open list, since BotLocale itself only has 3
// values (see src/lib/config.ts).
const LOCALE_TAGS: Record<BotLocale, string> = {
  es: "es-AR",
  en: "en-US",
  pt: "pt-BR",
};

// Shared Intl.NumberFormat formatting logic — the only place that talks to
// Intl, so formatCents and formatAmount can never drift into two different
// (and possibly inconsistent) ways of rendering a currency.
function formatMoney(cents: number, currency: string, locale: BotLocale): string {
  const amount = cents / 100;
  const hasFraction = !Number.isInteger(amount);

  const formatter = new Intl.NumberFormat(LOCALE_TAGS[locale], {
    style: "currency",
    currency,
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  });

  // Some locales (e.g. es-AR) insert a literal space between the currency
  // symbol and the number; strip it so the result stays as tight as the
  // manually-built "$184.300" string this replaces.
  return formatter
    .formatToParts(amount)
    .filter((part) => !(part.type === "literal" && /^\s+$/.test(part.value)))
    .map((part) => part.value)
    .join("");
}

/**
 * Formats integer cents as a currency string in `currency`/`locale`, e.g.
 * with ("ARS", "es") 18430000 -> "$184.300". Used wherever the amount is
 * already known to be in the app's own default currency (most
 * dashboard/gastos/ingresos/cuotas totals) — callers pass
 * config.defaultCurrency/config.locale server-side, or the
 * defaultCurrency/locale field the relevant API response already carries
 * client-side.
 */
export function formatCents(cents: number, currency: string, locale: BotLocale): string {
  return formatMoney(cents, currency, locale);
}

/**
 * Parses a user-typed peso amount into integer cents, or `null` if it can't
 * be parsed. Accepts plain numbers ("3200"), Argentine-style grouped/decimal
 * numbers ("3.200", "3200,50", "3.200,50"), and US-style equivalents
 * ("3,200.50"), since the edit UI may hand this either a plain <input
 * type="number"> value or free-typed text.
 */
export function parseAmountToCents(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let cleaned = trimmed.replace(/\$/g, "").replace(/\s/g, "");
  if (!cleaned || !/^-?[\d.,]+$/.test(cleaned)) return null;

  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");

  if (hasComma && hasDot) {
    const lastComma = cleaned.lastIndexOf(",");
    const lastDot = cleaned.lastIndexOf(".");
    if (lastComma > lastDot) {
      // Argentine style: "." thousands, "," decimal.
      cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    } else {
      // US style: "," thousands, "." decimal.
      cleaned = cleaned.replace(/,/g, "");
    }
  } else if (hasComma) {
    cleaned = normalizeSingleSeparator(cleaned, ",");
  } else if (hasDot) {
    cleaned = normalizeSingleSeparator(cleaned, ".");
  }

  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;

  return Math.round(value * 100);
}

// With only one kind of separator present, treat it as a decimal point when
// its last group is 1-2 digits (e.g. "3200,5" or "3200.50"), and as a
// thousands separator otherwise (e.g. "3.200" or "3,200,000").
function normalizeSingleSeparator(value: string, separator: "," | "."): string {
  const parts = value.split(separator);
  const lastPart = parts[parts.length - 1];

  if (parts.length > 1 && lastPart.length <= 2) {
    const decimal = parts.pop();
    return `${parts.join("")}.${decimal}`;
  }

  return value.split(separator).join("");
}

/**
 * Formats an amount in its OWN currency, which may differ from the app's
 * default (e.g. an expense logged in USD while the default is ARS) — never
 * converted, and never mistaken for the default currency. Correct for any
 * ISO 4217 currency code, not just a hardcoded handful: this and
 * `formatCents` share the same Intl-based formatting logic (`formatMoney`
 * above), so there's exactly one implementation of "how do we render an
 * amount in a given currency" to keep correct.
 */
export function formatAmount(cents: number, currency: string, locale: BotLocale): string {
  return formatMoney(cents, currency, locale);
}
