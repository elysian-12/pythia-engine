import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { PythiaWordmark } from "@/components/brand/PythiaWordmark";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pythia — agent-swarm crypto trading",
  description:
    "An evolving swarm of agents competes on Kiyotaka liquidations, funding, volume, and Polymarket leadership. Champion drives a paper Hyperliquid trade. PSR / DSR certified, regime-gated, evolved across runs.",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
  },
};

// Mobile viewport — without this Safari renders the page at desktop
// width and shrinks-to-fit, which made the tournament hero unreadable
// at 360 px. `width=device-width, initial-scale=1` is the standard
// mobile-friendly viewport; `themeColor` matches `--ink` so the iOS
// status bar blends with the panel.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0b0e",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink text-slate-200">
        {/* Full-width container — the tournament page is a chart-style
            trading dashboard and needs every pixel of horizontal space
            to keep the globe at price-chart size on wide monitors.
            Old max-w-7xl (1280px) capped content at ~37% of a 3456px
            display. No max-width now; padding keeps content off the
            screen edge on ultra-wide. */}
        <div className="px-3 sm:px-6 lg:px-8 py-4 sm:py-6">
          <header className="flex items-center justify-between flex-wrap gap-2">
            <a href="/" className="block group">
              <PythiaWordmark size={36} />
            </a>
            <nav className="flex items-center gap-2 sm:gap-3 text-sm flex-wrap">
              <a
                className="chip chip-mist hover:opacity-80 transition-opacity text-sm px-4 py-2 tracking-wider"
                href="/performance"
              >
                Agent details
              </a>
              <a
                className="chip chip-cyan hover:opacity-90 transition-all hover:scale-[1.03] font-semibold tracking-wider text-sm px-5 py-2.5 ring-1 ring-cyan/40 shadow-[0_0_22px_rgba(34,211,238,0.3)]"
                href="/tournament"
              >
                Open tournament app →
              </a>
              <span className="num text-mist hidden sm:inline">v0.3.0</span>
            </nav>
          </header>
          <main className="mt-6 sm:mt-8">{children}</main>
          <footer className="mt-10 sm:mt-12 text-xs text-mist flex items-center justify-between flex-wrap gap-2">
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
