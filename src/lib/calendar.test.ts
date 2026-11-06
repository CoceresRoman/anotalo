import { beforeEach, expect, test, vi } from "vitest";

// Only the network-touching googleapis pieces (OAuth2 client construction
// and calendar.events.insert) are mocked — calendar.ts's own logic (reading
// the token file, building the OAuth2 client, computing the 30-minute
// default end time, returning the created event's id) runs for real. Real
// Calendar API calls require a real, authorized Google account (set up via
// scripts/setup-google-auth.ts), which doesn't exist in this test
// environment — see task-11-report.md for that limitation.
const mockInsert = vi.hoisted(() => vi.fn());
const mockDelete = vi.hoisted(() => vi.fn());
const mockSetCredentials = vi.hoisted(() => vi.fn());
const mockOAuth2 = vi.hoisted(() =>
  vi.fn().mockImplementation(() => ({ setCredentials: mockSetCredentials }))
);
const mockCalendar = vi.hoisted(() =>
  vi.fn().mockReturnValue({ events: { insert: mockInsert, delete: mockDelete } })
);

vi.mock("googleapis", () => ({
  google: {
    auth: { OAuth2: mockOAuth2 },
    calendar: mockCalendar,
  },
}));

// calendar.ts reads `./.google-token.json` from disk (gitignored, written
// once by scripts/setup-google-auth.ts) — mocked here so the test doesn't
// depend on that file actually existing in this checkout.
const mockReadFile = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ readFile: mockReadFile }));

import { createCalendarEvent, deleteCalendarEvent, isGoogleCalendarConfigured } from "./calendar";

function mockGoogleCalendarInsertToReturn({ id }: { id: string }) {
  mockInsert.mockResolvedValueOnce({ data: { id } });
}

beforeEach(() => {
  mockInsert.mockReset();
  mockDelete.mockReset();
  mockSetCredentials.mockReset();
  mockOAuth2.mockClear();
  mockCalendar.mockClear();
  mockReadFile.mockReset().mockResolvedValue(
    JSON.stringify({ refresh_token: "fake-refresh-token", access_token: "fake-access-token" })
  );
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/oauth2callback";
});

test("isGoogleCalendarConfigured is false without GOOGLE_CLIENT_ID/SECRET", () => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  expect(isGoogleCalendarConfigured()).toBe(false);
});

test("isGoogleCalendarConfigured is false when only one of the two is set", () => {
  delete process.env.GOOGLE_CLIENT_SECRET;
  expect(isGoogleCalendarConfigured()).toBe(false);
});

test("isGoogleCalendarConfigured is true with both set", () => {
  expect(isGoogleCalendarConfigured()).toBe(true);
});

test("createCalendarEvent returns the created event's id", async () => {
  mockGoogleCalendarInsertToReturn({ id: "evt-abc" });

  const eventId = await createCalendarEvent("Turno con el dentista", new Date("2026-10-31T15:00:00-03:00"));

  expect(eventId).toBe("evt-abc");
});

test("createCalendarEvent builds the OAuth2 client from the saved token file and inserts on the primary calendar", async () => {
  mockGoogleCalendarInsertToReturn({ id: "evt-xyz" });

  await createCalendarEvent("Turno con el dentista", new Date("2026-10-31T15:00:00-03:00"));

  expect(mockOAuth2).toHaveBeenCalledWith(
    "test-client-id",
    "test-client-secret",
    "http://localhost:3000/oauth2callback"
  );
  expect(mockSetCredentials).toHaveBeenCalledWith(
    expect.objectContaining({ refresh_token: "fake-refresh-token" })
  );
  expect(mockCalendar).toHaveBeenCalledWith(expect.objectContaining({ version: "v3" }));
  expect(mockInsert).toHaveBeenCalledWith(
    expect.objectContaining({
      calendarId: "primary",
      requestBody: expect.objectContaining({ summary: "Turno con el dentista" }),
    }),
    expect.objectContaining({ timeout: expect.any(Number) })
  );
});

