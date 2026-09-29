/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        display: ["Space Grotesk", "ui-sans-serif", "system-ui"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo"],
      },
      boxShadow: {
        ink: "0 1px 2px rgba(20, 22, 28, 0.04), 0 10px 30px var(--shadow-ink)",
      },
    },
  },
  plugins: [],
};
