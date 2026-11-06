import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { payGroup } from "../../../../../lib/cuotas";

const paySchema = z.object({
  amountCents: z.number().int().optional(),
});

// The actual Note+Expense+RecurringPayment creation (one combined
// Note+Expense for every active, unpaid item under the group) lives in
// payGroup (src/lib/cuotas.ts) — extracted there so this route and
// the WhatsApp cuota-payment flow (cuotaPaymentFlow.ts) share one
// implementation instead of each reimplementing it.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const body = await request.json().catch(() => ({}));
  const parsed = paySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const result = await payGroup(params.id, parsed.data.amountCents ?? null);

  if (result === "not_found") {
    return NextResponse.json({ error: "RecurringGroup not found" }, { status: 404 });
  }
  if (result === "nothing_to_pay") {
    return NextResponse.json(
      { error: "No active, unpaid items under this group this month" },
      { status: 409 }
    );
  }

  return NextResponse.json(
    { expenseId: result.expenseId, itemIds: result.itemIds },
    { status: 201 }
  );
}
