import { expect, test } from "vitest";
import { loadConfig } from "./config";

test("defaults match today's hardcoded behavior when env is empty", () => {
  const cfg = loadConfig({});
  expect(cfg).toEqual({
    defaultCurrency: "ARS",
    timezone: "America/Argentina/Buenos_Aires",
    utcOffset: "-03:00",
    locale: "es",
  });
});

test("valid overrides are used as-is", () => {
  const cfg = loadConfig({
    DEFAULT_CURRENCY: "USD",
    APP_TIMEZONE: "America/Sao_Paulo",
    APP_UTC_OFFSET: "-03:00",
    BOT_LOCALE: "en",
  });
  expect(cfg).toEqual({
    defaultCurrency: "USD",
    timezone: "America/Sao_Paulo",
    utcOffset: "-03:00",
    locale: "en",
  });
});

test("invalid DEFAULT_CURRENCY falls back to ARS", () => {
  expect(loadConfig({ DEFAULT_CURRENCY: "us" }).defaultCurrency).toBe("ARS");
  expect(loadConfig({ DEFAULT_CURRENCY: "" }).defaultCurrency).toBe("ARS");
});

test("invalid APP_UTC_OFFSET throws", () => {
  expect(() => loadConfig({ APP_UTC_OFFSET: "GMT-3" })).toThrow(/APP_UTC_OFFSET/);
});

test("empty APP_UTC_OFFSET throws (present-but-malformed, not absent)", () => {
  expect(() => loadConfig({ APP_UTC_OFFSET: "" })).toThrow(/APP_UTC_OFFSET/);
});

test("invalid BOT_LOCALE falls back to es", () => {
  expect(loadConfig({ BOT_LOCALE: "fr" }).locale).toBe("es");
});
