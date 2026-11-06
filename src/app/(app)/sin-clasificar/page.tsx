"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseAmountToCents } from "../../../lib/money";
import { useRefetchOnFocus } from "../../hooks/useRefetchOnFocus";

type NoteItem = {
  id: string;
  rawText: string;
  source: string;
  createdAt: string;
};

type SinClasificarResponse = {
  items: NoteItem[];
};

type ReclassifyType = "gasto" | "idea" | "recordatorio" | "ingreso" | "ahorro";

function formatCreatedAt(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function SinClasificarPage() {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<NoteItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editType, setEditType] = useState<ReclassifyType>("gasto");
  const [editAmount, setEditAmount] = useState("");
  const [editDatetime, setEditDatetime] = useState("");
  const [editIsSalary, setEditIsSalary] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    fetch("/api/sin-clasificar")
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
        return res.json();
      })
      .then((body: SinClasificarResponse) => {
        if (requestIdRef.current === requestId) setItems(body.items);
      })
      .catch(() => {
        if (requestIdRef.current === requestId)
          setError("No se pudieron cargar las notas sin clasificar.");
      })
      .finally(() => {
        if (requestIdRef.current === requestId) setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useRefetchOnFocus(load);

  const filteredItems = useMemo(() => {
    if (!items) return [];
    const query = search.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) => item.rawText.toLowerCase().includes(query));
  }, [items, search]);

  function startEdit(id: string) {
    setEditingId(id);
    setEditType("gasto");
    setEditAmount("");
    setEditDatetime("");
    setEditIsSalary(false);
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function saveEdit(id: string) {
    const body: Record<string, unknown> = { type: editType };

    if (editType === "gasto") {
      const amountCents = parseAmountToCents(editAmount);
      if (amountCents === null) {
        setEditError("Monto inválido.");
        return;
      }
      body.amountCents = amountCents;
      body.category = null;
    } else if (editType === "ingreso") {
      const amountCents = parseAmountToCents(editAmount);
      if (amountCents === null) {
        setEditError("Monto inválido.");
        return;
      }
      body.amountCents = amountCents;
      body.isSalary = editIsSalary;
    } else if (editType === "ahorro") {
      // Only amountCents: the endpoint takes no isSalary/category for an
      // ahorro (src/app/api/sin-clasificar/[id]/route.ts).
      const amountCents = parseAmountToCents(editAmount);
      if (amountCents === null) {
        setEditError("Monto inválido.");
        return;
      }
      body.amountCents = amountCents;
    } else if (editType === "recordatorio") {
      // The date field is optional: leaving it blank still reclassifies the
      // note as a recordatorio, just with status "ambiguous_no_date" (see
      // src/app/api/sin-clasificar/[id]/route.ts).
      if (editDatetime.trim() !== "") {
        body.parsedDatetime = new Date(editDatetime).toISOString();
      }
    }

    setSaving(true);
    setEditError(null);
    try {
      const res = await fetch(`/api/sin-clasificar/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Request failed with status ${res.status}`);

      setItems((prev) => (prev ? prev.filter((item) => item.id !== id) : prev));
      setEditingId(null);
    } catch {
      setEditError("No se pudo guardar la clasificación.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="bg-cream text-ink p-4 sm:p-6" style={{ maxWidth: 720, margin: "0 auto" }}>
      <h1 className="font-serif text-ink" style={{ fontSize: 28, fontWeight: 600 }}>
        Sin clasificar
      </h1>

      <section style={{ marginTop: 16 }}>
        <input
          type="text"
          placeholder="Buscar notas sin clasificar..."
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
          aria-label="Buscar notas sin clasificar"
        />
      </section>

      {loading && <p className="text-ink-muted">Cargando...</p>}
      {error && (
        <p className="text-alert" style={{ marginTop: 12 }}>
          {error}
        </p>
      )}

      {items && (
        <section style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          {filteredItems.map((item) => {
            const isEditing = editingId === item.id;
            return (
              <article
                key={item.id}
                className="border-hairline"
                style={{ padding: 16, borderWidth: 1, borderStyle: "solid", borderRadius: 8 }}
              >
                <div className="text-ink-faint" style={{ fontSize: 13 }}>
                  {formatCreatedAt(item.createdAt)}
                </div>
                <p className="font-serif text-ink" style={{ margin: "6px 0 0" }}>
                  {item.rawText}
                </p>

                {isEditing ? (
                  <div
                    className="text-ink"
                    style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}
                  >
                    <label>
                      Tipo:{" "}
                      <select
                        value={editType}
                        onChange={(e) => setEditType(e.target.value as ReclassifyType)}
                        className="border-hairline text-ink"
                        style={{ borderWidth: 1, borderStyle: "solid", borderRadius: 6, padding: 4 }}
                      >
                        <option value="gasto">Gasto</option>
                        <option value="idea">Idea</option>
                        <option value="recordatorio">Recordatorio</option>
                        <option value="ingreso">Ingreso</option>
                        <option value="ahorro">Ahorro</option>
                      </select>
                    </label>

                    {(editType === "gasto" || editType === "ingreso" || editType === "ahorro") && (
                      <label>
                        Monto:{" "}
                        <input
                          type="text"
                          inputMode="decimal"
                          value={editAmount}
                          onChange={(e) => setEditAmount(e.target.value)}
                          placeholder="0"
                          className="border-hairline text-ink"
                          style={{ borderWidth: 1, borderStyle: "solid", borderRadius: 6, padding: 4 }}
                        />
                      </label>
                    )}

                    {editType === "ingreso" && (
                      <label>
                        <input
                          type="checkbox"
                          checked={editIsSalary}
                          onChange={(e) => setEditIsSalary(e.target.checked)}
                        />{" "}
                        Es sueldo
                      </label>
                    )}

                    {editType === "recordatorio" && (
                      <label>
                        Fecha:{" "}
                        <input
                          type="datetime-local"
                          value={editDatetime}
                          onChange={(e) => setEditDatetime(e.target.value)}
                          className="border-hairline text-ink"
                          style={{ borderWidth: 1, borderStyle: "solid", borderRadius: 6, padding: 4 }}
                        />
                      </label>
                    )}

                    <div>
                      <button onClick={() => saveEdit(item.id)} disabled={saving} className="text-ink">
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
                    </div>
                    {editError && (
                      <p className="text-alert" style={{ margin: 0 }}>
                        {editError}
                      </p>
                    )}
                  </div>
                ) : (
                  <div style={{ marginTop: 12 }}>
                    <button onClick={() => startEdit(item.id)} className="text-ink">
                      Clasificar
                    </button>
                  </div>
                )}
              </article>
            );
          })}
          {filteredItems.length === 0 && (
            <p className="text-ink-muted">No hay notas sin clasificar que coincidan.</p>
          )}
        </section>
      )}
    </main>
  );
}
