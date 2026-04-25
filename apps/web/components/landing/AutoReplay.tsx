"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  agentFamily,
  FAMILY_COLORS,
  type SwarmSnapshot,
} from "@/lib/swarm";
import {
  simulateReactions,
  type SimEvent,
  type SimReaction,
} from "@/lib/simulate";

/**
 * Auto-looping demo on the landing page. Generates synthetic events on a
 * fixed cadence, walks through the closed-loop pipeline (event → swarm →
 * champion → trade → PnL), and resets to event-1 once the demo run reaches
 * its target length. The point is to give a first-time visitor a clear,
 * always-on visualisation of the trading flow without needing to start the
 * Rust backtest or click into the tournament page.
 *
 * Math is intentionally simplified — this is a reactive *story*, not a
 * statistical model. Real positions are sized + scored by the Rust core.
 */

type Stage =
  | "event-fired"
  | "swarm-voting"
  | "champion-locked"
  | "executed"
  | "settled";

type DemoTrade = {
  id: string;
  ev: SimEvent;
  championId: string | null;
  direction: "long" | "short" | null;
  rPnl: number; // realised R after settle (0 while open)
  outcome: "win" | "loss" | "skip" | "pending";
  voted_long: number;
  voted_short: number;
  voted_total: number;
};

const TICK_MS = 1100;
const STAGES: Stage[] = [
  "event-fired",
  "swarm-voting",
  "champion-locked",
  "executed",
  "settled",
];

function generateEvent(seed: number): SimEvent {
  const kinds: SimEvent["kind"][] = ["liq-spike", "vol-breakout", "funding-spike"];
  const assets: SimEvent["asset"][] = ["BTC", "ETH"];
  const dir: SimEvent["direction"] = Math.sin(seed * 12.9898) > 0 ? "long" : "short";
  const z = 2.0 + Math.abs(Math.cos(seed * 78.233)) * 1.6; // 2.0 .. 3.6
  return {
    id: `demo-${seed}`,
    ts: Math.floor(Date.now() / 1000),
    asset: assets[seed % 2],
    kind: kinds[seed % 3],
    magnitude_z: z,
    direction: dir,
  };
}

/** Deterministic R outcome for the demo — heavier tail toward champion's win
 *  rate so visitors see a realistic mix without hard-coding wins.
 *  champion's empirical win rate ~0.60 → outcomes ~ +1.5R / -1.0R. */
function settleTrade(seed: number, championWinRate: number): number {
  const u = Math.abs(Math.sin(seed * 91.347)) % 1; // pseudo-random uniform
  if (u < championWinRate) return 1.5; // TP
  return -1.0; // stop
}

