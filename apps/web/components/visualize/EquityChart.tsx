"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { EquityPoint, TradePoint } from "@/lib/vis-data";

type Props = {
  equity: EquityPoint[];
  trades: TradePoint[];
  /** 0..1 — how far through the dataset to draw (used for replay). */
  progress: number;
  /** Hover cursor position in [0, 1]. null = no cursor. */
  cursor: number | null;
  onHover: (idx: number | null) => void;
  height?: number;
};

const PAD = { top: 18, right: 64, bottom: 28, left: 70 };

function fmtUsd(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "2-digit",
  });
}

export function EquityChart({
  equity,
  trades,
  progress,
  cursor,
  onHover,
  height = 360,
}: Props) {
  const [width, setWidth] = useState(900);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const visibleN = Math.max(2, Math.floor(equity.length * progress));
  const drawPoints = equity.slice(0, visibleN);

  const xMin = equity[0]?.ts ?? 0;
  const xMax = equity[equity.length - 1]?.ts ?? 1;
  const yMin = 1000; // starting equity floor
  const yMax = useMemo(
    () => Math.max(...equity.map((p) => p.equity)) * 1.05,
    [equity],
  );

  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const xScale = (t: number) =>
    PAD.left + ((t - xMin) / Math.max(1, xMax - xMin)) * innerW;
  const yScale = (v: number) =>
    PAD.top + (1 - (v - yMin) / Math.max(1, yMax - yMin)) * innerH;

  const path = drawPoints
    .map((p, i) => `${i === 0 ? "M" : "L"}${xScale(p.ts).toFixed(1)},${yScale(p.equity).toFixed(1)}`)
    .join(" ");

  const hoverIdx =
    cursor != null
      ? Math.max(0, Math.min(visibleN - 1, Math.floor(visibleN * cursor)))
      : null;
  const hoverPt = hoverIdx != null ? drawPoints[hoverIdx] : null;

  // Find the most recent N trades up to the visible window for the markers.
  const lastTs = drawPoints[drawPoints.length - 1]?.ts ?? 0;
  const visibleTrades = trades.filter((t) => t.ts <= lastTs);
  const recent = visibleTrades.slice(-12);

  // Y-axis ticks
  const yTicks = useMemo(() => {
    const ticks: number[] = [];
    const step = Math.pow(10, Math.floor(Math.log10(yMax)));
    for (let v = 0; v <= yMax; v += step) ticks.push(v);
    return ticks;
  }, [yMax]);

  return (
    <div
      ref={containerRef}
      className="relative w-full"
      onMouseLeave={() => onHover(null)}
    >
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
          const x = e.clientX - rect.left;
          const u = (x - PAD.left) / innerW;
          if (u < 0 || u > 1) return onHover(null);
          onHover(u);
        }}
      >
        <defs>
          <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* Y grid */}
        {yTicks.map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={yScale(v)}
              y2={yScale(v)}
              stroke="#1b222d"
              strokeDasharray="2 4"
            />
            <text
              x={PAD.left - 8}
              y={yScale(v) + 4}
              textAnchor="end"
              className="fill-mist"
              style={{ fontSize: 10, fontFamily: "JetBrains Mono, monospace" }}
            >
              {fmtUsd(v)}
            </text>
          </g>
        ))}

        {/* X bounds labels */}
        {equity.length > 0 ? (
          <>
            <text
              x={PAD.left}
              y={height - 8}
              className="fill-mist"
              style={{ fontSize: 10, fontFamily: "JetBrains Mono, monospace" }}
            >
              {fmtDate(equity[0].ts)}
            </text>
            <text
              x={width - PAD.right}
              y={height - 8}
              textAnchor="end"
              className="fill-mist"
              style={{ fontSize: 10, fontFamily: "JetBrains Mono, monospace" }}
            >
              {fmtDate(equity[equity.length - 1].ts)}
            </text>
          </>
        ) : null}

        {/* Equity area + line */}
        {drawPoints.length > 1 ? (
          <>
            <path
              d={`${path} L${xScale(drawPoints[drawPoints.length - 1].ts)},${yScale(yMin)} L${xScale(drawPoints[0].ts)},${yScale(yMin)} Z`}
              fill="url(#eqFill)"
            />
            <path d={path} fill="none" stroke="#22d3ee" strokeWidth={1.7} />
          </>
        ) : null}

        {/* Recent-trade markers (showing flow visually) */}
        {recent.map((t) => (
          <g key={`${t.ts}-${t.asset}-${t.dir}`}>
            <circle
              cx={xScale(t.ts)}
              cy={yScale(equity.find((p) => p.ts >= t.ts)?.equity ?? yMin)}
              r={3}
              fill={t.r > 0 ? "#34d399" : "#f87171"}
              fillOpacity={0.6}
              stroke={t.r > 0 ? "#34d399" : "#f87171"}
              strokeWidth={1}
            />
          </g>
        ))}

        {/* Cursor */}
        {hoverPt ? (
          <g>
            <line
              x1={xScale(hoverPt.ts)}
              x2={xScale(hoverPt.ts)}
              y1={PAD.top}
              y2={height - PAD.bottom}
              stroke="#94a3b855"
              strokeDasharray="2 2"
            />
            <circle
              cx={xScale(hoverPt.ts)}
              cy={yScale(hoverPt.equity)}
              r={5}
              fill="#22d3ee"
              fillOpacity={0.4}
              stroke="#22d3ee"
            />
          </g>
        ) : null}
      </svg>

      {/* Hover tooltip */}
      {hoverPt ? (
        <div
          className="pointer-events-none absolute panel px-3 py-2 text-[0.7rem] num"
          style={{
            left: Math.min(
              width - 170,
              xScale(hoverPt.ts) + 10,
            ),
            top: PAD.top + 4,
          }}
        >
          <div className="text-mist text-[0.6rem] uppercase tracking-widest">
            {fmtDate(hoverPt.ts)}
          </div>
          <div className="text-cyan text-base">${hoverPt.equity.toFixed(0)}</div>
          <div className="text-mist text-[0.6rem]">
            {(((hoverPt.equity - 1000) / 1000) * 100).toFixed(0)}% gain
          </div>
        </div>
      ) : null}
    </div>
  );
}
