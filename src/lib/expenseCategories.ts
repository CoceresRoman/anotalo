// Fixed category list for gastos : replaces the freeform text category the WhatsApp
// classifier used to produce with exactly these 6 values, so the webapp can
// offer a closed dropdown instead of arbitrary strings.
export const EXPENSE_CATEGORIES = ["Comida", "Mercado", "Transporte", "Servicios", "Salud", "Ocio", "Otros"] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

// Category every cuota-payment Expense is filed under, so these gastos group
// together in the Gastos breakdown instead of landing in "Sin categoría".
// Same lowercase short-word convention as the categories classify.ts
// assigns ("comida", "transporte", ...). Lives here (not in cuotas.ts, which
// is server-only: Prisma + node:crypto) so client components can import it.
export const CUOTA_EXPENSE_CATEGORY = "cuotas";

// Keyword table used only by the migration script (migrate-expense-categories.ts)
// to translate legacy freeform categories already stored in the DB into one
// of the 6 fixed values above. Checked via raw.toLowerCase().includes(keyword) —
// order matters only in that the first matching entry wins, but the keyword
// sets below don't overlap.
const LEGACY_KEYWORD_MAP: { keywords: string[]; category: ExpenseCategory }[] = [
  {
    keywords: ["comida", "super", "mercado", "almuerzo", "cena", "restaurant", "kiosco"],
    category: "Comida",
  },
  {
    keywords: ["transporte", "nafta", "combustible", "uber", "taxi", "colectivo", "subte", "peaje"],
    category: "Transporte",
  },
  {
    keywords: ["servicios", "luz", "gas", "agua", "internet", "telefono", "alquiler", "expensas"],
    category: "Servicios",
  },
  {
    keywords: ["salud", "farmacia", "medico", "dentista"],
    category: "Salud",
  },
  {
    keywords: ["ocio", "cine", "salida", "bar", "entretenimiento"],
    category: "Ocio",
  },
];

// Pure, keyword-based mapping from a legacy freeform category (as the LLM
// used to produce it, e.g. "comida", "super", "nafta") to one of the 6 fixed
// EXPENSE_CATEGORIES values. Never passed "cuotas" — that value is written
// only by cuotas.ts's payItem/payGroup, never by the classifier, and the
// migration script leaves "cuotas" rows untouched before this function ever
// sees them (see migrate-expense-categories.ts).
export function mapLegacyCategoryToFixed(raw: string | null): ExpenseCategory {
  if (!raw) return "Otros";
  if ((EXPENSE_CATEGORIES as readonly string[]).includes(raw)) {
    return raw as ExpenseCategory;
  }
  const lower = raw.toLowerCase();
  for (const { keywords, category } of LEGACY_KEYWORD_MAP) {
    if (keywords.some((keyword) => lower.includes(keyword))) {
      return category;
    }
  }
  return "Otros";
}
