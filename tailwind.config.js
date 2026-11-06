/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Values point at the CSS custom properties defined in globals.css
        // so every bg-cream/text-ink/etc. class follows the active theme
        // (html[data-theme="dark"] redefines these variables) without any
        // class name changing anywhere in the app.
        cream: "var(--color-cream)",
        ink: "var(--color-ink)",
        "ink-muted": "var(--color-ink-muted)",
        "ink-faint": "var(--color-ink-faint)",
        hairline: "var(--color-hairline)",
        alert: "var(--color-alert)",
        // Muted editorial green, same desaturation as "alert" — used only
        // to mark cuotas already paid this month (a green marker there,
        // not part of the original hairline-only palette otherwise).
        ok: "var(--color-ok)",
      },
      fontFamily: {
        serif: ["Georgia", '"Iowan Old Style"', "serif"],
      },
    },
  },
  plugins: [],
}

