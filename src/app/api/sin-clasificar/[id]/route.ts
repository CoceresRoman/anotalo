import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import db from "../../../../lib/db";
import { enqueueReminder } from "../../../../lib/whatsapp/reminders";

// Note.type is a plain String column (sqlite has no enum support), but this
// endpoint only ever moves a "no_identificado" note into one of these three
// buckets — see the comment above the Note model in prisma/schema.prisma.
const patchSchema = z.object({
  type: z.enum(["gasto", "idea", "recordatorio", "ingreso", "ahorro"]),
  amountCents: z.number().int().optional(),
  isSalary: z.boolean().optional(),
  category: z.string().nullable().optional(),
  parsedDatetime: z.string().nullable().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { type, amountCents, isSalary, category, parsedDatetime } = parsed.data;

  // `gasto`, `ingreso` and `ahorro` require an amount to create their
  // Expense/Income/Saving row — there's no sensible default to fall back
  // to, unlike `recordatorio`'s parsedDatetime (see the ambiguous_no_date
  // branch below).
  if ((type === "gasto" || type === "ingreso" || type === "ahorro") && typeof amountCents !== "number") {
    return NextResponse.json(
      { error: `amountCents is required when type is '${type}'` },
      { status: 400 }
    );
  }

  // Validated up front, before any write: an unparseable datetime
  // must never reach Reminder.create as an Invalid Date (after Note.type
  // was already flipped), and a past one is never offered for
  // confirmation. The webapp sends a full ISO instant
  // (new Date(datetime-local).toISOString(), i.e. the browser's timezone).
  let datetime: Date | null = null;
  if (type === "recordatorio" && parsedDatetime) {
    datetime = new Date(parsedDatetime);
    if (Number.isNaN(datetime.getTime())) {
      return NextResponse.json({ error: "parsedDatetime is not a valid date" }, { status: 400 });
    }
    if (datetime.getTime() <= Date.now()) {
      return NextResponse.json({ error: "parsedDatetime must be in the future" }, { status: 400 });
    }
  }

  const note = await db.note.findUnique({ where: { id: params.id } });
  if (!note) {
    return NextResponse.json({ error: "Note not found" }, { status: 404 });
  }

  // This endpoint only ever reclassifies a *still-unclassified* note. Without
  // this guard, a second PATCH on the same note id would either throw an
  // unhandled Prisma P2002 (Expense.noteId/Reminder.noteId are @unique, so a
  // same-type re-PATCH collides) or silently leave a stale Expense/Reminder
  // row behind when the type changes (e.g. gasto -> idea), which would keep
  // counting toward /api/gastos totals forever even though the note no
  // longer displays as a gasto. Reject instead of risking either.
  if (note.type !== "no_identificado") {
    return NextResponse.json(
      { error: `Note is already classified as '${note.type}'` },
      { status: 409 }
    );
  }

  if (type === "gasto") {
    // Note.type flip and its Expense row as a single atomic transaction:
    // if the process dies or either write fails partway through, nothing
    // commits, so Note.type never flips without a matching Expense row.
    await db.$transaction([
      db.note.update({ where: { id: note.id }, data: { type } }),
      db.expense.create({
        data: {
          noteId: note.id,
          amountCents: amountCents as number,
          category: category ?? null,
          // No separate "when did this happen" field is collected by this
          // manual-reclassification form, so the note's own creation time
          // (when the WhatsApp message came in) is the best available proxy.
          occurredAt: note.createdAt,
        },
      }),
    ]);
  } else if (type === "ingreso") {
    // Same atomicity as `gasto`: Note.type flip and its Income row commit
    // together or not at all.
    await db.$transaction([
      db.note.update({ where: { id: note.id }, data: { type } }),
      db.income.create({
        data: {
          noteId: note.id,
          amountCents: amountCents as number,
          isSalary: isSalary ?? false,
          occurredAt: note.createdAt,
        },
      }),
    ]);
  } else if (type === "ahorro") {
    // Same atomicity as `gasto`/`ingreso`: Note.type flip and its Saving row
    // commit together or not at all.
    await db.$transaction([
      db.note.update({ where: { id: note.id }, data: { type } }),
      db.saving.create({
        data: {
          noteId: note.id,
          amountCents: amountCents as number,
          occurredAt: note.createdAt,
        },
      }),
    ]);
  } else if (type === "recordatorio") {
    // Flip Note.type first, then hand off to the shared enqueueReminder
    // for the Reminder row itself — it also owns sending the
    // first WhatsApp confirmation prompt when nothing else is pending, so
    // it can't be folded into the same $transaction (that side effect
    // can't be part of a DB transaction, and enqueueReminder does its own
    // Reminder.create internally).
    await db.note.update({ where: { id: note.id }, data: { type } });
    await enqueueReminder(note.id, datetime);
  } else {
    await db.note.update({ where: { id: note.id }, data: { type } });
  }

  const updated = await db.note.findUnique({
    where: { id: note.id },
    include: { expense: true, reminder: true },
  });

  return NextResponse.json(updated, { status: 200 });
}
