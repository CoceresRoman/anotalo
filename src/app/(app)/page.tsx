"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ConfirmDialog from "../components/ConfirmDialog";
import IconButton from "../components/IconButton";
import TrashIcon from "../components/icons/TrashIcon";
import { formatCents } from "../../lib/money";
import type { BotLocale } from "../../lib/config";
import { useRefetchOnFocus } from "../hooks/useRefetchOnFocus";

type NoteType = "gasto" | "idea" | "recordatorio" | "no_identificado" | "ingreso" | "ahorro";

type RecentNote = {
  id: string;
  type: NoteType;
  rawText: string;
  createdAt: string;
  deletable: boolean;
  deleteTargetId: string;
};

type CategoryExpense = { category: string; amountCents: number };

type DashboardResponse = {
  monthExpenseCents: number;
  ideaCount: number;
  activeReminderCount: number;
  unclassifiedCount: number;
  sueldoCents: number;
  otrosIngresosCents: number;
  ahorroTotalCents: number;
  ahorroMesCents: number;
  saldoCents: number;
  cuotasPendientesCents: number;
  cuotasPagadasCents: number;
  last7DaysExpenses: { date: string; totalCents: number }[];
  expensesByCategory: CategoryExpense[];
  recentNotes: RecentNote[];
  defaultCurrency: string;
  locale: BotLocale;
};

const TYPE_LABELS: Record<NoteType, string> = {
  gasto: "Gasto",
  idea: "Idea",
  recordatorio: "Recordatorio",
  no_identificado: "Sin clasificar",
  ingreso: "Ingreso",
  ahorro: "Ahorro",
};

const CHART_HEIGHT = 120;
const DONUT_SIZE = 160;

// 8 muted editorial tones for the category donut — reuses `alert`/`ok`/
// `ink-faint`/`ink-muted` from tailwind.config.js plus 4 new desaturated
// tones in the same family (no saturated chart-library defaults), enough
// to color 6 fixed categories + "cuotas" + "Sin categoría" distinctly.
const CATEGORY_COLORS = [
  "#c0392b", // alert — terracota
  "#2f6b45", // ok — verde apagado
  "#8a6b3f", // ocre/marrón apagado
  "#3f6b7a", // azul petróleo apagado
  "#6b4c6b", // ciruela apagada
  "#8a8672", // ink-faint — oliva
  "#b0773f", // ámbar apagado
  "#55524a", // ink-muted — taupe
];

