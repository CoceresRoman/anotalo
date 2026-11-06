"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

const STORAGE_KEY = "theme";

function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : null;
  } catch {
    // Private browsing / blocked storage: fall back to no stored preference.
    return null;
  }
}

function writeStoredTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Same as above — the toggle still works for this page load, it just
    // won't be remembered on the next one.
  }
}

// Mounted next to "Cerrar sesión" in both the desktop sidebar and the mobile
// dropdown in AppShell. Reads the saved preference on mount (or defaults to
// light — deliberately never follows the OS/browser's prefers-color-scheme,
// since the app shouldn't switch to dark on its own just because the
// device happens to be in dark mode) and keeps `<html
// data-theme>` plus localStorage in sync with every click.
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const initial = readStoredTheme() ?? "light";
    setTheme(initial);
    document.documentElement.dataset.theme = initial;
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    writeStoredTheme(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Activar modo claro" : "Activar modo oscuro"}
      className="text-ink-muted border-hairline"
      style={{
        padding: "8px 12px",
        borderRadius: 6,
        borderWidth: 1,
        borderStyle: "solid",
        background: "transparent",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      {theme === "dark" ? "Modo claro" : "Modo oscuro"}
    </button>
  );
}
