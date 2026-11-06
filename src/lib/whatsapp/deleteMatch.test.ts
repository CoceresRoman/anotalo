import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import db from "../db";
import { findDeleteCandidates } from "./deleteMatch";

async function seedNote({
  type = "idea",
  rawText = "nota",
  createdAt,
}: {
  type?: string;
  rawText?: string;
  createdAt?: Date;
} = {}) {
  return db.note.create({
    data: {
      rawText,
      source: "text",
      type,
      whatsappMessageId: randomUUID(),
      ...(createdAt ? { createdAt } : {}),
    },
  });
}

function seedIdea(opts: { rawText?: string; createdAt?: Date } = {}) {
  return seedNote({ type: "idea", ...opts });
}

async function seedReminder(opts: { rawText?: string; createdAt?: Date; status?: string } = {}) {
  const note = await seedNote({ type: "recordatorio", rawText: opts.rawText, createdAt: opts.createdAt });
  await db.reminder.create({
    data: {
      noteId: note.id,
      status: opts.status ?? "queued",
      parsedDatetime: null,
    },
  });
  return note;
}

beforeEach(async () => {
  await db.expense.deleteMany();
  await db.reminder.deleteMany();
  await db.note.deleteMany();
});

describe("findDeleteCandidates", () => {
  test("returns 'none' when there are no idea/recordatorio notes at all", async () => {
    const result = await findDeleteCandidates("borrá esa");
    expect(result).toEqual({ kind: "none" });
  });

  test("a pure pronoun request ('borrá esa') matches the single most recent candidate", async () => {
    await seedIdea({ rawText: "app para libros", createdAt: new Date("2026-01-01T00:00:00Z") });
    const recent = await seedIdea({
      rawText: "anotar gastos del viaje",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });

    const result = await findDeleteCandidates("borrá esa");

    expect(result).toEqual({ kind: "single", note: expect.objectContaining({ id: recent.id }) });
  });

  test("a request with a keyword matching exactly one candidate resolves to 'single'", async () => {
    await seedIdea({ rawText: "app para libros" });
    await seedIdea({ rawText: "anotar gastos del viaje" });

    const result = await findDeleteCandidates("borrá la idea de los libros");

    expect(result.kind).toBe("single");
  });

  test("a request with a keyword matching two candidates resolves to 'ambiguous', newest first", async () => {
    const older = await seedIdea({
      rawText: "turno con el dentista",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const newer = await seedIdea({
      rawText: "comprar remedio para el dentista",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });

    const result = await findDeleteCandidates("borrá lo del dentista");

    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.notes.map((n) => n.id)).toEqual([newer.id, older.id]);
    }
  });

  test("a reminder that is awaiting_confirmation/confirming is never a candidate, even if its text matches", async () => {
    await seedReminder({ rawText: "turno con el dentista", status: "awaiting_confirmation" });
    await seedReminder({ rawText: "control con el dentista", status: "confirming" });

    const result = await findDeleteCandidates("borrá lo del dentista");

    expect(result).toEqual({ kind: "none" });
  });

  test("a gasto note is now a valid delete candidate", async () => {
    const gasto = await seedNote({ type: "gasto", rawText: "compré algo del dentista" });

    const result = await findDeleteCandidates("borrá lo del dentista");

    expect(result).toEqual({ kind: "single", note: expect.objectContaining({ id: gasto.id }) });
  });

  test("an ingreso note is now a valid delete candidate", async () => {
    const ingreso = await seedNote({ type: "ingreso", rawText: "cobré honorarios del dentista" });

    const result = await findDeleteCandidates("borrá lo del dentista");

    expect(result).toEqual({ kind: "single", note: expect.objectContaining({ id: ingreso.id }) });
  });

  test("findDeleteCandidates: matchea una nota de tipo ahorro por palabra clave", async () => {
    const ahorro = await seedNote({ type: "ahorro", rawText: "aparté plata del aguinaldo" });

    const result = await findDeleteCandidates("borrá lo del aguinaldo");

    expect(result).toEqual({ kind: "single", note: expect.objectContaining({ id: ahorro.id }) });
  });

  test("a recordatorio still excludes one that is awaiting_confirmation/confirming, unaffected by this change", async () => {
    await seedReminder({ rawText: "turno con el dentista", status: "awaiting_confirmation" });
    const queued = await seedReminder({ rawText: "control con el dentista", status: "queued" });

    const result = await findDeleteCandidates("borrá lo del dentista");

    expect(result).toEqual({ kind: "single", note: expect.objectContaining({ id: queued.id }) });
  });

  test("a request whose keywords match nothing resolves to 'none'", async () => {
    await seedIdea({ rawText: "app para libros" });

    const result = await findDeleteCandidates("borrá la reunión de mañana");

    expect(result).toEqual({ kind: "none" });
  });
  // Final-review finding: since gasto/ingreso joined the candidate pool, a
  // single shared take-limit let frequent recent gastos crowd older
  // ideas/recordatorios out of it entirely. The limit is now applied per
  // note-type group, so an old idea stays a candidate.
  test("an old idea is still a candidate even when there are 20+ more recent gastos", async () => {
    const oldIdea = await seedIdea({
      rawText: "app para libros",
      createdAt: new Date("2025-01-01T00:00:00Z"),
    });
    for (let i = 0; i < 25; i++) {
      await seedNote({
        type: "gasto",
        rawText: `café ${i}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      });
    }

    const result = await findDeleteCandidates("borrá la idea de los libros");

    expect(result).toEqual({ kind: "single", note: expect.objectContaining({ id: oldIdea.id }) });
  });

  test("an old recordatorio is still a candidate even when there are 20+ more recent ingresos", async () => {
    const oldReminder = await seedReminder({
      rawText: "turno con el dentista",
      createdAt: new Date("2025-01-01T00:00:00Z"),
    });
    for (let i = 0; i < 25; i++) {
      await seedNote({
        type: "ingreso",
        rawText: `cobro ${i}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      });
    }

    const result = await findDeleteCandidates("borrá el turno del dentista");

    expect(result).toEqual({ kind: "single", note: expect.objectContaining({ id: oldReminder.id }) });
  });

  test("a pronoun request still picks the single most recent note across both type groups", async () => {
    await seedIdea({ rawText: "app para libros", createdAt: new Date("2026-01-01T00:00:00Z") });
    const newestGasto = await seedNote({
      type: "gasto",
      rawText: "café",
      createdAt: new Date("2026-01-03T00:00:00Z"),
    });
    await seedIdea({ rawText: "otra idea", createdAt: new Date("2026-01-02T00:00:00Z") });

    const result = await findDeleteCandidates("borrá esa");

    expect(result).toEqual({ kind: "single", note: expect.objectContaining({ id: newestGasto.id }) });
  });
});
