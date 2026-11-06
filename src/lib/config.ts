// Central app configuration, read from env vars. Every value here defaults
// to exactly today's hardcoded behavior, so an existing instance keeps
// working identically if its .env is never touched.

export type BotLocale = "es" | "en" | "pt";

export interface AppConfig {
  defaultCurrency: string; // ISO 4217, 3 letras mayúsculas
  timezone: string; // nombre IANA, usado como Intl timeZone
  utcOffset: string; // offset fijo, formato "-03:00"
  locale: BotLocale;
}

const DEFAULT_CURRENCY = "ARS";
const DEFAULT_TIMEZONE = "America/Argentina/Buenos_Aires";
const DEFAULT_UTC_OFFSET = "-03:00";
const DEFAULT_LOCALE: BotLocale = "es";

const CURRENCY_RE = /^[A-Z]{3}$/;
const UTC_OFFSET_RE = /^[+-]\d{2}:\d{2}$/;
const VALID_LOCALES: readonly BotLocale[] = ["es", "en", "pt"];

function isBotLocale(value: string): value is BotLocale {
  return (VALID_LOCALES as readonly string[]).includes(value);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const rawCurrency = env.DEFAULT_CURRENCY;
  const defaultCurrency =
    rawCurrency !== undefined && CURRENCY_RE.test(rawCurrency) ? rawCurrency : DEFAULT_CURRENCY;

  // APP_TIMEZONE is used as-is: it's just an IANA label for Intl, and there's
  // no cheap way to "validate" it — Intl.DateTimeFormat already throws on
  // use if it's bogus, no need to duplicate that check here.
  const timezone = env.APP_TIMEZONE !== undefined && env.APP_TIMEZONE !== "" ? env.APP_TIMEZONE : DEFAULT_TIMEZONE;

  const rawUtcOffset = env.APP_UTC_OFFSET;
  let utcOffset = DEFAULT_UTC_OFFSET;
  if (rawUtcOffset !== undefined) {
    // Unlike DEFAULT_CURRENCY/BOT_LOCALE, an empty string here is "present
    // but malformed", not "absent" — it must throw like any other invalid
    // value, since a wrong offset silently corrupts every computed date.
    if (!UTC_OFFSET_RE.test(rawUtcOffset)) {
      throw new Error(`Invalid APP_UTC_OFFSET: "${rawUtcOffset}" (expected format "+HH:MM" or "-HH:MM")`);
    }
    utcOffset = rawUtcOffset;
  }

  const rawLocale = env.BOT_LOCALE;
  const locale = rawLocale !== undefined && isBotLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  return { defaultCurrency, timezone, utcOffset, locale };
}

export const config: AppConfig = loadConfig(process.env);
