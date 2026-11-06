"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import IconButton from "../../components/IconButton";
import EditIcon from "../../components/icons/EditIcon";
import TrashIcon from "../../components/icons/TrashIcon";
import { formatAmount, formatCents, parseAmountToCents } from "../../../lib/money";
import type { BotLocale } from "../../../lib/config";
import { useRefetchOnFocus } from "../../hooks/useRefetchOnFocus";

type Income = {
  id: string;
  rawText: string;
  amountCents: number;
  isSalary: boolean;
  // Matches the app's configured default currency unless the message
  // explicitly named another one; only the default currency counts toward
  // the totals (the API already excludes the rest).
  currency: string;
  occurredAt: string;
};

type IngresosResponse = {
  sueldoCents: number;
  otrosIngresosCents: number;
  items: Income[];
  defaultCurrency: string;
  locale: BotLocale;
};

function currentMonth(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${month}`;
}

function tipoLabel(isSalary: boolean): string {
  return isSalary ? "Sueldo" : "Otro";
}

function formatOccurredAt(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function IngresosPage() {
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState<IngresosResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [editIsSalary, setEditIsSalary] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Income | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    fetch(`/api/ingresos?month=${month}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
        return res.json();
      })
      .then((body: IngresosResponse) => {
        if (requestIdRef.current === requestId) setData(body);
      })
      .catch(() => {
        if (requestIdRef.current === requestId) setError("No se pudieron cargar los ingresos.");
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

  function startEdit(item: Income) {
    setEditingId(item.id);
    setEditAmount(String(item.amountCents / 100));
    setEditIsSalary(item.isSalary);
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
      const res = await fetch(`/api/ingresos/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amountCents,
          isSalary: editIsSalary,
        }),
      });
      if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
      const updated = await res.json();

      setData((prev) => {
        if (!prev) return prev;
        const items = prev.items.map((item) =>
          item.id === id
            ? { ...item, amountCents: updated.amountCents, isSalary: updated.isSalary }
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
      const res = await fetch(`/api/ingresos/${target.id}`, { method: "DELETE" });
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
      setDeleteError("No se pudo borrar el ingreso.");
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
          Ingresos
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
                Sueldo
              </div>
              <h2 className="font-serif text-ink" style={{ margin: "4px 0" }}>
                {formatCents(data.sueldoCents, data.defaultCurrency, data.locale)}
              </h2>
            </div>
            <div
              className="border-hairline"
              style={{ flex: 1, padding: 16, borderWidth: 1, borderStyle: "solid", borderRadius: 8 }}
            >
              <div className="text-ink-faint" style={{ fontSize: 13 }}>
                Otros ingresos
              </div>
              <h2 className="font-serif text-ink" style={{ margin: "4px 0" }}>
                {formatCents(data.otrosIngresosCents, data.defaultCurrency, data.locale)}
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
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
              <thead>
                <tr className="text-ink-faint" style={{ fontSize: 13 }}>
                  <th style={{ textAlign: "left", fontWeight: 500 }}>Fecha</th>
                  <th style={{ textAlign: "left", fontWeight: 500 }}>Descripción</th>
                  <th style={{ textAlign: "left", fontWeight: 500 }}>Tipo</th>
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
                          <label>
                            <input
                              type="checkbox"
                              checked={editIsSalary}
                              onChange={(e) => setEditIsSalary(e.target.checked)}
                            />{" "}
                            Es sueldo
                          </label>
                        ) : (
                          tipoLabel(item.isSalary)
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
                        <IconButton onClick={() => setDeleteTarget(item)} ariaLabel="Borrar ingreso">
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
        title="Borrar ingreso"
        message="¿Seguro que querés borrar este ingreso? Esta acción no se puede deshacer."
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </main>
  );
}

function recompute(
  items: Income[],
  defaultCurrency: string
): { sueldoCents: number; otrosIngresosCents: number } {
  let sueldoCents = 0;
  let otrosIngresosCents = 0;
  for (const item of items) {
    // Same rule as /api/ingresos: amounts in another currency are listed,
    // never summed.
    if (item.currency !== defaultCurrency) continue;
    if (item.isSalary) {
      sueldoCents += item.amountCents;
    } else {
      otrosIngresosCents += item.amountCents;
    }
  }
  return { sueldoCents, otrosIngresosCents };
}
