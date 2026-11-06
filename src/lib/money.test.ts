import { expect, test } from "vitest";
import { formatAmount, formatCents } from "./money";

// formatCents/formatAmount no longer read src/lib/config.ts's `config`
// singleton directly (see money.ts's comment on why: client components
// can't see process.env-derived values) — every test below passes
// currency/locale explicitly instead of mocking config.

test("formatCents renders Argentine pesos exactly as before (ARS/es)", () => {
  expect(formatCents(18430000, "ARS", "es")).toBe("$184.300");
});

test("formatCents follows whatever currency/locale it's given, not just ARS/es", () => {
  // Same minimumFractionDigits toggle as the ARS case: a whole-dollar
  // amount renders without decimals (Intl en-US/USD -> "$50", not "$50.00").
  expect(formatCents(5000, "USD", "en")).toBe("$50");

  // A fractional amount does get the decimals, and follows the USD
  // currency symbol/locale formatting ("$12.50", not pesos-style "$12,50"
  // or "$ 12.50").
  expect(formatCents(1250, "USD", "en")).toBe("$12.50");
});

test("formatAmount formats pesos exactly like formatCents", () => {
  expect(formatAmount(18430000, "ARS", "es")).toBe(formatCents(18430000, "ARS", "es"));
});

// Regression for the Important 1 bug: formatAmount used to special-case
// "ARS" and otherwise slice formatCents's result apart assuming it always
// started with a single-char symbol — which broke for any currency whose
// symbol isn't 1 character (EUR) and ignored the actual default currency
// entirely. It's now just formatMoney with the item's own currency code, so
// it's correct for ANY ISO 4217 code, independent of config.defaultCurrency.
test("formatAmount renders a non-default currency correctly via Intl, not a hardcoded label/slice hack", () => {
  expect(formatAmount(5000, "USD", "es")).toBe(formatCents(5000, "USD", "es"));
  expect(formatAmount(250050, "EUR", "es")).toBe(formatCents(250050, "EUR", "es"));
  expect(formatAmount(2000, "BRL", "es")).toBe(formatCents(2000, "BRL", "es"));
});

test("formatAmount is correct even when the configured default currency isn't ARS", () => {
  // Under a BRL default, a USD amount must render as USD, not "US$ $50"
  // (the old .slice(1) hack's actual failure mode).
  expect(formatAmount(5000, "USD", "en")).toBe("$50");
});
