"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import IconButton from "../../components/IconButton";
import TrashIcon from "../../components/icons/TrashIcon";
import { PENDING_CONFIRMATION_STATUSES, formatParsedDatetime, statusBadge } from "../../../lib/reminders";
import { useRefetchOnFocus } from "../../hooks/useRefetchOnFocus";

type Reminder = {
  id: string;
  rawText: string;
  parsedDatetime: string | null;
  status: string;
  calendarEventId: string | null;
};

type RecordatoriosResponse = {
  items: Reminder[];
};

export default function RecordatoriosPage() {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<Reminder[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Reminder | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    fetch("/api/recordatorios")
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
        return res.json();
      })
      .then((body: RecordatoriosResponse) => {
        if (requestIdRef.current === requestId) setItems(body.items);
      })
      .catch(() => {
        if (requestIdRef.current === requestId) setError("No se pudieron cargar los recordatorios.");
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

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    setDeleteError(null);

    try {
      const res = await fetch(`/api/recordatorios/${target.id}`, { method: "DELETE" });
      if (res.status === 204) {
        setItems((prev) => (prev ? prev.filter((item) => item.id !== target.id) : prev));
        return;
      }
      if (res.status === 502) {
        setDeleteError(
          "No se pudo borrar el evento de Google Calendar. El recordatorio no se borró."
        );
        return;
      }
      if (res.status === 409) {
        setDeleteError(
          "Este recordatorio todavía está pendiente de confirmación y no se puede borrar."
        );
        return;
      }
      throw new Error(`Request failed with status ${res.status}`);
    } catch {
      setDeleteError("No se pudo borrar el recordatorio.");
    }
  }

  return (
    <main className="bg-cream text-ink p-4 sm:p-6" style={{ maxWidth: 720, margin: "0 auto" }}>
      <h1 className="font-serif text-ink" style={{ fontSize: 28, fontWeight: 600 }}>
        Recordatorios
      </h1>

      <section style={{ marginTop: 16 }}>
        <input
          type="text"
          placeholder="Buscar recordatorios..."
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
          aria-label="Buscar recordatorios"
        />
      </section>

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

      {items && (
        <section style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          {filteredItems.map((item) => (
            <article
              key={item.id}
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
                  {formatParsedDatetime(item.parsedDatetime)} · {statusBadge(item.status, item.calendarEventId)}
                </div>
                <p className="font-serif text-ink" style={{ margin: "6px 0 0" }}>
                  {item.rawText}
                </p>
              </div>
              {!PENDING_CONFIRMATION_STATUSES.includes(item.status) && (
                <IconButton
                  onClick={() => setDeleteTarget(item)}
                  ariaLabel="Borrar recordatorio"
                  style={{ alignSelf: "flex-start" }}
                >
                  <TrashIcon />
                </IconButton>
              )}
            </article>
          ))}
          {filteredItems.length === 0 && <p className="text-ink-muted">No hay recordatorios que coincidan.</p>}
        </section>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Borrar recordatorio"
        message="¿Seguro que querés borrar este recordatorio? Esta acción no se puede deshacer."
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </main>
  );
}
