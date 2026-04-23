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
      },
    },
  },
  plugins: [],
} satisfies Config;
