"use client";

import { useMemo, useState } from "react";
import type { GridRow } from "@/lib/vis-data";

type SortKey = "roi" | "sharpe" | "trades" | "max_dd" | "pnl";

const COLUMNS: { key: SortKey; label: string; format: (g: GridRow) => string }[] = [
  { key: "trades", label: "Trades", format: (g) => g.trades.toLocaleString() },
  { key: "pnl", label: "PnL", format: (g) => `$${g.pnl.toFixed(0)}` },
  { key: "roi", label: "ROI", format: (g) => `${g.roi.toFixed(0)}%` },
  { key: "sharpe", label: "Sharpe", format: (g) => g.sharpe.toFixed(2) },
  { key: "max_dd", label: "Max DD", format: (g) => `${(g.max_dd * 100).toFixed(1)}%` },
];

export function StrategyTable({ grid }: { grid: GridRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("roi");
  const [showRealisticOnly, setShowRealisticOnly] = useState(true);

  const filtered = useMemo(() => {
    const base = showRealisticOnly ? grid.filter((g) => g.realistic) : grid;
    return [...base].sort((a, b) => {
      const va = a[sortKey] as number;
      const vb = b[sortKey] as number;
      return vb - va;
    });
  }, [grid, sortKey, showRealisticOnly]);

  const winner = useMemo(
    () =>
      grid.find(
        (g) =>
          g.realistic &&
          g.compound &&
          g.risk === 0.01 &&
          g.name.startsWith("liq-trend"),
      ),
    [grid],
  );

  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
        <div>
          <div className="text-[0.6rem] uppercase tracking-[0.4em] text-cyan">
            Strategy grid
          </div>
          <h3 className="text-xl font-semibold text-slate-100 mt-1">
            {grid.length} variants · 365-day backtest
          </h3>
        </div>
        <label className="flex items-center gap-2 text-[0.7rem] text-mist cursor-pointer">
          <input
            type="checkbox"
            checked={showRealisticOnly}
            onChange={(e) => setShowRealisticOnly(e.target.checked)}
            className="accent-cyan"
          />
          Realistic only
          <span className="text-[0.6rem] opacity-60">
            (excludes 5%+ compound rows that hit exchange limits)
          </span>
        </label>
      </div>

      <div className="max-h-[480px] overflow-auto rounded-sm border border-edge/40">
        <table className="w-full text-xs">
          <thead className="bg-panel sticky top-0">
            <tr className="text-[0.6rem] uppercase tracking-widest text-mist">
              <th className="text-left px-3 py-2 font-normal">#</th>
              <th className="text-left px-3 py-2 font-normal">Strategy</th>
              <th className="text-right px-3 py-2 font-normal">Risk</th>
              <th className="text-right px-3 py-2 font-normal">Compound</th>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className="text-right px-3 py-2 font-normal cursor-pointer hover:text-slate-200"
                  onClick={() => setSortKey(c.key)}
                >
                  {c.label}
                  {sortKey === c.key ? <span className="text-cyan ml-1">↓</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="num">
            {filtered.map((g, i) => {
              const isWinner = winner && winner.name === g.name && winner.risk === g.risk && winner.compound === g.compound;
              return (
                <tr
                  key={`${g.name}-${g.risk}-${g.compound}`}
                  className={`border-t border-edge/30 transition-colors hover:bg-edge/20 ${
                    isWinner ? "bg-amber/5" : ""
                  }`}
                >
                  <td className="px-3 py-1.5 text-mist">
                    {isWinner ? "👑" : i + 1}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-slate-200">
                    {g.name}
                  </td>
                  <td className="px-3 py-1.5 text-right text-slate-300">
                    {(g.risk * 100).toFixed(1)}%
                  </td>
                  <td className="px-3 py-1.5 text-right text-mist">
                    {g.compound ? "✓" : "—"}
                  </td>
                  {COLUMNS.map((c) => {
                    const v = g[c.key] as number;
                    const tone =
                      c.key === "max_dd"
                        ? v > 0.1
                          ? "text-red"
                          : v > 0.05
                            ? "text-amber"
                            : "text-green"
                        : v >= 0
                          ? "text-green"
                          : "text-red";
                    return (
                      <td key={c.key} className={`px-3 py-1.5 text-right ${tone}`}>
                        {c.format(g)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
