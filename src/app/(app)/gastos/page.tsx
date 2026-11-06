"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import IconButton from "../../components/IconButton";
import EditIcon from "../../components/icons/EditIcon";
import TrashIcon from "../../components/icons/TrashIcon";
import { formatAmount, formatCents, parseAmountToCents } from "../../../lib/money";
import type { BotLocale } from "../../../lib/config";
import { useRefetchOnFocus } from "../../hooks/useRefetchOnFocus";
import { CUOTA_EXPENSE_CATEGORY, EXPENSE_CATEGORIES } from "../../../lib/expenseCategories";

type Expense = {
  id: string;
  rawText: string;
  amountCents: number;
  category: string | null;
  // Matches the app's configured default currency unless the message
  // explicitly named another one; only the default currency counts toward
  // the totals (the API already excludes the rest).
  currency: string;
  occurredAt: string;
};

type GastosResponse = {
  totalCents: number;
  byCategory: Record<string, number>;
  items: Expense[];
  defaultCurrency: string;
  locale: BotLocale;
};

const NO_CATEGORY_KEY = "sin_categoria";
const NO_CATEGORY_LABEL = "Sin categoría";

function currentMonth(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${month}`;
}

function categoryLabel(key: string): string {
  return key === NO_CATEGORY_KEY ? NO_CATEGORY_LABEL : key;
}

function formatOccurredAt(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function GastosPage() {
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState<GastosResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Expense | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    fetch(`/api/gastos?month=${month}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
        return res.json();
      })
      .then((body: GastosResponse) => {
        if (requestIdRef.current === requestId) setData(body);
      })
      .catch(() => {
        if (requestIdRef.current === requestId) setError("No se pudieron cargar los gastos.");
      })
      .finally(() => {
        if (requestIdRef.current === requestId) setLoading(false);
      });
  }, [month]);

  useEffect(() => {
    load();
  }, [load]);

  useRefetchOnFocus(load);

  const filteredItems = useMemo(() => {
    if (!data) return [];
    const query = search.trim().toLowerCase();
    if (!query) return data.items;
    return data.items.filter((item) => item.rawText.toLowerCase().includes(query));
  }, [data, search]);

  function startEdit(item: Expense) {
    setEditingId(item.id);
    setEditAmount(String(item.amountCents / 100));
    setEditCategory(item.category ?? "");
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function saveEdit(id: string) {
    const amountCents = parseAmountToCents(editAmount);
    if (amountCents === null) {
      setEditError("Monto inválido.");
      return;
    }

    setSaving(true);
    setEditError(null);
    try {
      // A "cuotas" row never renders the <select> (see the table body below),
      // so editCategory for it is still exactly the value startEdit seeded —
      // "cuotas" — which the API rejects outright. Omit
      // the field entirely for those rows so the amount-only edit doesn't
      // get rejected trying to "change" a category that was never editable.
      const isCuota = editCategory === CUOTA_EXPENSE_CATEGORY;
      const res = await fetch(`/api/gastos/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amountCents,
          category: isCuota ? undefined : editCategory.trim() === "" ? null : editCategory.trim(),
        }),
      });
      if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
      const updated = await res.json();

      setData((prev) => {
        if (!prev) return prev;
        const items = prev.items.map((item) =>
          item.id === id
            ? { ...item, amountCents: updated.amountCents, category: updated.category }
            : item
        );
        return { ...prev, ...recompute(items, prev.defaultCurrency), items };
      });
      setEditingId(null);
    } catch {
      setEditError("No se pudo guardar el cambio.");
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    setDeleteError(null);

    try {
      const res = await fetch(`/api/gastos/${target.id}`, { method: "DELETE" });
      if (res.status === 204) {
        setData((prev) => {
          if (!prev) return prev;
          const items = prev.items.filter((item) => item.id !== target.id);
          return { ...prev, ...recompute(items, prev.defaultCurrency), items };
        });
        return;
      }
      throw new Error(`Request failed with status ${res.status}`);
    } catch {
      setDeleteError("No se pudo borrar el gasto.");
    }
  }

  return (
    <main className="bg-cream text-ink p-4 sm:p-6" style={{ maxWidth: 960, margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <h1 className="font-serif text-ink" style={{ fontSize: 28, fontWeight: 600 }}>
          Gastos
        </h1>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            aria-label="Mes"
            className="border-hairline text-ink"
            style={{ borderWidth: 1, borderStyle: "solid", borderRadius: 6, padding: 4 }}
          />
          <a href={`/api/export?month=${month}`} download className="text-ink">
            Exportar CSV
          </a>
        </div>
      </div>

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
          <section className="flex flex-col sm:flex-row" style={{ gap: 16, marginTop: 16 }}>
            <div
              className="border-hairline"
              style={{ flex: 1, padding: 16, borderWidth: 1, borderStyle: "solid", borderRadius: 8 }}
            >
              <div className="text-ink-faint" style={{ fontSize: 13 }}>
                Total gastado
              </div>
              <h2 className="font-serif text-ink" style={{ margin: "4px 0" }}>
                {formatCents(data.totalCents, data.defaultCurrency, data.locale)}
              </h2>
            </div>
            <div
              className="border-hairline"
              style={{ flex: 2, padding: 16, borderWidth: 1, borderStyle: "solid", borderRadius: 8 }}
            >
              <div className="text-ink-faint" style={{ fontSize: 13 }}>
                Por categoría
              </div>
              <div className="text-ink" style={{ marginTop: 6 }}>
                {Object.entries(data.byCategory)
                  .sort((a, b) => b[1] - a[1])
                  .map(([key, amountCents]) => (
                    <div key={key}>
                      {categoryLabel(key)} — {formatCents(amountCents, data.defaultCurrency, data.locale)}
                    </div>
                  ))}
                {Object.keys(data.byCategory).length === 0 && (
                  <div className="text-ink-muted">Sin gastos este mes.</div>
                )}
              </div>
            </div>
          </section>

          <section style={{ marginTop: 24 }}>
            <input
              type="text"
              placeholder="Buscar en movimientos..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="border-hairline text-ink"
              style={{
                width: "100%",
                padding: 8,
                boxSizing: "border-box",
                borderWidth: 1,
                borderStyle: "solid",
                borderRadius: 6,
              }}
            />
          </section>

          <section style={{ marginTop: 16 }}>
            <h3 className="font-serif text-ink" style={{ fontSize: 18, fontWeight: 600 }}>
              Movimientos recientes
            </h3>
            <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
              <thead>
                <tr className="text-ink-faint" style={{ fontSize: 13 }}>
                  <th style={{ textAlign: "left", fontWeight: 500 }}>Fecha</th>
                  <th style={{ textAlign: "left", fontWeight: 500 }}>Descripción</th>
                  <th style={{ textAlign: "left", fontWeight: 500 }}>Categoría</th>
                  <th style={{ textAlign: "right", fontWeight: 500 }}>Monto</th>
                  <th></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => {
                  const isEditing = editingId === item.id;
                  return (
                    <tr
                      key={item.id}
                      className="border-hairline text-ink"
                      style={{ borderTopWidth: 1, borderTopStyle: "solid" }}
                    >
                      <td className="text-ink-faint" style={{ fontSize: 13, padding: "8px 0" }}>
                        {formatOccurredAt(item.occurredAt)}
                      </td>
                      <td className="font-serif" style={{ padding: "8px 0" }}>
                        {item.rawText}
                      </td>
                      <td style={{ padding: "8px 0" }}>
                        {isEditing ? (
                          item.category === CUOTA_EXPENSE_CATEGORY ? (
                            <span title="La categoría de un pago de cuota no se puede editar.">
                              Cuotas
                            </span>
                          ) : (
                            <select
                              value={editCategory}
                              onChange={(e) => setEditCategory(e.target.value)}
                              className="border-hairline text-ink"
                              style={{
                                width: "100%",
                                borderWidth: 1,
                                borderStyle: "solid",
                                borderRadius: 6,
                                padding: 4,
                              }}
                            >
                              <option value="">{NO_CATEGORY_LABEL}</option>
                              {EXPENSE_CATEGORIES.map((cat) => (
                                <option key={cat} value={cat}>
                                  {cat}
                                </option>
                              ))}
                            </select>
                          )
                        ) : (
                          categoryLabel(item.category ?? NO_CATEGORY_KEY)
                        )}
                      </td>
                      <td className="tabular-nums" style={{ textAlign: "right", padding: "8px 0" }}>
                        {isEditing ? (
                          <input
                            type="text"
                            inputMode="decimal"
                            value={editAmount}
                            onChange={(e) => setEditAmount(e.target.value)}
                            className="border-hairline text-ink tabular-nums"
                            style={{
                              width: 100,
                              textAlign: "right",
                              borderWidth: 1,
                              borderStyle: "solid",
                              borderRadius: 6,
                              padding: 4,
                            }}
                          />
                        ) : (
                          formatAmount(item.amountCents, item.currency, data.locale)
                        )}
                      </td>
                      <td style={{ padding: "8px 0", whiteSpace: "nowrap" }}>
                        {isEditing ? (
                          <>
                            <button
                              onClick={() => saveEdit(item.id)}
                              disabled={saving}
                              className="text-ink"
                            >
                              Guardar
                            </button>
                            <button
                              onClick={cancelEdit}
                              disabled={saving}
                              className="text-ink-muted"
                              style={{ marginLeft: 8 }}
                            >
                              Cancelar
                            </button>
                          </>
                        ) : (
                          <IconButton onClick={() => startEdit(item)} ariaLabel="Editar">
                            <EditIcon />
                          </IconButton>
                        )}
                      </td>
                      <td style={{ padding: "8px 0", whiteSpace: "nowrap" }}>
                        <IconButton onClick={() => setDeleteTarget(item)} ariaLabel="Borrar gasto">
                          <TrashIcon />
                        </IconButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
            {editError && (
              <p className="text-alert" style={{ marginTop: 12 }}>
                {editError}
              </p>
            )}
            {filteredItems.length === 0 && (
              <p className="text-ink-muted">No hay movimientos que coincidan.</p>
            )}
          </section>
        </>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Borrar gasto"
        message="¿Seguro que querés borrar este gasto? Esta acción no se puede deshacer."
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </main>
  );
}

function recompute(
  items: Expense[],
  defaultCurrency: string
): { totalCents: number; byCategory: Record<string, number> } {
  let totalCents = 0;
  const byCategory: Record<string, number> = {};
  for (const item of items) {
    // Same rule as /api/gastos: amounts in another currency are listed,
    // never summed.
    if (item.currency !== defaultCurrency) continue;
    totalCents += item.amountCents;
    const key = item.category ?? NO_CATEGORY_KEY;
    byCategory[key] = (byCategory[key] ?? 0) + item.amountCents;
  }
  return { totalCents, byCategory };
}
