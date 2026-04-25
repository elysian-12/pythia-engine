"use client";

import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/format";

type Stage = "kiyotaka" | "event" | "swarm" | "champion" | "hl" | "feedback";

type Props = {
  // bump the key to animate a flash across the pipeline — TournamentClient
  // increments on every new event it fires, giving the rail a heartbeat
  pulseKey: number;
  autopilotOn: boolean;
  openCount: number;
  realizedPnl: number;
  generation: number;
  championId: string | null;
  /** Total wall-clock latency of the most recent event-to-trade cycle,
   *  in milliseconds. Surfaced as a "last cycle" badge so the visitor
   *  sees the system actually runs in <2 s end-to-end. */
  lastLatencyMs?: number | null;
};

const STAGES: Array<{ id: Stage; label: string; caption: string }> = [
  {
    id: "kiyotaka",
    label: "Kiyotaka",
    caption: "candles · funding · liquidations · volume · Polymarket",
  },
  {
    id: "event",
    label: "Signal",
    caption: "z-score spike + Polymarket SWP-mid gap",
  },
  { id: "swarm", label: "Swarm", caption: "27 agents vote independently" },
  { id: "champion", label: "Champion", caption: "leaderboard selects the trader" },
  { id: "hl", label: "Hyperliquid", caption: "paper position placed" },
  { id: "feedback", label: "Feedback", caption: "realized R → evolution" },
];

export function PipelineRail({
  pulseKey,
  autopilotOn,
  openCount,
  realizedPnl,
  generation,
  championId,
  lastLatencyMs,
}: Props) {
  const [active, setActive] = useState<Stage | null>(null);

  useEffect(() => {
    if (pulseKey === 0) return;
    // sweep a glow left→right over ~1.5s
    const ids: Stage[] = ["kiyotaka", "event", "swarm", "champion", "hl", "feedback"];
    const timers: ReturnType<typeof setTimeout>[] = [];
    ids.forEach((id, i) => {
      timers.push(setTimeout(() => setActive(id), i * 220));
    });
    timers.push(setTimeout(() => setActive(null), ids.length * 220 + 400));
    return () => timers.forEach(clearTimeout);
  }, [pulseKey]);

  return (
    <div className="panel p-4 relative overflow-hidden">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs uppercase tracking-[0.3em] text-mist">
          Closed-loop pipeline
        </div>
        <div className="flex items-center gap-3 text-[0.65rem] text-mist num">
          <span>
            Autopilot:{" "}
            <span className={autopilotOn ? "text-green" : "text-mist"}>
              {autopilotOn ? "ON" : "OFF"}
            </span>
          </span>
          <span>Gen {generation}</span>
          <span>Open {openCount}</span>
          <span
            className={
              realizedPnl >= 0 ? "text-green" : "text-red"
            }
          >
            {realizedPnl >= 0 ? "+" : ""}${realizedPnl.toFixed(2)}
          </span>
          {/* Last cycle latency. Surfaces the wall-clock event-to-trade
              time; concurrent broadcast keeps this < 2 s end-to-end. */}
          {lastLatencyMs != null ? (
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border ${
                lastLatencyMs < 2000
                  ? "border-green/40 text-green"
                  : "border-amber/40 text-amber"
              }`}
              title="Wall-clock latency from event arrival to paper-trade-sent"
            >
              <span className="w-1 h-1 rounded-full bg-current" />
              last cycle {formatDuration(lastLatencyMs)}
            </span>
          ) : null}
        </div>
      </div>

      <div className="relative flex items-center justify-between gap-2">
        {/* connector line */}
        <div className="absolute top-1/2 left-3 right-3 h-px -translate-y-1/2 bg-edge/70" />
        {STAGES.map((s, i) => (
          <Node
            key={s.id}
            idx={i}
            total={STAGES.length}
            active={active === s.id}
            label={s.label}
            caption={s.caption}
            extra={
              s.id === "champion" && championId
                ? championId
                : undefined
            }
          />
        ))}
      </div>

      <p className="mt-3 text-[0.65rem] text-mist leading-relaxed">
        <span className="text-slate-200">How to read this:</span>{" "}
        something interesting happens in the market — someone gets
        liquidated, funding rates spike, price breaks its recent range,
        or a Polymarket prediction moves before spot does. Kiyotaka
        delivers the tick, the 27 agents each vote on it, the
        leaderboard picks the specialist for this kind of event, a
        paper position opens on Hyperliquid, and when that trade closes
        its win or loss is added back to the scoreboard. Every batch of
        events the worst-performing agents are replaced by tweaked
        copies of the best — so the next tick lands on a slightly
        smarter swarm than the last one.
      </p>
    </div>
  );
}

function Node({
  idx,
  total,
  active,
  label,
  caption,
  extra,
}: {
  idx: number;
  total: number;
  active: boolean;
  label: string;
  caption: string;
  extra?: string;
}) {
  const isLast = idx === total - 1;
  return (
    <div
      className="relative z-10 flex-1 flex flex-col items-center"
      style={{ transition: "transform 0.2s ease" }}
    >
      <div
        className={`w-10 h-10 rounded-full border flex items-center justify-center text-[0.65rem] font-mono transition-all duration-300 ${
          active
            ? "border-cyan bg-cyan/20 text-cyan shadow-[0_0_18px_rgba(34,211,238,0.6)] scale-110"
            : "border-edge bg-black/40 text-mist"
        }`}
      >
        {idx + 1}
      </div>
      <div className="mt-1.5 text-[0.7rem] text-slate-200 text-center leading-tight">
        {label}
      </div>
      <div className="text-[0.6rem] text-mist text-center mt-0.5 max-w-[9rem]">
        {caption}
      </div>
      {extra ? (
        <div className="mt-1 text-[0.6rem] text-amber font-mono truncate max-w-[9rem]">
          {extra}
        </div>
      ) : null}
      {!isLast ? null : null}
    </div>
  );
}
