"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import IconButton from "../../components/IconButton";
import EditIcon from "../../components/icons/EditIcon";
import TrashIcon from "../../components/icons/TrashIcon";
import { formatAmount, formatCents, parseAmountToCents } from "../../../lib/money";
import type { BotLocale } from "../../../lib/config";
import { useRefetchOnFocus } from "../../hooks/useRefetchOnFocus";

type Saving = {
  id: string;
  rawText: string;
  amountCents: number;
  // Matches the app's configured default currency unless the message
  // explicitly named another one; only the default currency counts toward
  // mesCents (the API already excludes the rest).
  currency: string;
  occurredAt: string;
};

type AhorrosResponse = {
  // Running, cumulative balance across ALL months — unlike every other
  // money page in this app, this NEVER resets month to month. It's the
  // number the user actually cares about for "can I afford to save up for X".
  totalAcumuladoCents: number;
  // mesCents/items below are scoped to the requested month, same as
  // /api/ingresos — for browsing history month by month.
  mesCents: number;
  items: Saving[];
  defaultCurrency: string;
  locale: BotLocale;
};

function currentMonth(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${month}`;
}

function formatOccurredAt(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AhorrosPage() {
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState<AhorrosResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Saving | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    fetch(`/api/ahorros?month=${month}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
        return res.json();
      })
      .then((body: AhorrosResponse) => {
        if (requestIdRef.current === requestId) setData(body);
      })
      .catch(() => {
        if (requestIdRef.current === requestId) setError("No se pudieron cargar los ahorros.");
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

  function startEdit(item: Saving) {
    setEditingId(item.id);
    setEditAmount(String(item.amountCents / 100));
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
      const res = await fetch(`/api/ahorros/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents }),
      });
      if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
      const updated = await res.json();

      setData((prev) => {
        if (!prev) return prev;
        const previousItem = prev.items.find((item) => item.id === id);
        const items = prev.items.map((item) =>
          item.id === id ? { ...item, amountCents: updated.amountCents } : item
        );
        const delta = previousItem ? updated.amountCents - previousItem.amountCents : 0;
        return {
          ...prev,
          items,
          mesCents: recomputeMes(items, prev.defaultCurrency),
          // The edited row's own amount changed by `delta`, and since it's
          // already counted in totalAcumuladoCents (any currency, any
          // month — see /api/ahorros's GET), the acumulado total shifts by
          // that same delta rather than being recomputed from `items`,
          // which only ever holds the requested month.
          totalAcumuladoCents: prev.totalAcumuladoCents + delta,
        };
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
      const res = await fetch(`/api/ahorros/${target.id}`, { method: "DELETE" });
      if (res.status === 204) {
        setData((prev) => {
          if (!prev) return prev;
          const items = prev.items.filter((item) => item.id !== target.id);
          return {
            ...prev,
            items,
            mesCents: recomputeMes(items, prev.defaultCurrency),
            // Same reasoning as saveEdit: the deleted row was already
            // counted in totalAcumuladoCents, so subtract its own amount
            // rather than recompute from `items` (month-scoped only).
            totalAcumuladoCents: prev.totalAcumuladoCents - target.amountCents,
          };
        });
        return;
      }
      throw new Error(`Request failed with status ${res.status}`);
    } catch {
      setDeleteError("No se pudo borrar el ahorro.");
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
          Ahorros
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
          {/* Total acumulado: a running balance across every month ever
              recorded, never just this one — the whole reason Ahorros is
              different from every other money page in this app. Same
              visual weight as the dashboard's "Saldo" card (font-serif,
              36px, 2px border) so it reads as THE number, not just another
              stat alongside the monthly list below. */}
          <section style={{ marginTop: 16 }}>
            <div
              className="border-hairline"
              style={{ padding: 20, borderWidth: 2, borderStyle: "solid", borderRadius: 8 }}
            >
              <div className="text-ink-faint" style={{ fontSize: 13 }}>
                Total ahorrado
              </div>
              <h2
                className="font-serif text-ink tabular-nums"
                style={{ margin: "4px 0", fontSize: 36 }}
              >
                {formatCents(data.totalAcumuladoCents, data.defaultCurrency, data.locale)}
              </h2>
            </div>
          </section>

          <section style={{ marginTop: 16 }}>
            <div
              className="border-hairline"
              style={{
                display: "inline-block",
                padding: 16,
                borderWidth: 1,
                borderStyle: "solid",
                borderRadius: 8,
              }}
            >
              <div className="text-ink-faint" style={{ fontSize: 13 }}>
                Ahorrado este mes
              </div>
              <h2 className="font-serif text-ink" style={{ margin: "4px 0" }}>
                {formatCents(data.mesCents, data.defaultCurrency, data.locale)}
              </h2>
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
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 480 }}>
              <thead>
                <tr className="text-ink-faint" style={{ fontSize: 13 }}>
                  <th style={{ textAlign: "left", fontWeight: 500 }}>Fecha</th>
                  <th style={{ textAlign: "left", fontWeight: 500 }}>Descripción</th>
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
                        <IconButton onClick={() => setDeleteTarget(item)} ariaLabel="Borrar ahorro">
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
        title="Borrar ahorro"
        message="¿Seguro que querés borrar este ahorro? Esta acción no se puede deshacer."
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </main>
  );
}

function recomputeMes(items: Saving[], defaultCurrency: string): number {
  let mesCents = 0;
  for (const item of items) {
    // Same rule as /api/ahorros: amounts in another currency are listed,
    // never summed into mesCents.
    if (item.currency !== defaultCurrency) continue;
    mesCents += item.amountCents;
  }
  return mesCents;
}
