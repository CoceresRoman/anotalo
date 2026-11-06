"use client";

// Reemplaza el patrón repetido en Gastos/Ingresos/Cuotas/Recordatorios/
// Ideas/Dashboard: un <button> transparente sin padding alrededor de un
// emoji, cuya área clickeable terminaba siendo literalmente el tamaño del
// glifo (muy por debajo del mínimo táctil razonable en mobile, donde esta
// app ya funciona como PWA). 40×40px, no 44, para no inflar de más la
// densidad ya establecida de las tablas existentes.
const iconButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 40,
  height: 40,
  // Sin esto, un hermano flex con texto largo e irrompible (una URL en una
  // idea, por ejemplo) puede encoger el botón por debajo de su área de
  // toque — justo lo que este componente existe para garantizar.
  flexShrink: 0,
  padding: 0,
  background: "transparent",
  borderWidth: 0,
  borderStyle: "none",
  borderRadius: 6,
  cursor: "pointer",
};

export default function IconButton({
  onClick,
  ariaLabel,
  title,
  children,
  style,
}: {
  onClick: () => void;
  ariaLabel: string;
  title?: string;
  children: React.ReactNode;
  // Only for layout concerns the caller's own flex/grid container needs
  // (ex. alignSelf) — never for recoloring or resizing the button itself,
  // that stays centralized here.
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      className="text-ink-faint"
      style={{ ...iconButtonStyle, ...style }}
    >
      {children}
    </button>
  );
}
