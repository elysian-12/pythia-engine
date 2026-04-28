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
 * Auto-looping landing demo. Generates synthetic events on a fixed cadence,
 * walks through the closed-loop pipeline (Event → Swarm → Champion → Trade
 * → PnL), and stamps the latency between each transition so the visitor
 * sees how fast the path runs end-to-end.
 *
 * The trade dollar sizes come from the user's saved settings (equity +
 * risk-fraction). When settings change via the SettingsPanel, this view
 * recomputes immediately.
 */

type Stage =
  | "event-fired"
  | "swarm-voting"
  | "champion-locked"
  | "executed"
  | "settled";

type Latencies = Partial<Record<Stage, number>>; // ms since event-fired

type DemoTrade = {
  id: string;
  ev: SimEvent;
  championId: string | null;
  championShort: string;
  direction: "long" | "short" | null;
  rPnl: number;
  pnlUsd: number;
  notional: number;
  outcome: "win" | "loss" | "skip" | "pending";
  voted_long: number;
  voted_short: number;
  voted_total: number;
  latency_ms: number; // event → trade-sent
};

type LandingMode = "paper" | "live";

const STAGES: Stage[] = [
  "event-fired",
  "swarm-voting",
  "champion-locked",
  "executed",
  "settled",
];

// Per-stage delay (ms). Real production latency is dominated by network
// (Kiyotaka push → Hyperliquid order ack ≈ 80–250 ms). The demo expands
// each stage 4–6× so the eye can follow it.
const STAGE_MS: Record<Stage, number> = {
  "event-fired": 0,
  "swarm-voting": 600,
  "champion-locked": 350,
  executed: 250,
  settled: 1100,
};

// Optional jitter so consecutive cycles don't look mechanical.
function jittered(base: number): number {
  return base + Math.round(Math.random() * 60 - 30);
}

function generateEvent(seed: number): SimEvent {
  // Cycle through five Kiyotaka-derived event kinds: forced liquidations,
  // funding-rate spikes, hourly volume breakouts, Polymarket leadership
  // signals (SWP-vs-mid gap), and confluence ("fusion") events where
  // multiple signal families align at once. The mix is roughly 40% liq,
  // 20% each of funding/vol, 15% polymarket, 5% fusion.
  const kindPool: SimEvent["kind"][] = [
    "liq-spike",
    "liq-spike",
    "funding-spike",
    "vol-breakout",
    "polymarket-lead",
    "fusion",
  ];
  const assets: SimEvent["asset"][] = ["BTC", "ETH"];
  const dir: SimEvent["direction"] = Math.sin(seed * 12.9898) > 0 ? "long" : "short";
  const z = 2.0 + Math.abs(Math.cos(seed * 78.233)) * 1.6;
  return {
    id: `demo-${seed}`,
    ts: Math.floor(Date.now() / 1000),
    asset: assets[seed % 2],
    kind: kindPool[seed % kindPool.length],
    magnitude_z: z,
    direction: dir,
  };
}

function settleR(seed: number, championWinRate: number): number {
  const u = Math.abs(Math.sin(seed * 91.347)) % 1;
  return u < championWinRate ? 1.5 : -1.0;
}

export type AutoReplaySettings = {
  equity_usd: number;
  risk_fraction: number;
  mode: LandingMode;
  wallet_address: string;
};

const DEFAULT_SETTINGS: AutoReplaySettings = {
  equity_usd: 1000,
  risk_fraction: 0.005,
  mode: "paper",
  wallet_address: "",
};

