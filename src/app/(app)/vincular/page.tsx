"use client";

import { useEffect, useState } from "react";

type Estado = { connected: boolean; qrSvg: string | null };

export default function VincularPage() {
  const [estado, setEstado] = useState<Estado | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function fetchEstado() {
      try {
        const res = await fetch("/api/whatsapp/estado");
        if (!res.ok) throw new Error("estado no OK");
        const data = (await res.json()) as Estado;
        if (!cancelled) {
          setEstado(data);
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    }

    fetchEstado();
    // El QR de Baileys expira y se renueva; poll corto para reflejarlo y para
    // pasar a "vinculado" apenas conecta.
    const id = setInterval(fetchEstado, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <main className="bg-cream text-ink p-4 sm:p-6" style={{ maxWidth: 720, margin: "0 auto" }}>
      <h1 className="font-serif text-ink" style={{ fontSize: 28, fontWeight: 600 }}>
        Vincular WhatsApp
      </h1>

      {estado === null && !error && (
        <p className="text-ink-muted" style={{ marginTop: 12 }}>
          Cargando…
        </p>
      )}

      {error && (
        <p className="text-alert" style={{ marginTop: 12 }}>
          No se pudo leer el estado de la conexión. Reintentando…
        </p>
      )}

      {estado?.connected && (
        <p className="font-serif text-ok" style={{ marginTop: 16, fontSize: 18 }}>
          ✓ WhatsApp vinculado. El bot está conectado a tu cuenta.
        </p>
      )}

      {estado && !estado.connected && estado.qrSvg && (
        <div style={{ marginTop: 16 }}>
          <p className="text-ink-muted">
            Abrí WhatsApp en tu teléfono → <strong>Dispositivos vinculados</strong> →{" "}
            <strong>Vincular un dispositivo</strong> y escaneá este código:
          </p>
          <div
            style={{
              marginTop: 16,
              background: "#ffffff",
              padding: 16,
              borderRadius: 8,
              width: "fit-content",
            }}
            // qrSvg viene de nuestro helper (node-qrcode), no es input del
            // usuario; ya incluye la zona de silencio blanca que WhatsApp
            // necesita para leer el código.
            dangerouslySetInnerHTML={{ __html: estado.qrSvg }}
          />
          <p className="text-ink-faint" style={{ marginTop: 12, fontSize: 13 }}>
            El código se renueva solo cada tanto y esta página se actualiza sola.
            Usá preferentemente un número de WhatsApp secundario.
          </p>
        </div>
      )}

      {estado && !estado.connected && !estado.qrSvg && (
        <p className="text-ink-muted" style={{ marginTop: 16 }}>
          Esperando el código QR… Si no aparece en un rato, revisá que el bot esté
          corriendo.
        </p>
      )}
    </main>
  );
}
