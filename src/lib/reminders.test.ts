import { expect, test } from "vitest";
import { formatParsedDatetime, statusBadge } from "./reminders";

// Covers a regression: statusBadge() used to check only
// `status`, so a hypothetical row with status "confirmed" but a null
// calendarEventId (permitted by the schema — calendarEventId is a separate
// nullable column) rendered the synced ✅ badge despite having no real
// calendar event. The ✅ badge must require both.
test("statusBadge requires a real calendarEventId for the synced badge, even when status is confirmed", () => {
  expect(statusBadge("confirmed", null)).not.toBe("✅ en Google Calendar");
});

test("statusBadge shows the synced badge only when confirmed with a calendarEventId", () => {
  expect(statusBadge("confirmed", "evt1")).toBe("✅ en Google Calendar");
});

test("statusBadge falls back to the pending badge for queued/awaiting_confirmation", () => {
  expect(statusBadge("queued", null)).toBe("⏳ pendiente de confirmación");
  expect(statusBadge("awaiting_confirmation", null)).toBe("⏳ pendiente de confirmación");
});

test("statusBadge shows the not-synced badge for ambiguous_no_date/rejected", () => {
  expect(statusBadge("ambiguous_no_date", null)).toBe("⚠️ no se creó evento");
  expect(statusBadge("rejected", null)).toBe("⚠️ no se creó evento");
});

test("formatParsedDatetime returns 'sin fecha clara' for a null datetime", () => {
  expect(formatParsedDatetime(null)).toBe("sin fecha clara");
});

test("statusBadge shows a distinct in-progress badge while a confirmed reminder's Calendar event is being created", () => {
  expect(statusBadge("confirming", null)).toBe("⏳ creando evento en Google Calendar");
});
