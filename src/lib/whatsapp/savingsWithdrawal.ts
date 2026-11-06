// Withdraws from the cumulative ahorro total via WhatsApp (the opposite of
// persist.ts's "ahorro" capture branch): creates a NEW Note+Saving
// pair with a NEGATIVE amountCents — the existing Saving rows are never
// mutated or deleted, same append-only ledger discipline as every other
// movement type in this app (gasto/ingreso/pago_cuota). Unlike pago_cuota or
// factibilidad_compra, this intent never asks for clarification and never
// creates a pending row (router.ts) — it always resolves immediately.
import { randomUUID } from "node:crypto";
import { config } from "../config";
import db from "../db";

export async function withdrawSavings(amountCents: number | null): Promise<{ withdrawnCents: number }> {
  // The cumulative total has NO date filter — same discipline as
  // /api/ahorros's totalAcumuladoCents aggregate (src/app/api/ahorros/route.ts):
  // ahorro is a running balance, not something that resets every calendar
  // month. Only default-currency rows count (same filter as that
  // aggregate): a USD deposit is never "available" pesos to withdraw.
  // Clamped at 0 so a withdrawal request can never read a pre-existing
  // negative state as "available" money.
  const totalAcumulado = await db.saving.aggregate({
    _sum: { amountCents: true },
    where: { currency: config.defaultCurrency },
  });
  const availableCents = Math.max(totalAcumulado._sum.amountCents ?? 0, 0);

  // null (no amount mentioned in the message) withdraws everything
  // available; an explicit amount is capped at what's available, so the
  // cumulative total can never go negative from a withdrawal alone.
  const withdrawnCents = Math.min(amountCents ?? availableCents, availableCents);

  await db.$transaction(async (tx) => {
    const note = await tx.note.create({
      data: {
        rawText: "retiro de ahorro",
        source: "text",
        type: "ahorro",
        // Not a real WhatsApp message id, but Note.whatsappMessageId is
        // @unique and non-nullable — same "web:" prefixed random id pattern
        // as cuotas.ts's payItem/payGroup. The original incoming message
        // already has its own ProcessedMessage row (router.ts); this Note
        // is a separate, synthetic row for the withdrawal itself.
        whatsappMessageId: `web:${randomUUID()}`,
      },
    });
    await tx.saving.create({
      data: {
        noteId: note.id,
        amountCents: -withdrawnCents,
        // Explicit, not the schema's @default("ARS"): the amount was capped
        // against the default-currency total above, so the withdrawal row
        // must land in that same currency or it would never subtract from it.
        currency: config.defaultCurrency,
        occurredAt: new Date(),
      },
    });
  });

  return { withdrawnCents };
}
