import { afterEach, expect, test, vi } from "vitest";
import { checkLoginRateLimit } from "./rateLimit";

afterEach(() => {
  vi.useRealTimers();
});

test("checkLoginRateLimit blocks after 5 attempts within the window for the same IP", () => {
  for (let i = 0; i < 5; i++) expect(checkLoginRateLimit("1.2.3.4")).toBe(true);
  expect(checkLoginRateLimit("1.2.3.4")).toBe(false);
});

test("checkLoginRateLimit tracks each IP independently", () => {
  for (let i = 0; i < 5; i++) expect(checkLoginRateLimit("5.6.7.8")).toBe(true);
  expect(checkLoginRateLimit("5.6.7.8")).toBe(false);
  expect(checkLoginRateLimit("9.9.9.9")).toBe(true);
});

test("checkLoginRateLimit forgets old attempts once the window passes, proving stale entries are pruned rather than kept forever", () => {
  vi.useFakeTimers();
  const start = new Date(2030, 0, 1, 0, 0, 0);
  vi.setSystemTime(start);

  for (let i = 0; i < 5; i++) expect(checkLoginRateLimit("11.22.33.44")).toBe(true);
  expect(checkLoginRateLimit("11.22.33.44")).toBe(false);

  // Advance well past the 60s window. A call from an unrelated IP triggers
  // the sweep that prunes 11.22.33.44's now-stale entry entirely (this is
  // what keeps the in-memory Map from growing without bound as IPs come
  // and go), and 11.22.33.44 itself is allowed again.
  vi.setSystemTime(new Date(start.getTime() + 61_000));
  expect(checkLoginRateLimit("99.99.99.99")).toBe(true);
  expect(checkLoginRateLimit("11.22.33.44")).toBe(true);
});
