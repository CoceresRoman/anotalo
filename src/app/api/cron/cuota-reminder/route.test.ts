import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import db from "../../../../lib/db";

// sendSelfMessage (WhatsApp send) is this route's only external dependency
// besides the DB — mocked here so the route's own contract (secret check,
// empty-vs-pending branching, message content) is tested in isolation from
// WhatsApp. Same mocking pattern as
// src/lib/whatsapp/cuotaPaymentFlow.test.ts.
const mockSendSelfMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../../../lib/whatsapp/connection", () => ({ sendSelfMessage: mockSendSelfMessage }));

import { GET } from "./route";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

beforeEach(async () => {
  await db.recurringPayment.deleteMany();
  await db.expense.deleteMany();
  await db.note.deleteMany();
  await db.recurringItem.deleteMany();
  await db.recurringGroup.deleteMany();
  mockSendSelfMessage.mockReset().mockResolvedValue(undefined);
  process.env.CRON_SECRET = "test-secret";
});

afterEach(() => {
  process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
});

// Local helper, same pattern as src/app/api/export/route.test.ts.
function buildRequest(secret: string | undefined): NextRequest {
  const url =
    secret === undefined
      ? "http://localhost/api/cron/cuota-reminder"
      : `http://localhost/api/cron/cuota-reminder?secret=${encodeURIComponent(secret)}`;
  return new NextRequest(url);
}

test("GET with no secret param returns 401 and never calls sendSelfMessage", async () => {
  const response = await GET(buildRequest(undefined));

  expect(response.status).toBe(401);
  expect(mockSendSelfMessage).not.toHaveBeenCalled();
});

test("GET with a wrong secret returns 401 and never calls sendSelfMessage", async () => {
  const response = await GET(buildRequest("wrong-secret"));

  expect(response.status).toBe(401);
  expect(mockSendSelfMessage).not.toHaveBeenCalled();
});

test("GET with the right secret but CRON_SECRET unset server-side returns 401", async () => {
  delete process.env.CRON_SECRET;

  const response = await GET(buildRequest("test-secret"));

  expect(response.status).toBe(401);
  expect(mockSendSelfMessage).not.toHaveBeenCalled();
});

test("GET with the right secret and pending cuotas sends one message listing their names", async () => {
  // Indefinite (totalInstallments null), started well in the past -> active
  // in any current/future month, and never paid -> always pending.
  await db.recurringItem.create({
    data: {
      name: "Netflix",
      amountCents: 500000,
      startInstallment: 1,
      startYearMonth: "2026-01",
      totalInstallments: null,
    },
  });

  const response = await GET(buildRequest("test-secret"));
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body).toEqual({ sent: true, count: 1 });
  expect(mockSendSelfMessage).toHaveBeenCalledTimes(1);
  expect(mockSendSelfMessage).toHaveBeenCalledWith(expect.stringContaining("Netflix"));
});

test("GET with the right secret and nothing pending returns sent:false and never calls sendSelfMessage", async () => {
  const response = await GET(buildRequest("test-secret"));
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body).toEqual({ sent: false });
  expect(mockSendSelfMessage).not.toHaveBeenCalled();
});
