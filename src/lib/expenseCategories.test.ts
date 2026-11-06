import { expect, test } from "vitest";
import { EXPENSE_CATEGORIES, mapLegacyCategoryToFixed } from "./expenseCategories";

test("EXPENSE_CATEGORIES incluye Mercado", () => {
  expect(EXPENSE_CATEGORIES).toContain("Mercado");
});

test("mapLegacyCategoryToFixed maps null to Otros", () => {
  expect(mapLegacyCategoryToFixed(null)).toBe("Otros");
});

test("mapLegacyCategoryToFixed leaves an already-fixed category unchanged", () => {
  expect(mapLegacyCategoryToFixed("Comida")).toBe("Comida");
});

for (const [legacy, expected] of [
  ["comida", "Comida"],
  ["super", "Comida"],
  ["transporte", "Transporte"],
  ["nafta", "Transporte"],
  ["salud", "Salud"],
  ["ocio", "Ocio"],
] as const) {
  test(`mapLegacyCategoryToFixed maps legacy "${legacy}" to "${expected}"`, () => {
    expect(mapLegacyCategoryToFixed(legacy)).toBe(expected);
  });
}

test("mapLegacyCategoryToFixed maps an unrecognized category to Otros", () => {
  expect(mapLegacyCategoryToFixed("regalo")).toBe("Otros");
});
