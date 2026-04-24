"use client";

import { useMemo } from "react";
import type { PaperPosition } from "@/lib/paper";
import { realizedPnl, sumRealized, unrealizedPnl } from "@/lib/paper";

type Props = {
  open: PaperPosition[];
  closed: PaperPosition[];
  marks: { BTC: number | null; ETH: number | null };
  equity_usd: number;
  onClose: (id: string) => void;
  onReset?: () => void;
};

export function HyperliquidPanel({
  open,
  closed,
  marks,
  equity_usd,
  onClose,
  onReset,
}: Props) {
  const realized = useMemo(() => sumRealized(closed), [closed]);
  const unrealized = useMemo(
    () =>
      open.reduce((a, p) => {
        const m = p.asset === "BTC" ? marks.BTC : marks.ETH;
        if (m == null) return a;
        return a + unrealizedPnl(p, m);
      }, 0),
    [open, marks],
  );

  const totalPnl = realized + unrealized;
  const equityLive = equity_usd + totalPnl;
  const wins = closed.filter((p) => realizedPnl(p) > 0).length;
  const losses = closed.length - wins;
  const winRate = closed.length > 0 ? wins / closed.length : 0;

  return (
    <div className="panel p-5 relative overflow-hidden">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-cyan animate-pulse" />
          <div className="text-xs uppercase tracking-[0.3em] text-mist">
            Hyperliquid paper
          </div>
        </div>
        <div className="flex items-center gap-2 text-[0.65rem] text-mist num">
          <MarkChip asset="BTC" px={marks.BTC} />
          <MarkChip asset="ETH" px={marks.ETH} />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 text-[0.7rem] num mb-4">
        <Stat label="Equity" value={`$${equityLive.toFixed(0)}`} tone="neutral" />
        <Stat
          label="Realized"
          value={`${realized >= 0 ? "+" : ""}$${realized.toFixed(2)}`}
          tone={realized >= 0 ? "pos" : "neg"}
        />
        <Stat
          label="Unrealized"
          value={`${unrealized >= 0 ? "+" : ""}$${unrealized.toFixed(2)}`}
          tone={unrealized >= 0 ? "pos" : "neg"}
        />
        <Stat
          label="Win rate"
          value={`${(winRate * 100).toFixed(0)}% (${wins}W/${losses}L)`}
          tone="neutral"
        />
      </div>

      <div className="text-[0.7rem] uppercase tracking-wider text-mist mb-2">
        Open positions · {open.length}
      </div>
      {open.length === 0 ? (
        <div className="rounded-sm border border-edge/60 bg-black/20 px-3 py-4 text-center text-[0.75rem] text-mist">
          Flat. When the champion fires on an autopilot signal, the paper
          position opens here with stop + TP wired up.
        </div>
      ) : (
        <div className="space-y-2">
          {open.map((p) => {
            const m = p.asset === "BTC" ? marks.BTC : marks.ETH;
            const pnl = m != null ? unrealizedPnl(p, m) : 0;
            return (
              <PositionRow
                key={p.id}
                p={p}
                mark={m}
                pnl={pnl}
                onClose={() => onClose(p.id)}
              />
            );
          })}
        </div>
      )}

      {closed.length > 0 ? (
        <div className="mt-5">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[0.7rem] uppercase tracking-wider text-mist">
              Closed · {closed.length}
            </div>
            {onReset ? (
              <button
                onClick={onReset}
                className="text-[0.65rem] text-mist hover:text-red transition-colors"
              >
                Reset session
              </button>
            ) : null}
          </div>
          <div className="max-h-48 overflow-auto space-y-1 pr-1">
            {[...closed]
              .reverse()
              .slice(0, 30)
              .map((p) => (
                <ClosedRow key={p.id} p={p} />
              ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MarkChip({ asset, px }: { asset: "BTC" | "ETH"; px: number | null }) {
  return (
    <span className="inline-flex items-center gap-1 text-mist">
      <span className="font-mono">{asset}</span>
      <span className={px != null ? "text-slate-100" : "text-mist"}>
        {px != null
          ? `$${px.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
          : "—"}
      </span>
    </span>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "pos" | "neg" | "neutral";
}) {
  const color =
    tone === "pos" ? "text-green" : tone === "neg" ? "text-red" : "text-slate-100";
  return (
    <div className="rounded-sm border border-edge/60 bg-black/20 px-2 py-1.5">
      <div className="text-[0.6rem] uppercase tracking-wider text-mist">
        {label}
      </div>
      <div className={`mt-0.5 text-sm ${color}`}>{value}</div>
    </div>
  );
}

function PositionRow({
  p,
  mark,
  pnl,
  onClose,
}: {
  p: PaperPosition;
  mark: number | null;
  pnl: number;
  onClose: () => void;
}) {
  const pnlPct = (pnl / p.notional_usd) * 100;
  const sideColor = p.side === "long" ? "text-green" : "text-red";
  const pnlColor = pnl >= 0 ? "text-green" : "text-red";

  return (
    <div className="rounded-sm border border-edge/60 bg-black/30 px-3 py-2 text-[0.75rem]">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 font-mono">
            <span className="text-slate-100">{p.asset}</span>
            <span className={sideColor}>{p.side.toUpperCase()}</span>
            <span className="text-mist num">
              {p.size_contracts.toFixed(4)}
            </span>
            <span className="text-mist">·</span>
            <span className="num text-mist">
              ${p.notional_usd.toFixed(0)}
            </span>
          </div>
          <div className="mt-1 text-[0.65rem] text-mist">
            by <span className="font-mono text-slate-300">{p.agent_id}</span>
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-[0.65rem] text-mist hover:text-red transition-colors px-2 py-0.5 border border-edge rounded-sm"
        >
          Close
        </button>
      </div>
      <div className="grid grid-cols-4 gap-2 mt-2 text-[0.65rem] num">
        <div>
          <div className="text-mist">Entry</div>
          <div>${p.entry.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-mist">Mark</div>
          <div>{mark != null ? `$${mark.toFixed(2)}` : "—"}</div>
        </div>
        <div>
          <div className="text-mist">Stop / TP</div>
          <div>
            <span className="text-red">${p.stop.toFixed(0)}</span>
            <span className="text-mist"> / </span>
            <span className="text-green">${p.take_profit.toFixed(0)}</span>
          </div>
        </div>
        <div>
          <div className="text-mist">Unrealized</div>
          <div className={pnlColor}>
            {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
            <span className="text-mist"> ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%)</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ClosedRow({ p }: { p: PaperPosition }) {
  const pnl = realizedPnl(p);
  const pnlColor = pnl >= 0 ? "text-green" : "text-red";
  const reasonChip = {
    stop: "text-red",
    tp: "text-green",
    manual: "text-mist",
  }[p.close_reason ?? "manual"];
  return (
    <div className="flex items-center justify-between text-[0.7rem] num px-2 py-1 rounded-sm bg-black/20">
      <div className="flex items-center gap-2">
        <span className="font-mono text-slate-200">{p.asset}</span>
        <span className={p.side === "long" ? "text-green" : "text-red"}>
          {p.side === "long" ? "↑" : "↓"}
        </span>
        <span className="text-mist">{p.agent_id}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className={`text-[0.6rem] uppercase ${reasonChip}`}>
          {p.close_reason}
        </span>
        <span className={pnlColor}>
          {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
        </span>
      </div>
    </div>
  );
}
