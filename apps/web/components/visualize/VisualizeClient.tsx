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
import { TradeReplay } from "./TradeReplay";
import { StrategyTable } from "./StrategyTable";

export function VisualizeClient() {
  const [equity, setEquity] = useState<EquityPoint[]>([]);
  const [trades, setTrades] = useState<TradePoint[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [grid, setGrid] = useState<GridRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([loadEquity(), loadTrades(), loadSummary(), loadGrid()])
      .then(([e, t, s, g]) => {
        setEquity(e);
        setTrades(t);
        setSummary(s);
        setGrid(g);
      })
      .catch((err) => setErr((err as Error).message));
  }, []);

  if (err) {
    return (
      <div className="panel p-8 text-center">
        <div className="text-[0.65rem] tracking-[0.4em] text-amber uppercase">
          Dataset failed to load
        </div>
        <p className="mt-2 text-mist text-sm">
          {err}. Re-run <code className="num text-cyan">cargo run -p strategy --bin export_vis</code>
          {" "}to regenerate{" "}
          <code className="num text-cyan">apps/web/public/data/*.json</code>.
        </p>
      </div>
    );
  }

  if (!summary || equity.length === 0 || trades.length === 0) {
    return (
      <div className="panel p-8 text-center">
        <div className="text-[0.65rem] tracking-[0.4em] text-cyan uppercase">
          Loading replay…
        </div>
        <p className="mt-2 text-mist text-sm">
          Reading 365 days of equity and trade data.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Hero summary */}
      <section className="panel p-6 md:p-8 relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 opacity-50"
          style={{
            background:
              "radial-gradient(circle at 90% 20%, rgba(34,211,238,0.10), transparent 55%)",
          }}
        />
        <div className="relative">
          <div className="text-[0.6rem] tracking-[0.4em] text-cyan uppercase">
            Pythia · 365-day backtest
          </div>
          <h2 className="mt-2 text-3xl md:text-4xl font-semibold text-slate-100 leading-tight">
            <span className="num">${summary.starting_equity.toFixed(0)}</span>
            <span className="mx-2 text-mist">→</span>
            <span className="text-cyan num">
              ${summary.final_equity.toFixed(0)}
            </span>
            <span className="ml-3 text-base text-mist num">
              +{summary.roi_pct.toFixed(0)}%
            </span>
          </h2>
          <p className="mt-2 text-sm text-mist max-w-2xl">
            {summary.strategy} on {summary.universe}. {summary.n_trades.toLocaleString()} paper
            trades, executed with realistic taker fees, slippage, and funding.
          </p>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-5">
            <Metric
              label="Win rate"
              value={`${(summary.win_rate * 100).toFixed(1)}%`}
              tone="pos"
            />
            <Metric label="Sharpe / trade" value={summary.sharpe.toFixed(2)} tone="cyan" />
            <Metric label="Sortino" value={summary.sortino.toFixed(2)} tone="cyan" />
            <Metric
              label="Profit factor"
              value={summary.profit_factor.toFixed(2)}
              tone="pos"
            />
            <Metric
              label="Max DD"
              value={`${(summary.max_drawdown * 100).toFixed(1)}%`}
              tone="neutral"
            />
          </div>
        </div>
      </section>

      {/* Trade replay — the centrepiece */}
      <TradeReplay equity={equity} trades={trades} />

      {/* Strategy comparison table */}
      <StrategyTable grid={grid} />

      {/* The rule */}
      <section className="panel p-5 md:p-6">
        <div className="text-[0.6rem] tracking-[0.4em] text-cyan uppercase">
          The rule
        </div>
        <h3 className="text-xl font-semibold text-slate-100 mt-1">
          Four conditions. {summary.n_trades.toLocaleString()} trades.{" "}
          {(summary.win_rate * 100).toFixed(0)}% win rate.
        </h3>
        <pre className="mt-4 overflow-auto rounded-sm border border-edge/60 p-4 text-xs md:text-sm text-slate-200 bg-black/40 num leading-relaxed">
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
        <p className="mt-3 text-xs text-mist">
          That's the seed agent. The 25-agent swarm has 5 rule families running
          in parallel — liq-trend, liq-fade, vol-breakout, funding-trend,
          funding-arb. Every {summary.data_points.toLocaleString().split(",")[0]}
          {" "}events the population mutates and the worst agents are replaced.
        </p>
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "pos" | "neg" | "cyan" | "neutral";
}) {
  const c =
    tone === "pos"
      ? "text-green"
      : tone === "neg"
        ? "text-red"
        : tone === "cyan"
          ? "text-cyan"
          : "text-slate-100";
  return (
    <div className="rounded-sm border border-edge/60 bg-black/30 px-3 py-2.5 num">
      <div className="text-[0.55rem] uppercase tracking-widest text-mist">
        {label}
      </div>
      <div className={`mt-0.5 text-xl font-semibold ${c}`}>{value}</div>
    </div>
  );
}