function formatCreatedAt(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// `date` is a plain "YYYY-MM-DD" (Argentina calendar day), formatted here by
// splitting the string directly — parsing it with `new Date(date)` would
// read it as UTC midnight and could show the wrong day depending on the
// browser's timezone.
function formatDayLabel(date: string): string {
  const [, month, day] = date.split("-");
  return `${day}/${month}`;
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RecentNote | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    fetch("/api/dashboard")
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
        return res.json();
      })
      .then((body: DashboardResponse) => {
        if (requestIdRef.current === requestId) setData(body);
      })
      .catch(() => {
        if (requestIdRef.current === requestId) setError("No se pudo cargar el resumen.");
      })
      .finally(() => {
        if (requestIdRef.current === requestId) setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useRefetchOnFocus(load);

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    setDeleteError(null);

    const endpoint =
      target.type === "idea"
        ? `/api/ideas/${target.deleteTargetId}`
        : target.type === "recordatorio"
          ? `/api/recordatorios/${target.deleteTargetId}`
          : target.type === "gasto"
            ? `/api/gastos/${target.deleteTargetId}`
            : target.type === "ahorro"
              ? `/api/ahorros/${target.deleteTargetId}`
              : `/api/ingresos/${target.deleteTargetId}`;

    try {
      const res = await fetch(endpoint, { method: "DELETE" });
      if (res.status === 204) {
        setData((prev) =>
          prev
            ? { ...prev, recentNotes: prev.recentNotes.filter((note) => note.id !== target.id) }
            : prev
        );
        return;
      }
      if (res.status === 502 && target.type === "recordatorio") {
        setDeleteError(
          "No se pudo borrar el evento de Google Calendar. El recordatorio no se borró."
        );
        return;
      }
      throw new Error(`Request failed with status ${res.status}`);
    } catch {
      setDeleteError(
        target.type === "idea"
          ? "No se pudo borrar la idea."
          : target.type === "recordatorio"
            ? "No se pudo borrar el recordatorio."
            : target.type === "gasto"
              ? "No se pudo borrar el gasto."
              : target.type === "ahorro"
                ? "No se pudo borrar el ahorro."
                : "No se pudo borrar el ingreso."
      );
    }
  }

  const maxExpenseCents = data
    ? Math.max(1, ...data.last7DaysExpenses.map((d) => d.totalCents))
    : 1;

  const totalCategoryCents = data
    ? data.expensesByCategory.reduce((sum, entry) => sum + entry.amountCents, 0)
    : 0;

  // Each slice's [start%, end%) along the circle, plus its color — the
  // building blocks for both the conic-gradient string and the legend, so
  // the two can never disagree on a percentage.
  let cumulativePercent = 0;
  const categorySlices = data
    ? data.expensesByCategory.map((entry, index) => {
        const percent = totalCategoryCents > 0 ? (entry.amountCents / totalCategoryCents) * 100 : 0;
        const startPercent = cumulativePercent;
        cumulativePercent += percent;
        return {
          ...entry,
          percent,
          startPercent,
          endPercent: cumulativePercent,
          color: CATEGORY_COLORS[index % CATEGORY_COLORS.length],
        };
      })
    : [];

  const donutGradient =
    categorySlices.length > 0
      ? `conic-gradient(${categorySlices
          .map((slice) => `${slice.color} ${slice.startPercent}% ${slice.endPercent}%`)
          .join(", ")})`
      : undefined;

  return (
    <main className="bg-cream text-ink p-4 sm:p-6" style={{ maxWidth: 960, margin: "0 auto" }}>
      <h1 className="font-serif text-ink" style={{ fontSize: 28, fontWeight: 600 }}>
        Dashboard
      </h1>

      {loading && <p className="text-ink-muted">Cargando...</p>}
      {error && (
        <p className="text-alert" style={{ marginTop: 12 }}>
          {error}
        </p>
      )}
      {deleteError && (
        <p className="text-alert" style={{ marginTop: 12 }}>
          {deleteError}
        </p>
      )}

      {data && (
        <>
          <section style={{ display: "flex", gap: 16, marginTop: 16, flexWrap: "wrap" }}>
            <div
              className="border-hairline"
              style={{ flex: "1 1 320px", padding: 20, borderWidth: 2, borderStyle: "solid", borderRadius: 8 }}
            >
              <div className="text-ink-faint" style={{ fontSize: 13 }}>
                Saldo
              </div>
              <h2 className="font-serif text-ink tabular-nums" style={{ margin: "4px 0", fontSize: 36 }}>
                {formatCents(data.saldoCents, data.defaultCurrency, data.locale)}
              </h2>
            </div>
            <div
              className="border-hairline"
              style={{ flex: "1 1 200px", padding: 16, borderWidth: 1, borderStyle: "solid", borderRadius: 8 }}
            >
              <div className="text-ink-faint" style={{ fontSize: 13 }}>
                Sueldo
              </div>
              <h2 className="font-serif text-ink tabular-nums" style={{ margin: "4px 0" }}>
                {formatCents(data.sueldoCents, data.defaultCurrency, data.locale)}
              </h2>
            </div>
            <div
              className="border-hairline"
              style={{ flex: "1 1 200px", padding: 16, borderWidth: 1, borderStyle: "solid", borderRadius: 8 }}
            >
              <div className="text-ink-faint" style={{ fontSize: 13 }}>
                Otros ingresos
              </div>
              <h2 className="font-serif text-ink tabular-nums" style={{ margin: "4px 0" }}>
                {formatCents(data.otrosIngresosCents, data.defaultCurrency, data.locale)}
              </h2>
            </div>
            <div
              className="border-hairline"
              style={{ flex: "1 1 200px", padding: 16, borderWidth: 1, borderStyle: "solid", borderRadius: 8 }}
            >
              <div className="text-ink-faint" style={{ fontSize: 13 }}>
                Ahorros
              </div>
              <h2 className="font-serif text-ink tabular-nums" style={{ margin: "4px 0" }}>
                {formatCents(data.ahorroTotalCents, data.defaultCurrency, data.locale)}
              </h2>
            </div>
            <div
              className="border-hairline"
              style={{ flex: "1 1 200px", padding: 16, borderWidth: 1, borderStyle: "solid", borderRadius: 8 }}
            >
              <div className="text-ink-faint" style={{ fontSize: 13 }}>
                Gastos del mes
              </div>
              <h2 className="font-serif text-ink tabular-nums" style={{ margin: "4px 0" }}>
                {formatCents(data.monthExpenseCents, data.defaultCurrency, data.locale)}
              </h2>
            </div>
            <div
              className="border-hairline"
              style={{ flex: "1 1 200px", padding: 16, borderWidth: 1, borderStyle: "solid", borderRadius: 8 }}
            >
              <div className="text-ink-faint" style={{ fontSize: 13 }}>
                Cuotas pendientes
              </div>
              <h2 className="font-serif text-ink tabular-nums" style={{ margin: "4px 0" }}>
                {formatCents(data.cuotasPendientesCents, data.defaultCurrency, data.locale)}
              </h2>
            </div>
            <div
              className="border-ok"
              style={{ flex: "1 1 200px", padding: 16, borderWidth: 1, borderStyle: "solid", borderRadius: 8 }}
            >
              <div className="text-ok" style={{ fontSize: 13 }}>
                Cuotas pagadas
              </div>
              <h2 className="font-serif text-ok tabular-nums" style={{ margin: "4px 0" }}>
                {formatCents(data.cuotasPagadasCents, data.defaultCurrency, data.locale)}
              </h2>
            </div>
            <div
              className="border-hairline"
              style={{ flex: "1 1 200px", padding: 16, borderWidth: 1, borderStyle: "solid", borderRadius: 8 }}
            >
              <div className="text-ink-faint" style={{ fontSize: 13 }}>
                Ideas
              </div>
              <h2 className="font-serif text-ink" style={{ margin: "4px 0" }}>
                {data.ideaCount}
              </h2>
            </div>
            <div
              className="border-hairline"
              style={{ flex: "1 1 200px", padding: 16, borderWidth: 1, borderStyle: "solid", borderRadius: 8 }}
            >
              <div className="text-ink-faint" style={{ fontSize: 13 }}>
                Recordatorios activos
              </div>
              <h2 className="font-serif text-ink" style={{ margin: "4px 0" }}>
                {data.activeReminderCount}
              </h2>
            </div>
            <div
              className={data.unclassifiedCount > 0 ? "border-alert" : "border-hairline"}
              style={{ flex: "1 1 200px", padding: 16, borderWidth: 1, borderStyle: "solid", borderRadius: 8 }}
            >
              <div
                className={data.unclassifiedCount > 0 ? "text-alert" : "text-ink-faint"}
                style={{ fontSize: 13 }}
              >
                Sin clasificar
              </div>
              <h2
                className={`font-serif ${data.unclassifiedCount > 0 ? "text-alert" : "text-ink"}`}
                style={{ margin: "4px 0" }}
              >
                {data.unclassifiedCount}
              </h2>
            </div>
          </section>

          <section style={{ marginTop: 24 }}>
            <h3 className="font-serif text-ink" style={{ fontSize: 18, fontWeight: 600 }}>
              Gastos de los últimos 7 días
            </h3>
            <div
              className="border-hairline"
              style={{
                borderWidth: 1,
                borderStyle: "solid",
                borderRadius: 8,
                padding: 16,
                marginTop: 8,
                display: "flex",
                alignItems: "flex-end",
                gap: 8,
                height: CHART_HEIGHT + 48,
              }}
            >
              {data.last7DaysExpenses.map((day) => {
                const barHeight = Math.round((day.totalCents / maxExpenseCents) * CHART_HEIGHT);
                return (
                  <div
                    key={day.date}
                    style={{
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "flex-end",
                      height: "100%",
                    }}
                  >
                    <div
                      className="text-ink-faint"
                      style={{ fontSize: 11, marginBottom: 4 }}
                      title={formatCents(day.totalCents, data.defaultCurrency, data.locale)}
                    >
                      {day.totalCents > 0 ? formatCents(day.totalCents, data.defaultCurrency, data.locale) : ""}
                    </div>
                    <div
                      className="bg-alert"
                      style={{
                        width: "100%",
                        height: barHeight,
                        minHeight: day.totalCents > 0 ? 2 : 0,
                        borderRadius: "2px 2px 0 0",
                      }}
                    />
                    <div className="text-ink-faint" style={{ fontSize: 11, marginTop: 6 }}>
                      {formatDayLabel(day.date)}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section style={{ marginTop: 24 }}>
            <h3 className="font-serif text-ink" style={{ fontSize: 18, fontWeight: 600 }}>
              Gastos por categoría
            </h3>
            <div
              className="border-hairline"
              style={{
                borderWidth: 1,
                borderStyle: "solid",
                borderRadius: 8,
                padding: 16,
                marginTop: 8,
                display: "flex",
                alignItems: "center",
                gap: 24,
                flexWrap: "wrap",
              }}
            >
              {categorySlices.length > 0 ? (
                <>
                  <div
                    aria-label="Gráfico de gastos por categoría"
                    style={{
                      width: DONUT_SIZE,
                      height: DONUT_SIZE,
                      borderRadius: "50%",
                      background: donutGradient,
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: "1 1 220px", display: "flex", flexDirection: "column", gap: 8 }}>
                    {categorySlices.map((slice) => (
                      <div
                        key={slice.category}
                        style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}
                      >
                        <span
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: "50%",
                            background: slice.color,
                            flexShrink: 0,
                          }}
                        />
                        <span className="text-ink" style={{ flex: 1 }}>
                          {slice.category}
                        </span>
                        <span className="text-ink-faint tabular-nums">{formatCents(slice.amountCents, data.defaultCurrency, data.locale)}</span>
                        <span className="text-ink-faint" style={{ minWidth: 40, textAlign: "right" }}>
                          {Math.round(slice.percent)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-ink-muted">Todavía no hay gastos categorizados este mes.</p>
              )}
            </div>
          </section>

          <section style={{ marginTop: 24 }}>
            <h3 className="font-serif text-ink" style={{ fontSize: 18, fontWeight: 600 }}>
              Últimas notas
            </h3>
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 12 }}>
              {data.recentNotes.map((note) => (
                <article
                  key={note.id}
                  className="border-hairline"
                  style={{
                    padding: 16,
                    borderWidth: 1,
                    borderStyle: "solid",
                    borderRadius: 8,
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div className="text-ink-faint" style={{ fontSize: 13 }}>
                      <span
                        className="text-ink-muted border-hairline"
                        style={{
                          borderWidth: 1,
                          borderStyle: "solid",
                          borderRadius: 4,
                          padding: "2px 6px",
                          marginRight: 8,
                        }}
                      >
                        {TYPE_LABELS[note.type]}
                      </span>
                      {formatCreatedAt(note.createdAt)}
                    </div>
                    <p className="font-serif text-ink" style={{ margin: "6px 0 0" }}>
                      {note.rawText}
                    </p>
                  </div>
                  {note.deletable && (
                    <IconButton
                      onClick={() => setDeleteTarget(note)}
                      ariaLabel="Borrar nota"
                      style={{ alignSelf: "flex-start" }}
                    >
                      <TrashIcon />
                    </IconButton>
                  )}
                </article>
              ))}
              {data.recentNotes.length === 0 && (
                <p className="text-ink-muted">Todavía no hay notas.</p>
              )}
            </div>
          </section>
        </>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={
          deleteTarget?.type === "idea"
            ? "Borrar idea"
            : deleteTarget?.type === "recordatorio"
              ? "Borrar recordatorio"
              : deleteTarget?.type === "gasto"
                ? "Borrar gasto"
                : deleteTarget?.type === "ahorro"
                  ? "Borrar ahorro"
                  : "Borrar ingreso"
        }
        message="¿Seguro que querés borrar esta nota? Esta acción no se puede deshacer."
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </main>
  );
}
