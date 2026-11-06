"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import ThemeToggle from "./ThemeToggle";

const NAV_ITEMS: { href: string; label: string }[] = [
  { href: "/", label: "Dashboard" },
  { href: "/gastos", label: "Gastos" },
  { href: "/ingresos", label: "Ingresos" },
  { href: "/ahorros", label: "Ahorros" },
  { href: "/cuotas", label: "Cuotas" },
  { href: "/ideas", label: "Ideas" },
  { href: "/recordatorios", label: "Recordatorios" },
  { href: "/sin-clasificar", label: "Sin clasificar" },
  { href: "/vincular", label: "Vincular" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname.startsWith(href);
}

const logoutButtonStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  borderWidth: 1,
  borderStyle: "solid",
  background: "transparent",
  cursor: "pointer",
  textAlign: "left",
};

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  // A route change from tapping a nav link should close the mobile menu
  // instead of leaving it open over the new page.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  function renderLinks(onNavigate?: () => void) {
    return NAV_ITEMS.map((item) => {
      const active = isActive(pathname, item.href);
      return (
        <Link
          key={item.href}
          href={item.href}
          onClick={onNavigate}
          className={active ? "text-ink" : "text-ink-muted"}
          style={{
            padding: "8px 12px",
            borderRadius: 6,
            fontWeight: active ? 600 : 400,
            textDecoration: "none",
          }}
        >
          {item.label}
        </Link>
      );
    });
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* Mobile top bar: replaces the sidebar below the md breakpoint, where
          a fixed 220px sidebar would leave almost no room for content. */}
      <div className="flex items-center justify-between border-b border-hairline bg-cream px-4 py-3 md:hidden">
        <span className="font-serif text-ink" style={{ fontSize: 18, fontWeight: 600 }}>
          Notas
        </span>
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label={menuOpen ? "Cerrar menú" : "Abrir menú"}
          aria-expanded={menuOpen}
          className="text-ink"
          style={{ background: "transparent", border: "none", cursor: "pointer", padding: 4 }}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
          >
            {menuOpen ? (
              <>
                <line x1="5" y1="5" x2="19" y2="19" />
                <line x1="19" y1="5" x2="5" y2="19" />
              </>
            ) : (
              <>
                <line x1="4" y1="7" x2="20" y2="7" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="17" x2="20" y2="17" />
              </>
            )}
          </svg>
        </button>
      </div>

      {menuOpen && (
        <nav className="flex flex-col gap-1 border-b border-hairline bg-cream px-4 py-3 font-serif md:hidden">
          {renderLinks(() => setMenuOpen(false))}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              type="button"
              onClick={handleLogout}
              className="text-ink-muted border-hairline"
              style={{ ...logoutButtonStyle, flex: 1 }}
            >
              Cerrar sesión
            </button>
            <ThemeToggle />
          </div>
        </nav>
      )}

      {/* Desktop sidebar, unchanged from before except for the responsive
          hidden/flex toggle controlling it instead of a bare `display: flex`. */}
      <aside
        className="hidden border-hairline bg-cream font-serif md:flex"
        style={{
          width: 220,
          flexShrink: 0,
          borderRightWidth: 1,
          borderRightStyle: "solid",
          flexDirection: "column",
          padding: "24px 16px",
        }}
      >
        <nav style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
          {renderLinks()}
        </nav>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
          <button
            type="button"
            onClick={handleLogout}
            className="text-ink-muted border-hairline"
            style={logoutButtonStyle}
          >
            Cerrar sesión
          </button>
          <ThemeToggle />
        </div>
      </aside>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}
