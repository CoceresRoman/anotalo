// Línea fina, sin relleno, `currentColor` como trazo — hereda el color de
// texto (y por lo tanto el tema claro/oscuro) del `className` que lo rodea,
// en vez de depender de la renderización nativa del emoji ✏️ que reemplaza.
export default function EditIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19 3 20l1-4Z" />
    </svg>
  );
}
