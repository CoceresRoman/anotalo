import { afterEach, beforeEach, expect, test } from "vitest";
import { config } from "./config";
import {
  argentinaDayBoundary,
  argentinaMonthRange,
  toArgentinaDateString,
  toArgentinaIsoString,
} from "./timezone";

// Simulate the production VM's clock (UTC) and a far-off one, so these
// helpers are proven independent of the machine running the tests.
let originalTz: string | undefined;
let originalUtcOffset: string;
beforeEach(() => {
  originalTz = process.env.TZ;
  originalUtcOffset = config.utcOffset;
});
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
  config.utcOffset = originalUtcOffset;
});

for (const tz of ["UTC", "Asia/Tokyo", "America/Argentina/Buenos_Aires"]) {
  test(`toArgentinaIsoString renders Argentina wall-clock time regardless of server TZ (${tz})`, () => {
    process.env.TZ = tz;
    expect(toArgentinaIsoString(new Date("2026-11-04T18:00:00Z"))).toBe("2026-11-04T15:00:00-03:00");
    // 01:30Z on Nov 1 is still Oct 31 in Argentina.
    expect(toArgentinaDateString(new Date("2026-11-01T01:30:00Z"))).toBe("2026-10-31");
    expect(toArgentinaIsoString(new Date("2026-11-01T03:00:00Z"))).toBe("2026-11-01T00:00:00-03:00");
  });
}

test("argentinaMonthRange spans Argentina midnights, including the December rollover", () => {
  process.env.TZ = "UTC";
  const oct = argentinaMonthRange(2026, 9);
  expect(oct.start.toISOString()).toBe("2026-10-01T03:00:00.000Z");
  expect(oct.end.toISOString()).toBe("2026-11-01T03:00:00.000Z");
  const dec = argentinaMonthRange(2026, 11);
  expect(dec.end.toISOString()).toBe("2027-01-01T03:00:00.000Z");
});

test("argentinaDayBoundary returns Argentina start/end of day", () => {
  expect(argentinaDayBoundary("2026-10-28", false).toISOString()).toBe("2026-10-28T03:00:00.000Z");
  expect(argentinaDayBoundary("2026-10-28", true).toISOString()).toBe("2026-10-29T02:59:59.999Z");
});

test("toArgentinaIsoString uses the configured fixed offset, not a hardcoded one", () => {
  process.env.TZ = "UTC";
  config.utcOffset = "-04:00";
  expect(toArgentinaIsoString(new Date("2026-11-04T18:00:00Z"))).toMatch(/-04:00$/);
});