export function AutoReplay({ snap }: { snap: SwarmSnapshot | null }) {
  const [seed, setSeed] = useState(1);
  const [stage, setStage] = useState<Stage>("event-fired");
  const [trades, setTrades] = useState<DemoTrade[]>([]);
  const [running, setRunning] = useState(true);
  const [reactions, setReactions] = useState<SimReaction[]>([]);
  const stageIdxRef = useRef(0);

  const current: SimEvent = useMemo(() => generateEvent(seed), [seed]);
  const championId = snap?.champion?.agent_id ?? null;
  const championWinRate = snap?.champion?.win_rate ?? 0.6;

  // When a fresh event lands, recompute the swarm reactions immediately so
  // the visual picks them up at stage="swarm-voting".
  useEffect(() => {
    if (!snap || snap.agents.length === 0) {
      setReactions([]);
      return;
    }
    setReactions(simulateReactions(current, snap.agents, snap.regime));
  }, [current, snap]);

  // Drive the stage machine.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      stageIdxRef.current = (stageIdxRef.current + 1) % STAGES.length;
      const next = STAGES[stageIdxRef.current];
      setStage(next);
      if (next === "event-fired") {
        setSeed((s) => s + 1);
      } else if (next === "settled") {
        // Realise the trade into the ledger.
        const championReacted = reactions.find(
          (r) => r.agent_id === championId && r.reacted,
        );
        const longs = reactions.filter((r) => r.reacted && r.direction === "long").length;
        const shorts = reactions.filter((r) => r.reacted && r.direction === "short").length;
        const total = reactions.filter((r) => r.reacted).length;
        const direction = championReacted?.direction ?? null;
        const rPnl = championReacted ? settleTrade(seed, championWinRate) : 0;
        const outcome: DemoTrade["outcome"] = !championReacted
          ? "skip"
          : rPnl > 0
            ? "win"
            : "loss";
        setTrades((prev) =>
          [
            {
              id: current.id,
              ev: current,
              championId,
              direction,
              rPnl,
              outcome,
              voted_long: longs,
              voted_short: shorts,
              voted_total: total,
            },
            ...prev,
          ].slice(0, 8),
        );
      }
    }, TICK_MS);
    return () => clearInterval(t);
  }, [
    running,
    reactions,
    championId,
    championWinRate,
    seed,
    current,
  ]);

  const cumR = trades.reduce((a, t) => a + t.rPnl, 0);
  const wins = trades.filter((t) => t.outcome === "win").length;
  const losses = trades.filter((t) => t.outcome === "loss").length;
  const skips = trades.filter((t) => t.outcome === "skip").length;

  if (!snap) return null;

  return (
    <section className="panel p-5 md:p-6 relative overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{
          background:
            "radial-gradient(circle at 15% 50%, rgba(34,211,238,0.10), transparent 40%)",
        }}
      />
      <div className="relative">
        <div className="flex items-start justify-between flex-wrap gap-2 mb-4">
          <div>
            <div className="text-[0.6rem] tracking-[0.4em] text-cyan uppercase">
              Auto-replay · always-on demo
            </div>
            <h3 className="text-xl font-semibold text-slate-100 mt-1">
              Watch the closed loop in real time
            </h3>
            <p className="text-xs text-mist mt-1.5 max-w-xl">
              Synthesised events fire every ~5s. Each one walks through the
              full pipeline so you can see what happens without running the
              backtest yourself.
            </p>
          </div>
          <div className="flex items-center gap-2 text-[0.7rem]">
            <button
              onClick={() => setRunning((r) => !r)}
              className={`chip ${running ? "chip-cyan" : "chip-mist"} hover:opacity-80 transition-opacity`}
            >
              {running ? "Pause" : "Resume"}
            </button>
            <button
              onClick={() => {
                setTrades([]);
                setSeed(1);
                stageIdxRef.current = 0;
                setStage("event-fired");
              }}
              className="chip chip-mist hover:opacity-80 transition-opacity"
            >
              Reset
            </button>
          </div>
        </div>

        {/* Pipeline rail */}
        <div className="flex items-stretch gap-2 mb-4">
          {STAGES.map((s) => {
            const idx = STAGES.indexOf(s);
            const here = idx === stageIdxRef.current;
            const passed = idx < stageIdxRef.current;
            return (
              <div
                key={s}
                className={`flex-1 rounded-sm border px-2 py-1.5 text-[0.6rem] uppercase tracking-widest transition-colors ${
                  here
                    ? "border-cyan/60 text-cyan bg-cyan/5"
                    : passed
                      ? "border-edge text-mist"
                      : "border-edge/40 text-mist/60"
                }`}
              >
                <span className="num">{idx + 1}.</span> {labelOf(s)}
              </div>
            );
          })}
        </div>

        {/* Live event window */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
          <div className="rounded-sm border border-edge/60 bg-black/30 p-3">
            <div className="text-[0.6rem] uppercase tracking-widest text-mist">
              Latest event
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span className="font-mono text-slate-100 text-sm uppercase">
                {current.kind}
              </span>
              <span className="font-mono text-cyan text-sm">{current.asset}</span>
              <span
                className={`text-sm ${
                  current.direction === "long" ? "text-green" : "text-red"
                }`}
              >
                {current.direction === "long" ? "↑" : "↓"}
              </span>
            </div>
            <div className="mt-1 text-[0.65rem] num text-mist">
              |z| = {current.magnitude_z.toFixed(2)}
            </div>
          </div>
          <div className="rounded-sm border border-edge/60 bg-black/30 p-3 md:col-span-2">
            <div className="text-[0.6rem] uppercase tracking-widest text-mist">
              Swarm vote
            </div>
            <div
              className={`mt-1 transition-opacity duration-300 ${
                stage === "event-fired" ? "opacity-30" : "opacity-100"
              }`}
            >
              <div className="flex flex-wrap gap-1">
                {reactions.length === 0 ? (
                  <span className="text-[0.65rem] text-mist italic">
                    Loading swarm…
                  </span>
                ) : (
                  reactions.map((r) => {
                    const passed = stage !== "event-fired";
                    const isChamp = r.agent_id === championId;
                    return (
                      <span
                        key={r.agent_id}
                        title={r.rationale}
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[0.6rem] font-mono transition-all ${
                          r.reacted
                            ? isChamp
                              ? "bg-amber/15 text-amber ring-1 ring-amber/50"
                              : "bg-edge/50 text-slate-200"
                            : "bg-edge/15 text-mist/50"
                        } ${passed ? "" : "scale-95 opacity-60"}`}
                      >
                        <span
                          className="inline-block w-1.5 h-1.5 rounded-full"
                          style={{
                            background: FAMILY_COLORS[r.family],
                            boxShadow: r.reacted
                              ? `0 0 6px ${FAMILY_COLORS[r.family]}`
                              : "none",
                          }}
                        />
                        {isChamp ? "👑" : ""}
                        <span>
                          {r.agent_id.replace(/^gen\d+-mut\d+-/, "")}
                        </span>
                        {r.reacted ? (
                          <span
                            className={
                              r.direction === "long" ? "text-green" : "text-red"
                            }
                          >
                            {r.direction === "long" ? "↑" : "↓"}
                          </span>
                        ) : null}
                      </span>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Trade ledger */}
        <div className="rounded-sm border border-edge/60 bg-black/20">
          <div className="flex items-center justify-between px-3 py-2 border-b border-edge/50">
            <div className="text-[0.6rem] uppercase tracking-widest text-mist">
              Demo trade ledger · last {trades.length}
            </div>
            <div className="flex items-center gap-3 text-[0.65rem] num">
              <span className="text-green">{wins}W</span>
              <span className="text-red">{losses}L</span>
              <span className="text-mist">{skips} skipped</span>
              <span
                className={cumR >= 0 ? "text-green" : "text-red"}
              >
                Σ R {cumR >= 0 ? "+" : ""}
                {cumR.toFixed(1)}
              </span>
            </div>
          </div>
          {trades.length === 0 ? (
            <div className="px-3 py-6 text-center text-[0.7rem] text-mist">
              First trade settles in a few seconds…
            </div>
          ) : (
            <div className="divide-y divide-edge/40 max-h-[260px] overflow-auto">
              {trades.map((t) => (
                <TradeRow key={t.id} t={t} />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function labelOf(s: Stage): string {
  return {
    "event-fired": "Event",
    "swarm-voting": "Swarm",
    "champion-locked": "Champion",
    executed: "Trade",
    settled: "PnL",
  }[s];
}

function TradeRow({ t }: { t: DemoTrade }) {
  const championShort = t.championId?.replace(/^gen\d+-mut\d+-/, "") ?? "—";
  const family = t.championId ? agentFamily(t.championId) : "other";
  const dot = FAMILY_COLORS[family];
  const pnlColor =
    t.outcome === "win"
      ? "text-green"
      : t.outcome === "loss"
        ? "text-red"
        : "text-mist";
  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2 px-3 py-1.5 text-[0.7rem]">
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: dot, boxShadow: `0 0 6px ${dot}` }}
        />
        <span className="font-mono text-slate-100 uppercase">{t.ev.kind}</span>
        <span className="font-mono text-cyan">{t.ev.asset}</span>
        <span className="text-mist num">|z|={t.ev.magnitude_z.toFixed(2)}</span>
        <span
          className={`truncate text-mist ${
            t.outcome === "skip" ? "italic" : ""
          }`}
        >
          → {championShort}
        </span>
      </div>
      <span className="num text-mist">
        {t.voted_long}L/{t.voted_short}S of {t.voted_total}
      </span>
      <span
        className={`num ${
          t.direction === "long"
            ? "text-green"
            : t.direction === "short"
              ? "text-red"
              : "text-mist"
        }`}
      >
        {t.direction === "long" ? "LONG" : t.direction === "short" ? "SHORT" : "FLAT"}
      </span>
      <span className={`num ${pnlColor}`}>
        {t.outcome === "skip"
          ? "—"
          : `${t.rPnl >= 0 ? "+" : ""}${t.rPnl.toFixed(1)}R`}
      </span>
    </div>
  );
}
