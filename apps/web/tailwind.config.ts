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
        ink: "#0b0f14",
        panel: "#11161e",
        edge: "#1b222d",
        mist: "#94a3b8",
        cyan: "#06b6d4",
        amber: "#f59e0b",
        red: "#ef4444",
        green: "#10b981",
        // Roman royal-emperor purple — Tyrian dye for accents and the
        // "live preview" state. Used sparingly so it reads as ceremonial.
        royal: "#7e22ce",
        ivory: "#f5f0e1",
        marble: "#e9e6dc",
        sand: "#c2a878",
      },
    },
  },
  plugins: [],
} satisfies Config;
