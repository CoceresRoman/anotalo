// Display-layer helpers for the Recordatorios page. Pulled out of
// src/app/recordatorios/page.tsx (rather than kept as local functions there)
// because Next.js page.tsx files only allow a fixed set of exports
// (default, metadata, generateStaticParams, etc. — see the generated
// .next/types/app/**/page.ts constraint); exporting an arbitrary named
// function like `statusBadge` directly from page.tsx fails `tsc`/`next
// build` type checking. Moving it here (same pattern as src/lib/money.ts)
// keeps it testable with a plain unit test.

// Reminder.status is a plain String column (sqlite has no enum support),
// so this is just a display-layer mapping, not an enforced set — see the
// comment above the Reminder model in prisma/schema.prisma. Any status not
// listed here (there shouldn't be any) falls back to the "pendiente" badge.
//
// The ✅ badge additionally requires a real `calendarEventId`, not just
// `status === "confirmed"` — `calendarEventId` is a separate nullable
// column the schema permits to be null even when status is "confirmed"
// (e.g. if a later task ever sets status before the calendar write
// actually succeeds). Never show a reminder as calendar-synced unless it
// genuinely has a calendarEventId.

// Reminder statuses that mean "still waiting on the user to confirm" — a
// recordatorio note in this state has no stable target to delete yet:
// deleting it mid-"confirming" (its Calendar write in flight) can orphan a
// Calendar event once that write resolves, and deleting an
// "awaiting_confirmation" one leaves its WhatsApp yes/no prompt open.
// Shared by the dashboard route, the Recordatorios DELETE route, and the
// Recordatorios page's own delete-button visibility, so all three agree on
// the same set.
export const PENDING_CONFIRMATION_STATUSES = ["awaiting_confirmation", "confirming"];

export function statusBadge(status: string, calendarEventId: string | null): string {
  if (status === "confirmed" && calendarEventId) return "✅ en Google Calendar";
  if (status === "queued" || status === "awaiting_confirmation") return "⏳ pendiente de confirmación";
  // Confirmed by the user, Calendar write in flight (or interrupted by a crash;
  // the bot re-asks on its next connection).
  if (status === "confirming") return "⏳ creando evento en Google Calendar";
  if (status === "ambiguous_no_date" || status === "rejected") return "⚠️ no se creó evento";
  return "⏳ pendiente de confirmación";
}

export function formatParsedDatetime(iso: string | null): string {
  if (!iso) return "sin fecha clara";
  return new Date(iso).toLocaleString("es-AR", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