// A hung network path
// to Google must not block the bot's serialized message queue forever, so
// this call passes an explicit gaxios timeout.
test("createCalendarEvent passes an explicit request timeout to googleapis", async () => {
  mockGoogleCalendarInsertToReturn({ id: "evt-timeout" });

  await createCalendarEvent("Turno con el dentista", new Date("2026-10-31T15:00:00-03:00"));

  const options = mockInsert.mock.calls[0][1];
  expect(options).toEqual(expect.objectContaining({ timeout: expect.any(Number) }));
  expect(options.timeout).toBeGreaterThan(0);
});

test("createCalendarEvent defaults the event duration to 30 minutes from the given start", async () => {
  mockGoogleCalendarInsertToReturn({ id: "evt-30min" });
  const start = new Date("2026-10-31T15:00:00-03:00");

  await createCalendarEvent("Turno con el dentista", start);

  const call = mockInsert.mock.calls[0][0];
  const sentStart = new Date(call.requestBody.start.dateTime);
  const sentEnd = new Date(call.requestBody.end.dateTime);
  expect(sentStart.getTime()).toBe(start.getTime());
  expect(sentEnd.getTime() - sentStart.getTime()).toBe(30 * 60 * 1000);
});

test("createCalendarEvent throws when the token file is missing", async () => {
  mockReadFile.mockReset().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

  await expect(createCalendarEvent("algo", new Date("2026-10-31T15:00:00-03:00"))).rejects.toThrow();
});

test("createCalendarEvent throws when Google Calendar doesn't return an event id", async () => {
  mockInsert.mockResolvedValueOnce({ data: {} });

  await expect(createCalendarEvent("algo", new Date("2026-10-31T15:00:00-03:00"))).rejects.toThrow();
});

test("deleteCalendarEvent deletes the event on the primary calendar and returns 'deleted'", async () => {
  mockDelete.mockResolvedValueOnce({});
  const result = await deleteCalendarEvent("evt-abc");
  expect(result).toBe("deleted");
  expect(mockDelete).toHaveBeenCalledWith(
    expect.objectContaining({ calendarId: "primary", eventId: "evt-abc" }),
    expect.objectContaining({ timeout: expect.any(Number) })
  );
});

test("deleteCalendarEvent returns 'already_gone' when Google reports the event doesn't exist (404)", async () => {
  mockDelete.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { code: 404 }));
  const result = await deleteCalendarEvent("evt-gone");
  expect(result).toBe("already_gone");
});

test("deleteCalendarEvent returns 'already_gone' when the 404 arrives as a string code", async () => {
  mockDelete.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { code: "404" }));
  const result = await deleteCalendarEvent("evt-gone-str");
  expect(result).toBe("already_gone");
});

test("deleteCalendarEvent returns 'already_gone' when the 404 is only on response.status", async () => {
  mockDelete.mockRejectedValueOnce(
    Object.assign(new Error("Not Found"), { response: { status: 404 } })
  );
  const result = await deleteCalendarEvent("evt-gone-resp");
  expect(result).toBe("already_gone");
});

test("deleteCalendarEvent returns 'already_gone' when the 404 is only on status", async () => {
  mockDelete.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }));
  const result = await deleteCalendarEvent("evt-gone-status");
  expect(result).toBe("already_gone");
});

test("deleteCalendarEvent rethrows any other error", async () => {
  mockDelete.mockRejectedValueOnce(Object.assign(new Error("boom"), { code: 500 }));
  await expect(deleteCalendarEvent("evt-x")).rejects.toThrow();
});

// The event's start/end carry an explicit Argentina timeZone and an
// Argentina-offset dateTime, so the event lands at the confirmed wall-clock
// time even when this runs on a UTC server (the production VM).
for (const tz of ["UTC", "Asia/Tokyo"]) {
  test(`createCalendarEvent sends start/end in America/Argentina/Buenos_Aires explicitly (server TZ=${tz})`, async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = tz;
    try {
      mockGoogleCalendarInsertToReturn({ id: "evt-tz" });

      await createCalendarEvent("Turno con el dentista", new Date("2026-11-04T15:00:00-03:00"));

      const { requestBody } = mockInsert.mock.calls[0][0];
      expect(requestBody.start).toEqual({
        dateTime: "2026-11-04T15:00:00-03:00",
        timeZone: "America/Argentina/Buenos_Aires",
      });
      expect(requestBody.end).toEqual({
        dateTime: "2026-11-04T15:30:00-03:00",
        timeZone: "America/Argentina/Buenos_Aires",
      });
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
}
