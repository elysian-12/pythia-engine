"use client";

import { useEffect, useState } from "react";
import {
  loadEquity,
  loadGrid,
  loadSummary,
  loadTrades,
  type EquityPoint,
  type GridRow,
  type Summary,
  type TradePoint,
} from "@/lib/vis-data";
import { GridScatter } from "./GridScatter";
import { HeroCanvas } from "./HeroCanvas";
import { MetricOverlay } from "./MetricOverlay";
import { PipelineFlow } from "./PipelineFlow";

export function VisualizeClient() {
  const [equity, setEquity] = useState<EquityPoint[]>([]);
  const [trades, setTrades] = useState<TradePoint[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [grid, setGrid] = useState<GridRow[]>([]);

  useEffect(() => {
    Promise.all([loadEquity(), loadTrades(), loadSummary(), loadGrid()]).then(
      ([e, t, s, g]) => {
        setEquity(e);
        setTrades(t);
        setSummary(s);
        setGrid(g);
      },
    );
  }, []);

  if (!summary || !equity.length) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center text-mist">
        Loading pythia…
      </div>
    );
  }

  return (
    <>
      <section className="relative h-screen -mx-6 md:-mx-0 overflow-hidden rounded-2xl">
        <HeroCanvas equity={equity} trades={trades} />
        <MetricOverlay summary={summary} />
      </section>

      <PipelineFlow />

      <section className="my-20 mx-auto max-w-6xl px-4">
        <div className="text-xs tracking-[0.3em] text-cyan uppercase text-center">
          Strategy grid
        </div>
        <h2 className="text-3xl md:text-4xl font-semibold text-slate-100 text-center mt-2">
          30 variants · ranked by profitability
        </h2>
        <p className="max-w-2xl mx-auto text-sm text-mist text-center mt-3">
          Every variant in our grid-search plotted in 3D. Green dots are
          realistic (survive exchange-limit + drawdown checks). Amber
          dots are the mathematical ceiling — theoretically achievable,
          practically impossible. The pulsing gold point is the winner:
          liq-trend @ 1 % compound.
        </p>
        <div className="mt-8">
          <GridScatter grid={grid} />
        </div>
      </section>

      <section className="my-20 mx-auto max-w-5xl px-4">
        <div className="panel p-6 md:p-8">
          <div className="text-xs tracking-[0.3em] text-cyan uppercase">
            The trade
          </div>
          <h3 className="text-2xl md:text-3xl font-semibold text-slate-100 mt-2">
            Four rules. 578 trades. 75 % win.
          </h3>
          <pre className="mt-5 overflow-auto rounded-lg border border-edge p-4 text-xs md:text-sm text-slate-200 bg-black/40 num">
{`every hour on BTCUSDT and ETHUSDT:

  net_liq[t] = Σ buy-liq usd - Σ sell-liq usd   for that hour
  z[t]       = (net_liq[t] - mean₄₈ₕ) / std₄₈ₕ

  if |z| > 2.5  AND  last signal on asset ≥ 6 bars ago:
    side = LONG   if z > 0   (shorts wiped → continuation up)
         = SHORT  if z < 0   (longs flushed → continuation down)
  enter at next bar's open
    stop-loss    = entry ∓ 1.5 × ATR(14)
    take-profit  = entry ± 3.0 × ATR(14)
    time-stop    = entry_ts + 4 h
  risk 1 % of current equity per trade   (compounded)
`}
          </pre>
        </div>
      </section>
    </>
  );
}
