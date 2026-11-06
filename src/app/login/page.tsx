"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (response.ok) {
        router.push("/");
        return;
      }

      if (response.status === 429) {
        setError("Demasiados intentos. Esperá un minuto y volvé a intentar.");
      } else {
        setError("Usuario o contraseña incorrectos.");
      }
    } catch {
      setError("No se pudo conectar con el servidor. Probá de nuevo.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-cream font-serif px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-12 text-center text-3xl text-ink">Notas</h1>
        <form onSubmit={handleSubmit} className="space-y-8">
          <div>
            <label htmlFor="username" className="block text-sm text-ink-muted">
              Usuario
            </label>
            <input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="mt-1 w-full border-0 border-b border-ink/40 bg-transparent py-2 text-ink focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm text-ink-muted">
              Contraseña
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1 w-full border-0 border-b border-ink/40 bg-transparent py-2 text-ink focus:outline-none"
            />
          </div>
          {error && (
            <p role="alert" className="text-center text-sm text-alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-ink py-3 text-cream disabled:opacity-60"
          >
            {submitting ? "Ingresando…" : "Ingresar"}
          </button>
        </form>
      </div>
    </main>
  );
}