export function AutoReplay({
  snap,
  className,
}: {
  snap: SwarmSnapshot | null;
  /** Optional class merged onto the section root. The landing page
   *  passes "h-full" so AutoReplay fills the height of the row track
   *  defined by TradeSettingsPanel on the left, and the inner trade
   *  ledger scrolls instead of pushing the row taller. */
  className?: string;
}) {
  const [seed, setSeed] = useState(1);
  const [stage, setStage] = useState<Stage>("event-fired");
  const [trades, setTrades] = useState<DemoTrade[]>([]);
  const [running, setRunning] = useState(true);
  const [reactions, setReactions] = useState<SimReaction[]>([]);
  const [latencies, setLatencies] = useState<Latencies>({});
  const [settings, setSettings] = useState<AutoReplaySettings>(DEFAULT_SETTINGS);

  // Read latest user settings from localStorage / API + listen for changes.
  useEffect(() => {
    const apply = (cfg: Partial<AutoReplaySettings>) => {
      setSettings((prev) => ({
        equity_usd:
          typeof cfg.equity_usd === "number" && cfg.equity_usd > 0
            ? cfg.equity_usd
            : prev.equity_usd,
        risk_fraction:
          typeof cfg.risk_fraction === "number" && cfg.risk_fraction > 0
            ? cfg.risk_fraction
            : prev.risk_fraction,
        mode: cfg.mode === "live" || cfg.mode === "paper" ? cfg.mode : prev.mode,
        wallet_address:
          typeof cfg.wallet_address === "string"
            ? cfg.wallet_address
            : prev.wallet_address,
      }));
    };
    (async () => {
      try {
        const res = await fetch("/api/config", { cache: "no-store" });
        if (res.ok) apply((await res.json()) as Partial<AutoReplaySettings>);
      } catch {
        /* ignore */
      }
      try {
        const ls = localStorage.getItem("pythia-swarm-config");
        if (ls) apply(JSON.parse(ls) as Partial<AutoReplaySettings>);
      } catch {
        /* ignore */
      }
    })();
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<Partial<AutoReplaySettings>>).detail;
      if (detail) apply(detail);
    };
    window.addEventListener("pythia-config-updated", onCustom);
    return () => window.removeEventListener("pythia-config-updated", onCustom);
  }, []);

  const current: SimEvent = useMemo(() => generateEvent(seed), [seed]);
  const championId = snap?.champion?.agent_id ?? null;
  const championWinRate = snap?.champion?.win_rate ?? 0.6;

  // Recompute swarm reactions when the event lands.
  useEffect(() => {
    if (!snap || snap.agents.length === 0) {
      setReactions([]);
      return;
    }
    setReactions(simulateReactions(current, snap.agents, snap.regime));
  }, [current, snap]);

  // Stage machine — each stage advances after its STAGE_MS budget. Records
  // a real wall-clock latency stamp at every transition so the latency
  // meter shows perceived end-to-end time, not the configured budget.
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let stageIdx = 0;
    let cycleStart = performance.now();
    const stamps: Latencies = { "event-fired": 0 };
    setStage(STAGES[0]);
    setLatencies(stamps);
    setSeed((s) => s + 1);

    const advance = () => {
      if (cancelled) return;
      stageIdx += 1;
      if (stageIdx >= STAGES.length) {
        // start a new cycle
        stageIdx = 0;
        cycleStart = performance.now();
        const fresh: Latencies = { "event-fired": 0 };
        setLatencies(fresh);
        setStage(STAGES[0]);
        setSeed((s) => s + 1);
      } else {
        const st = STAGES[stageIdx];
        const delta = performance.now() - cycleStart;
        stamps[st] = Math.round(delta);
        setLatencies({ ...stamps });
        setStage(st);
        if (st === "executed") {
          // finalise demo trade once it's "sent"
          const championReacted = reactionsRef.current.find(
            (r) => r.agent_id === championId && r.reacted,
          );
          const longs = reactionsRef.current.filter(
            (r) => r.reacted && r.direction === "long",
          ).length;
          const shorts = reactionsRef.current.filter(
            (r) => r.reacted && r.direction === "short",
          ).length;
          const total = reactionsRef.current.filter((r) => r.reacted).length;
          const direction = championReacted?.direction ?? null;
          const r = championReacted ? settleR(seedRef.current, championWinRate) : 0;
          const fitness = championReacted?.fitness ?? 1;
          const riskUsd = settingsRef.current.equity_usd *
            settingsRef.current.risk_fraction *
            fitness;
          const notional = championReacted ? riskUsd / 0.0075 : 0; // STOP_PCT 0.75%
          const pnlUsd = championReacted ? r * riskUsd : 0;
          const outcome: DemoTrade["outcome"] = !championReacted
            ? "skip"
            : r > 0
              ? "win"
              : "loss";
          setTrades((prev) =>
            [
              {
                id: currentRef.current.id,
                ev: currentRef.current,
                championId,
                championShort: championId
                  ? championId.replace(/^gen\d+-mut\d+-/, "")
                  : "—",
                direction,
                rPnl: r,
                pnlUsd,
                notional,
                outcome,
                voted_long: longs,
                voted_short: shorts,
                voted_total: total,
                latency_ms: Math.round(delta),
              },
              ...prev,
            ].slice(0, 10),
          );
        }
      }
      const nextStage = STAGES[(stageIdx + 1) % STAGES.length];
      setTimeout(advance, jittered(STAGE_MS[nextStage] ?? 800));
    };
    setTimeout(advance, jittered(STAGE_MS["swarm-voting"]));
    return () => {
      cancelled = true;
    };
  }, [running, championId, championWinRate]);

  // Refs mirror state for the timer body.
  const reactionsRef = useRef<SimReaction[]>([]);
  const currentRef = useRef<SimEvent>(current);
  const seedRef = useRef<number>(seed);
  const settingsRef = useRef<AutoReplaySettings>(settings);
  useEffect(() => {
    reactionsRef.current = reactions;
  }, [reactions]);
  useEffect(() => {
    currentRef.current = current;
  }, [current]);
  useEffect(() => {
    seedRef.current = seed;
  }, [seed]);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const cumPnl = trades.reduce((a, t) => a + t.pnlUsd, 0);
  const cumR = trades.reduce((a, t) => a + t.rPnl, 0);
  const wins = trades.filter((t) => t.outcome === "win").length;
  const losses = trades.filter((t) => t.outcome === "loss").length;
  const skips = trades.filter((t) => t.outcome === "skip").length;
  const median =
    trades.length > 0
      ? [...trades].map((t) => t.latency_ms).sort((a, b) => a - b)[
          Math.floor(trades.length / 2)
        ]
      : 0;

  if (!snap) return null;

  return (
    <section className={`panel p-5 md:p-6 relative overflow-hidden flex flex-col ${className ?? ""}`}>
      <div
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{
          background:
            "radial-gradient(circle at 15% 50%, rgba(34,211,238,0.10), transparent 40%)",
        }}
      />
      <div className="relative flex-1 min-h-0 flex flex-col">
        <div className="flex items-start justify-between flex-wrap gap-2 mb-4">
          <div>
            <div className="text-[0.6rem] tracking-[0.4em] text-cyan uppercase">
              Auto-replay · always-on demo
            </div>
            <h3 className="text-xl font-semibold text-slate-100 mt-1">
              Watch the closed loop — event to trade in real time
            </h3>
            <p className="text-xs text-mist mt-1.5 max-w-xl">
              Synthesised events fire continuously and walk through the full
              pipeline. Trade sizes come from your settings below. Mode:
              <ModeBadge mode={settings.mode} />
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
                setLatencies({});
              }}
              className="chip chip-mist hover:opacity-80 transition-opacity"
            >
              Reset
            </button>
          </div>
        </div>

        {/* Pipeline rail with per-stage latency stamps */}
        <div className="flex items-stretch gap-2 mb-4">
          {STAGES.map((s, idx) => {
            const here = stage === s;
            const passed = STAGES.indexOf(stage) > idx;
            const t = latencies[s];
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
                <div className="flex items-baseline justify-between gap-1">
                  <span>
                    <span className="num">{idx + 1}.</span> {labelOf(s)}
                  </span>
                  {t != null ? (
                    <span className="num text-[0.6rem]">+{t}ms</span>
                  ) : null}
                </div>
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
                        }`}
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

        {/* Latency + settings live readout */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4 text-[0.7rem]">
          <Tile
            label="Equity"
            value={`$${settings.equity_usd.toLocaleString()}`}
            sub={settings.mode === "live" ? "live preview" : "paper"}
          />
          <Tile
            label="Risk"
            value={`${(settings.risk_fraction * 100).toFixed(2)}%`}
            sub={`= $${(settings.equity_usd * settings.risk_fraction).toFixed(0)} per trade`}
          />
          <Tile
            label="Median latency"
            value={median > 0 ? `${median} ms` : "—"}
            sub="event → trade-sent"
            tone="cyan"
          />
          <Tile
            label="Demo PnL"
            value={
              cumPnl >= 0 ? `+$${cumPnl.toFixed(2)}` : `-$${Math.abs(cumPnl).toFixed(2)}`
            }
            sub={`${wins}W / ${losses}L · ${cumR >= 0 ? "+" : ""}${cumR.toFixed(1)}R`}
            tone={cumPnl >= 0 ? "pos" : "neg"}
          />
        </div>

        {/* Trade ledger — flex-1 grows to fill the remaining height
            of the panel; only the row list inside scrolls. The
            demo-events stream fills the existing widget instead of
            pushing the panel taller and breaking row alignment with
            TradeSettingsPanel on the left. */}
        <div className="rounded-sm border border-edge/60 bg-black/20 flex-1 min-h-[200px] flex flex-col min-w-0">
          <div className="flex items-center justify-between px-3 py-2 border-b border-edge/50 shrink-0">
            <div className="text-[0.6rem] uppercase tracking-widest text-mist">
              Demo ledger · last {trades.length}
            </div>
            <div className="flex items-center gap-3 text-[0.65rem] num">
              <span className="text-green">{wins}W</span>
              <span className="text-red">{losses}L</span>
              <span className="text-mist">{skips} skipped</span>
            </div>
          </div>
          {trades.length === 0 ? (
            <div className="px-3 py-6 text-center text-[0.7rem] text-mist flex-1 flex items-center justify-center">
              First trade settles in a few seconds…
            </div>
          ) : (
            <div className="divide-y divide-edge/40 flex-1 min-h-0 overflow-auto subtle-scroll">
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

function ModeBadge({ mode }: { mode: LandingMode }) {
  return (
    <span
      className={`ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[0.6rem] uppercase tracking-widest ${
        mode === "live"
          ? "bg-amber/15 text-amber"
          : "bg-cyan/10 text-cyan"
      }`}
    >
      <span
        className={`w-1 h-1 rounded-full ${
          mode === "live" ? "bg-amber animate-pulse" : "bg-cyan"
        }`}
      />
      {mode}
    </span>
  );
}

function labelOf(s: Stage): string {
  return {
    "event-fired": "Event",
    "swarm-voting": "Swarm",
    "champion-locked": "Champion",
    executed: "Trade sent",
    settled: "PnL",
  }[s];
}

function Tile({
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
      {sub ? <div className="text-[0.6rem] text-mist mt-0.5">{sub}</div> : null}
    </div>
  );
}

function TradeRow({ t }: { t: DemoTrade }) {
  const family = t.championId ? agentFamily(t.championId) : "other";
  const dot = FAMILY_COLORS[family];
  const pnlColor =
    t.outcome === "win"
      ? "text-green"
      : t.outcome === "loss"
        ? "text-red"
        : "text-mist";
  return (
    <div className="grid grid-cols-[1fr_70px_70px_84px_64px] items-center gap-2 px-3 py-1.5 text-[0.7rem]">
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: dot, boxShadow: `0 0 6px ${dot}` }}
        />
        <span className="font-mono text-slate-100 uppercase">{t.ev.kind}</span>
        <span className="font-mono text-cyan">{t.ev.asset}</span>
        <span
          className={`truncate text-mist ${
            t.outcome === "skip" ? "italic" : ""
          }`}
        >
          → {t.championShort}
        </span>
      </div>
      <span
        className={`num text-right ${
          t.direction === "long"
            ? "text-green"
            : t.direction === "short"
              ? "text-red"
              : "text-mist"
        }`}
      >
        {t.direction === "long"
          ? "LONG"
          : t.direction === "short"
            ? "SHORT"
            : "FLAT"}
      </span>
      <span className="num text-right text-mist">
        ${t.notional > 0 ? t.notional.toFixed(0) : "—"}
      </span>
      <span className={`num text-right ${pnlColor}`}>
        {t.outcome === "skip"
          ? "—"
          : `${t.pnlUsd >= 0 ? "+" : ""}$${t.pnlUsd.toFixed(2)}`}
      </span>
      <span className="num text-right text-mist">{t.latency_ms}ms</span>
    </div>
  );
}
