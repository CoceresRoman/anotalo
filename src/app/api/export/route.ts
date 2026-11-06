import { NextRequest, NextResponse } from "next/server";
import db from "../../../lib/db";
import { argentinaMonthRange, toArgentinaDateString } from "../../../lib/timezone";

function parseMonthParam(month: string | null): { start: Date; end: Date } | null {
  if (!month) return null;
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1; // Date months are 0-based.
  if (monthIndex < 0 || monthIndex > 11) return null;

  // Argentina calendar month: "2026-10" is Oct 1 00:00 ART up to (not
  // including) Nov 1 00:00 ART — not UTC midnights, and never the server's
  // own local timezone.
  return argentinaMonthRange(year, monthIndex);
}

// Minimal CSV escaping: wrap a field in quotes and double any internal quote
// if it contains a comma, newline, or quote itself.
function csvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// amountCents is always an integer number of cents (see Expense.amountCents
// in prisma/schema.prisma), so this never needs money.ts's locale-formatted
// display string — just a plain decimal with 2 fixed digits, e.g. "3200.00".
function centsToDecimalString(amountCents: number): string {
  return (amountCents / 100).toFixed(2);
}

type CsvRow = {
  fecha: Date;
  tipo: "gasto" | "ingreso";
  categoria: string;
  moneda: string;
  monto: string;
  texto: string;
};

export async function GET(request: NextRequest) {
  const month = request.nextUrl.searchParams.get("month");
  const range = parseMonthParam(month);

  if (!range) {
    return NextResponse.json(
      { error: "Missing or malformed 'month' query param, expected YYYY-MM" },
      { status: 400 }
    );
  }

  const [expenses, incomes] = await Promise.all([
    db.expense.findMany({
      where: { occurredAt: { gte: range.start, lt: range.end } },
      include: { note: true },
    }),
    db.income.findMany({
      where: { occurredAt: { gte: range.start, lt: range.end } },
      include: { note: true },
    }),
  ]);

  const rows: CsvRow[] = [
    ...expenses.map((expense) => ({
      fecha: expense.occurredAt,
      tipo: "gasto" as const,
      categoria: expense.category ?? "",
      moneda: expense.currency,
      monto: centsToDecimalString(expense.amountCents),
      texto: expense.note.rawText,
    })),
    ...incomes.map((income) => ({
      fecha: income.occurredAt,
      tipo: "ingreso" as const,
      categoria: "",
      moneda: income.currency,
      monto: centsToDecimalString(income.amountCents),
      texto: income.note.rawText,
    })),
  ].sort((a, b) => a.fecha.getTime() - b.fecha.getTime());

  const header = ["fecha", "tipo", "categoria", "moneda", "monto", "texto"];
  const lines = [
    header.join(","),
    ...rows.map((row) =>
      [
        toArgentinaDateString(row.fecha),
        row.tipo,
        row.categoria,
        row.moneda,
        row.monto,
        csvField(row.texto),
      ].join(",")
    ),
  ];

  // `texto` is the raw WhatsApp message, which routinely has accented/ñ
  // characters. Excel on Windows (the common way someone opens a
  // downloaded .csv by double-click) doesn't reliably auto-detect UTF-8
  // without a BOM and renders those as mojibake, so prepend it.
  const UTF8_BOM = "﻿";

  return new NextResponse(UTF8_BOM + lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="movimientos-${month}.csv"`,
    },
  });
}
