"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import IconButton from "../../components/IconButton";
import TrashIcon from "../../components/icons/TrashIcon";
import { useRefetchOnFocus } from "../../hooks/useRefetchOnFocus";

type Idea = {
  id: string;
  rawText: string;
  createdAt: string;
};

type IdeasResponse = {
  items: Idea[];
};

function formatCreatedAt(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function IdeasPage() {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<Idea[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Idea | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    const query = search.trim();
    const url = query ? `/api/ideas?q=${encodeURIComponent(query)}` : "/api/ideas";

    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
        return res.json();
      })
      .then((body: IdeasResponse) => {
        if (requestIdRef.current === requestId) setItems(body.items);
      })
      .catch(() => {
        if (requestIdRef.current === requestId) setError("No se pudieron cargar las ideas.");
      })
      .finally(() => {
        if (requestIdRef.current === requestId) setLoading(false);
      });
  }, [search]);

  useEffect(() => {
    load();
  }, [load]);

  useRefetchOnFocus(load);

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    setDeleteError(null);

    try {
      const res = await fetch(`/api/ideas/${target.id}`, { method: "DELETE" });
      if (res.status === 204) {
        setItems((prev) => (prev ? prev.filter((item) => item.id !== target.id) : prev));
        return;
      }
      throw new Error(`Request failed with status ${res.status}`);
    } catch {
      setDeleteError("No se pudo borrar la idea.");
    }
  }

  return (
    <main className="bg-cream text-ink p-4 sm:p-6" style={{ maxWidth: 720, margin: "0 auto" }}>
      <h1 className="font-serif text-ink" style={{ fontSize: 28, fontWeight: 600 }}>
        Ideas
      </h1>

      <section style={{ marginTop: 16 }}>
        <input
          type="text"
          placeholder="Buscar ideas..."
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
          aria-label="Buscar ideas"
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
          {items.map((item) => (
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
                  {formatCreatedAt(item.createdAt)}
                </div>
                <p className="font-serif text-ink" style={{ margin: "6px 0 0" }}>
                  {item.rawText}
                </p>
              </div>
              <IconButton
                onClick={() => setDeleteTarget(item)}
                ariaLabel="Borrar idea"
                style={{ alignSelf: "flex-start" }}
              >
                <TrashIcon />
              </IconButton>
            </article>
          ))}
          {items.length === 0 && <p className="text-ink-muted">No hay ideas que coincidan.</p>}
        </section>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Borrar idea"
        message="¿Seguro que querés borrar esta idea? Esta acción no se puede deshacer."
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </main>
  );
}
