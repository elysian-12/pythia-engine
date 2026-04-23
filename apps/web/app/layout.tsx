import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pythia — Prediction markets as crypto's leading indicator",
  description:
    "Smart-money-weighted Polymarket signal engine for BTC and ETH perps. Hasbrouck information share, Granger causality, and live provenance.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink text-slate-200">
        <div className="mx-auto max-w-7xl px-6 py-6">
          <header className="flex items-center justify-between">
            <div>
              <div className="text-xs text-mist tracking-widest uppercase">Pythia</div>
              <h1 className="text-xl font-semibold">
                Prediction markets as crypto&apos;s leading indicator
              </h1>
            </div>
            <div className="text-xs text-mist">
              <span className="chip chip-cyan">Live</span>
              <span className="ml-2 num">v0.1.0</span>
            </div>
          </header>
          <main className="mt-8">{children}</main>
          <footer className="mt-12 text-xs text-mist">
            Hasbrouck IS · Engle–Granger · skill-weighted SWP · BTC/ETH perps ·
            paper-traded
          </footer>
        </div>
      </body>
    </html>
  );
}
