import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pythia — agent-swarm crypto trading",
  description:
    "25 agents compete on liquidations, funding, and volume. Champion drives a paper Hyperliquid trade. PSR / DSR certified, regime-gated, evolved across runs.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink text-slate-200">
        <div className="mx-auto max-w-7xl px-6 py-6">
          <header className="flex items-center justify-between">
            <a href="/" className="block">
              <div className="text-xs text-mist tracking-widest uppercase">Pythia</div>
              <h1 className="text-xl font-semibold">
                Agent-swarm crypto trader · live tournament
              </h1>
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
              <span className="num text-mist">v0.2.0</span>
            </nav>
          </header>
          <main className="mt-8">{children}</main>
          <footer className="mt-12 text-xs text-mist flex items-center justify-between">
            <span>
              Kiyotaka · Binance Futures · Hyperliquid (paper) ·
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
