import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { PythiaWordmark } from "@/components/brand/PythiaWordmark";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pythia — agent-swarm crypto trading",
  description:
    "25 agents compete on Kiyotaka liquidations, funding, volume, and Polymarket leadership. Champion drives a paper Hyperliquid trade. PSR / DSR certified, regime-gated, evolved across runs.",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink text-slate-200">
        <div className="mx-auto max-w-7xl px-6 py-6">
          <header className="flex items-center justify-between">
            <a href="/" className="block group">
              <PythiaWordmark size={36} />
            </a>
            <nav className="flex items-center gap-3 text-xs">
              <a
                className="chip chip-cyan hover:opacity-80 transition-opacity"
                href="/tournament"
              >
                Tournament
              </a>
              <a
                className="chip chip-mist hover:opacity-80 transition-opacity"
                href="/visualize"
              >
                Visualize
              </a>
              <span className="num text-mist">v0.3.0</span>
            </nav>
          </header>
          <main className="mt-8">{children}</main>
          <footer className="mt-12 text-xs text-mist flex items-center justify-between">
            <span>
              Kiyotaka · Polymarket · Hyperliquid (paper) ·
              PSR / DSR / regime-gated
            </span>
            <a
              href="https://github.com/anthropics/claude-code"
              className="hover:text-slate-200"
            >
              github
            </a>
          </footer>
        </div>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
