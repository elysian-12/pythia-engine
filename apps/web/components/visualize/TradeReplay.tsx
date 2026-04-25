"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { EquityChart } from "./EquityChart";
import type { EquityPoint, TradePoint } from "@/lib/vis-data";

const SPEEDS = [
  { label: "1×", value: 1 },
  { label: "4×", value: 4 },
  { label: "16×", value: 16 },
  { label: "64×", value: 64 },
];

function fmt(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function TradeReplay({
  equity,
  trades,
}: {
  equity: EquityPoint[];
  trades: TradePoint[];
}) {
  const [progress, setProgress] = useState(0); // 0..1
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(16);
  const [cursor, setCursor] = useState<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastT = useRef<number>(performance.now());

  useEffect(() => {
    if (!playing) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }
    const tick = (now: number) => {
      const dt = (now - lastT.current) / 1000;
      lastT.current = now;
      // 0.0033/s × speed = 1.0 over (300/speed)s — at 16× that's ~19s for full replay
      setProgress((p) => {
        const next = Math.min(1, p + dt * 0.0033 * speed);
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    lastT.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, speed]);

  // Loop when finished.
  useEffect(() => {
    if (progress >= 1 && playing) {
      const t = setTimeout(() => setProgress(0), 1500);
      return () => clearTimeout(t);
    }
  }, [progress, playing]);

  const visibleN = Math.max(2, Math.floor(equity.length * progress));
  // Starting equity from the prop, not a hardcoded $1k. When the user
  // bumps their settings on the home page, VisualizeClient rebuilds the
  // equity series from `equity_usd × risk_fraction` and the curve starts
  // at the new floor — the header has to follow.
  const startingEquity = equity[0]?.equity ?? 1000;
  const equityNow = equity[visibleN - 1]?.equity ?? startingEquity;
  const visibleTrades = useMemo(() => {
    const lastTs = equity[visibleN - 1]?.ts ?? 0;
    return trades.filter((t) => t.ts <= lastTs);
  }, [trades, equity, visibleN]);

  const wins = visibleTrades.filter((t) => t.r > 0).length;
  const losses = visibleTrades.length - wins;
  const winRate = visibleTrades.length > 0 ? wins / visibleTrades.length : 0;
  const tsNow = equity[visibleN - 1]?.ts ?? 0;

  const tradeRows = visibleTrades.slice(-10).reverse();

  return (
    <section className="panel p-5 md:p-6">
      <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
        <div>
          <div className="text-[0.6rem] tracking-[0.4em] text-cyan uppercase">
            Trade replay · 365 days
          </div>
          <h3 className="text-xl font-semibold text-slate-100 mt-1">
            ${startingEquity.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            <span className="text-mist mx-2">→</span>
            ${equityNow.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            <span className="text-mist text-sm ml-2">
              {tsNow > 0 ? fmt(tsNow) : ""}
            </span>
          </h3>
        </div>
        <div className="flex items-center gap-2 text-[0.7rem]">
          <button
            onClick={() => setPlaying((p) => !p)}
            className={`chip ${playing ? "chip-cyan" : "chip-mist"} hover:opacity-80`}
          >
            {playing ? "Pause" : "Play"}
          </button>
          {SPEEDS.map((s) => (
            <button
              key={s.value}
              onClick={() => setSpeed(s.value)}
              className={`chip ${speed === s.value ? "chip-cyan" : "chip-mist"} hover:opacity-80`}
            >
              {s.label}
            </button>
          ))}
          <button
            onClick={() => {
              setProgress(0);
              setPlaying(true);
            }}
            className="chip chip-mist hover:opacity-80"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Live counters */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4 text-[0.7rem]">
        <Counter
          label="Trades taken"
          value={visibleTrades.length.toLocaleString()}
        />
        <Counter
          label="Win rate"
          value={`${(winRate * 100).toFixed(1)}%`}
          tone={winRate >= 0.5 ? "pos" : "neg"}
          sub={`${wins}W / ${losses}L`}
        />
        <Counter
          label="Equity"
          value={`$${equityNow.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
          tone="cyan"
        />
        <Counter
          label="Return"
          value={`${(((equityNow - startingEquity) / Math.max(1, startingEquity)) * 100).toFixed(0)}%`}
          tone={equityNow >= startingEquity ? "pos" : "neg"}
        />
      </div>

      {/* Chart */}
      <div className="rounded-sm border border-edge/60 bg-black/30 overflow-hidden">
        <EquityChart
          equity={equity}
          trades={trades}
          progress={progress}
          cursor={cursor}
          onHover={setCursor}
        />
      </div>

      {/* Scrub bar */}
      <div className="mt-3">
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.floor(progress * 1000)}
          onChange={(e) => {
            setPlaying(false);
            setProgress(Number(e.target.value) / 1000);
          }}
          className="w-full accent-cyan"
        />
      </div>

      {/* Recent trades */}
      <div className="mt-5">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[0.6rem] uppercase tracking-widest text-mist">
            Last 10 trades
          </div>
          <div className="text-[0.65rem] text-mist">
            sorted newest first
          </div>
        </div>
        {tradeRows.length === 0 ? (
          <div className="text-[0.7rem] text-mist text-center py-4">
            No trades yet — waiting for the first signal.
          </div>
        ) : (
          <div className="rounded-sm border border-edge/40 divide-y divide-edge/30">
            {tradeRows.map((t, i) => (
              <TradeRow key={`${t.ts}-${t.asset}-${t.dir}-${i}`} t={t} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Counter({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "pos" | "neg" | "cyan";
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
    <div className="rounded-sm border border-edge/60 bg-black/30 px-3 py-2 num">
      <div className="text-[0.55rem] uppercase tracking-widest text-mist">
        {label}
      </div>
      <div className={`mt-0.5 text-base ${c}`}>{value}</div>
      {sub ? <div className="text-[0.6rem] text-mist">{sub}</div> : null}
    </div>
  );
}

function TradeRow({ t }: { t: TradePoint }) {
  const sideColor = t.dir === "LONG" ? "text-green" : "text-red";
  const pnlColor = t.r > 0 ? "text-green" : "text-red";
  return (
    <div className="grid grid-cols-[110px_60px_60px_1fr_70px] items-center gap-2 px-3 py-1.5 text-[0.7rem] num">
      <span className="text-mist">{fmt(t.ts)}</span>
      <span className="font-mono text-slate-200">{t.asset}</span>
      <span className={sideColor}>{t.dir}</span>
      <span className={pnlColor}>
        {t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}
      </span>
      <span className={`text-right ${pnlColor}`}>
        {t.r >= 0 ? "+" : ""}
        {t.r.toFixed(1)}R
      </span>
    </div>
  );
}
