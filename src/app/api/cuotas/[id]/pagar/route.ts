import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { payItem } from "../../../../../lib/cuotas";

const paySchema = z.object({
  amountCents: z.number().int().optional(),
});

// The actual Note+Expense+RecurringPayment creation lives in payItem
// (src/lib/cuotas.ts) — extracted there so this route and the
// WhatsApp cuota-payment flow (cuotaPaymentFlow.ts) share one implementation
// instead of each reimplementing it (or the bot calling its own API).
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const body = await request.json().catch(() => ({}));
  const parsed = paySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const result = await payItem(params.id, parsed.data.amountCents ?? null);

  if (result === "not_found") {
    return NextResponse.json({ error: "RecurringItem not found" }, { status: 404 });
  }
  if (result === "not_active") {
    return NextResponse.json({ error: "Item is not active this month" }, { status: 409 });
  }
  if (result === "already_paid") {
    return NextResponse.json({ error: "Item is already paid this month" }, { status: 409 });
  }

  return NextResponse.json({ expenseId: result.expenseId }, { status: 201 });
}
