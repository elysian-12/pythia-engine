import type { Config } from "tailwindcss";

export default {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ["JetBrains Mono", "ui-monospace", "SF Mono", "monospace"],
      },
      colors: {
        ink: "#0b0a14",          // tinted very faint purple-black
        panel: "#13111d",        // panel with a violet undertone
        edge: "#241c33",         // edge: violet-grey
        mist: "#a394b8",         // body text on dark — warmer mist
        // Primary accent — Tyrian / royal purple (Caesar's stripe).
        royal: "#a855f7",
        // Imperial gold — laurel + senate detail.
        amber: "#fbbf24",
        // Status — survives because traders need green/red regardless of theme.
        red: "#ef4444",
        green: "#10b981",
        // Cyan demoted to "informational" / live-pulse only.
        cyan: "#67e8f9",
        ivory: "#f5f0e1",
        marble: "#e9e6dc",
        sand: "#c2a878",
      },
    },
  },
  plugins: [],
} satisfies Config;
