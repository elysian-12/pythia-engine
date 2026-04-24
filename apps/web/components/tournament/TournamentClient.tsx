"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Arena } from "./Arena";
import { Leaderboard } from "./Leaderboard";
import { SettingsForm } from "./SettingsForm";
import { EventSimulator } from "./EventSimulator";
import { CopyTradePanel } from "./CopyTradePanel";
import { LiveTradeFeed, type FeedEntry } from "./LiveTradeFeed";
import { KiyotakaBadge } from "./KiyotakaBadge";
import { AutoPilot } from "./AutoPilot";
import { HyperliquidPanel } from "./HyperliquidPanel";
import { PipelineRail } from "./PipelineRail";
import {
  fetchSwarm,
  FAMILY_COLORS,
  agentFamily,
  type SwarmSnapshot,
} from "@/lib/swarm";
import type { SimEvent } from "@/lib/simulate";
import { simulateReactions, simulateCopyTrade } from "@/lib/simulate";
import { checkTriggers, sumRealized, type PaperPosition } from "@/lib/paper";

const COPY_LS_KEY = "pythia-copytrade-agent";
const FEED_MAX = 25;
const EQUITY_USD = 1000;
const RISK_FRACTION = 0.01;
const DEFAULT_BTC = 77_500;
const DEFAULT_ETH = 3_200;

function fmt(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString();
}

function RegimeBadge({
  regime,
}: {
  regime: NonNullable<SwarmSnapshot["regime"]> | undefined | null;
}) {
  if (!regime) return null;
  const color = {
    trending: "text-green",
    ranging: "text-cyan",
    chaotic: "text-red",
    calm: "text-mist",
  }[regime.label];
  return (
    <span className="inline-flex items-center gap-2 text-[0.65rem] text-mist">
      <span className={`font-mono uppercase tracking-[0.3em] ${color}`}>
        {regime.label}
      </span>
      <span className="num">dir {regime.directional.toFixed(2)}</span>
      <span className="num">vol {regime.vol_ratio.toFixed(2)}×</span>
    </span>
  );
}

function PhaseBadge({ phase }: { phase: "swarm" | "ranking" | "podium" }) {
  const map = {
    swarm: { label: "SWARM", color: "text-cyan", ring: "ring-cyan/60" },
    ranking: { label: "RANKING", color: "text-amber", ring: "ring-amber/60" },
    podium: { label: "PODIUM", color: "text-green", ring: "ring-green/60" },
  } as const;
  const { label, color, ring } = map[phase];
  return (
    <span
      className={`inline-block px-2 py-0.5 tracking-[0.4em] text-[0.6rem] rounded-sm ring-1 ${ring} ${color} bg-black/30`}
    >
      {label}
    </span>
  );
}

function SourceBadge({ source }: { source: SwarmSnapshot["source"] }) {
  const map: Record<SwarmSnapshot["source"], { label: string; dot: string }> = {
    live: { label: "Live daemon", dot: "bg-green animate-pulse" },
    backtest: { label: "Backtest replay", dot: "bg-cyan" },
    empty: { label: "No snapshot yet", dot: "bg-mist" },
  };
  const { label, dot } = map[source] ?? map.empty;
  return (
    <span className="inline-flex items-center gap-2 text-[0.65rem] text-mist">
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

export function TournamentClient() {
  const [snap, setSnap] = useState<SwarmSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<"swarm" | "ranking" | "podium">("swarm");
  const [copyAgent, setCopyAgent] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [lastEvent, setLastEvent] = useState<SimEvent | null>(null);
  const [pulseKey, setPulseKey] = useState(0);
  const [autopilotOn, setAutopilotOn] = useState(false);

  // Paper HL ledger — opens when the copy-trader's agent reacts to an event.
  const [openPositions, setOpenPositions] = useState<PaperPosition[]>([]);
  const [closedPositions, setClosedPositions] = useState<PaperPosition[]>([]);
  const [marks, setMarks] = useState<{ BTC: number | null; ETH: number | null }>(
    { BTC: null, ETH: null },
  );

  const snapRef = useRef<SwarmSnapshot | null>(null);
  const copyAgentRef = useRef<string | null>(null);
  useEffect(() => {
    snapRef.current = snap;
  }, [snap]);
  useEffect(() => {
    copyAgentRef.current = copyAgent;
  }, [copyAgent]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await fetchSwarm();
        if (!alive) return;
        setSnap(s);
        setErr(null);
      } catch (e) {
        if (!alive) return;
        setErr((e as Error).message);
      }
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Intro animation phases.
  useEffect(() => {
    const t1 = setTimeout(() => setPhase("ranking"), 1600);
    const t2 = setTimeout(() => setPhase("podium"), 4000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  // Restore copy-trade selection from localStorage.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(COPY_LS_KEY);
      if (stored) setCopyAgent(stored);
    } catch {
      // ignore
    }
  }, []);

  // Poll live BTC/ETH marks every 6s once we have any open positions or the
  // autopilot is active — saves bandwidth in the idle case.
  useEffect(() => {
    let alive = true;
    if (!autopilotOn && openPositions.length === 0) return;
    const load = async () => {
      try {
        const r = await fetch("/api/marks", { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as {
          ok: boolean;
          marks: { BTC: number | null; ETH: number | null };
        };
        if (!alive) return;
        if (d.marks.BTC != null || d.marks.ETH != null) setMarks(d.marks);
      } catch {
        // ignore
      }
    };
    load();
    const t = setInterval(load, 6000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [autopilotOn, openPositions.length]);

  // Stop/TP sweep: when marks change, auto-close positions whose triggers hit.
  useEffect(() => {
    if (openPositions.length === 0) return;
    const hits: PaperPosition[] = [];
    const survivors: PaperPosition[] = [];
    for (const p of openPositions) {
      const m = p.asset === "BTC" ? marks.BTC : marks.ETH;
      if (m == null) {
        survivors.push(p);
        continue;
      }
      const trig = checkTriggers(p, m);
      if (!trig) {
        survivors.push(p);
        continue;
      }
      const diff = p.side === "long" ? m - p.entry : p.entry - m;
      hits.push({
        ...p,
        closed_at: Math.floor(Date.now() / 1000),
        close_px: m,
        close_reason: trig,
        pnl_usd: diff * p.size_contracts,
      });
    }
    if (hits.length === 0) return;
    setOpenPositions(survivors);
    setClosedPositions((prev) => [...prev, ...hits]);
  }, [marks, openPositions]);

  const reactions = useMemo(() => {
    if (!snap || !lastEvent) return [];
    return simulateReactions(lastEvent, snap.agents);
  }, [snap, lastEvent]);

  const handleClosePosition = useCallback((id: string) => {
    setOpenPositions((prev) => {
      const p = prev.find((x) => x.id === id);
      if (!p) return prev;
      const m = p.asset === "BTC" ? marks.BTC : marks.ETH;
      const px = m ?? p.entry;
      const diff = p.side === "long" ? px - p.entry : p.entry - px;
      setClosedPositions((c) => [
        ...c,
        {
          ...p,
          closed_at: Math.floor(Date.now() / 1000),
          close_px: px,
          close_reason: "manual",
          pnl_usd: diff * p.size_contracts,
        },
      ]);
      return prev.filter((x) => x.id !== id);
    });
  }, [marks]);

  const handleReset = useCallback(() => {
    setOpenPositions([]);
    setClosedPositions([]);
  }, []);

  const onFire = useCallback((ev: SimEvent) => {
    const currentSnap = snapRef.current;
    if (!currentSnap) return;
    const rxs = simulateReactions(ev, currentSnap.agents);
    const championId = currentSnap.champion?.agent_id ?? null;
    const entry: FeedEntry = {
      id: ev.id,
      ts: ev.ts,
      event: ev,
      reactions: rxs,
      championId,
    };
    setLastEvent(ev);
    setFeed((prev) => [entry, ...prev].slice(0, FEED_MAX));
    setPulseKey((k) => k + 1);

    // Paper-HL placement: whichever agent the user is mirroring (champion by
    // default) reacts → open a paper position sized like the Rust executor.
    const mirroredId = copyAgentRef.current ?? championId;
    if (!mirroredId) return;
    const mirrored = currentSnap.agents.find((a) => a.agent_id === mirroredId);
    if (!mirrored) return;
    const btcPx = marks.BTC ?? DEFAULT_BTC;
    const ethPx = marks.ETH ?? DEFAULT_ETH;
    const sim = simulateCopyTrade(
      mirrored,
      ev,
      rxs,
      EQUITY_USD,
      RISK_FRACTION,
      btcPx,
      ethPx,
    );
    if (!sim) return;
    const pos: PaperPosition = {
      id: `pos-${ev.id}`,
      agent_id: sim.agent_id,
      asset: ev.asset,
      side: sim.direction,
      size_contracts: sim.size_contracts,
      notional_usd: sim.size_usd,
      entry: sim.entry,
      stop: sim.stop,
      take_profit: sim.take_profit,
      opened_at: ev.ts,
    };
    setOpenPositions((prev) => [...prev, pos]);
  }, [marks]);

  const onPrices = useCallback(
    (p: { BTC: number | null; ETH: number | null }) => {
      if (p.BTC != null || p.ETH != null) setMarks(p);
    },
    [],
  );

  if (!snap) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center text-mist">
        {err ?? "Loading swarm…"}
      </div>
    );
  }

  if (snap.source === "empty" || snap.agents.length === 0) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center space-y-4 text-center">
        <div className="text-xs tracking-[0.35em] text-cyan uppercase">
          No swarm snapshot yet
        </div>
        <h2 className="text-2xl md:text-3xl font-semibold text-slate-100">
          Run the backtest or the live daemon first
        </h2>
        <pre className="panel text-left text-xs md:text-sm p-4 num">
{`cargo run --release -p swarm --bin swarm-backtest
# or
cargo run --release -p live-executor --bin pythia-swarm-live`}
        </pre>
      </div>
    );
  }

  const champ = snap.champion;
  const familiesActive = Array.from(
    new Set(snap.agents.map((a) => agentFamily(a.agent_id))),
  );

  return (
    <div className="space-y-6">
      {/* HERO Arena */}
      <section className="relative rounded-2xl overflow-hidden h-[60vh] -mx-6 md:mx-0 border border-edge/60">
        <Arena agents={snap.agents} generation={snap.generation ?? 0} />
        <div className="pointer-events-none absolute top-0 left-0 right-0 p-5 flex items-start justify-between">
          <div>
            <div className="text-[0.65rem] tracking-[0.4em] text-cyan uppercase">
              Pythia tournament
            </div>
            <h2 className="text-3xl md:text-5xl font-semibold text-slate-100 mt-1 tracking-tight">
              Events → Swarm → Champion → Your copy trade
            </h2>
          </div>
          <div className="text-right space-y-1 pointer-events-auto">
            <KiyotakaBadge />
            <SourceBadge source={snap.source} />
            <RegimeBadge regime={snap.regime} />
            <div className="text-[0.65rem] text-mist num">
              {fmt(snap.generated_at)}
            </div>
            <div>
              <PhaseBadge phase={phase} />
            </div>
          </div>
        </div>

        {champ ? (
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 p-5 flex items-end justify-between">
            <div className="panel px-4 py-3 pointer-events-auto backdrop-blur-sm bg-black/30">
              <div className="text-[0.65rem] tracking-[0.4em] text-amber uppercase">
                Current champion
              </div>
              <div className="mt-1 text-lg font-mono text-slate-100">
                {champ.agent_id}
              </div>
              <div className="flex gap-4 text-xs mt-2 num">
                <span>
                  <span className="text-mist">Σ R</span>{" "}
                  <span
                    className={champ.total_r >= 0 ? "text-green" : "text-red"}
                  >
                    {champ.total_r >= 0 ? "+" : ""}
                    {champ.total_r.toFixed(2)}
                  </span>
                </span>
                <span>
                  <span className="text-mist">WR</span>{" "}
                  {(champ.win_rate * 100).toFixed(1)}%
                </span>
                <span>
                  <span className="text-mist">Trades</span>{" "}
                  {champ.wins + champ.losses}
                </span>
              </div>
            </div>
            <div className="flex flex-wrap gap-3 items-center text-[0.65rem] text-mist pointer-events-auto justify-end max-w-[380px]">
              {Object.entries(FAMILY_COLORS)
                .filter(
                  ([k]) =>
                    k !== "other" &&
                    familiesActive.includes(k as (typeof familiesActive)[number]),
                )
                .map(([k, v]) => (
                  <span key={k} className="flex items-center gap-1.5">
                    <span
                      className="inline-block w-2 h-2 rounded-full"
                      style={{ background: v, boxShadow: `0 0 8px ${v}` }}
                    />
                    <span className="font-mono uppercase tracking-widest">
                      {k}
                    </span>
                  </span>
                ))}
            </div>
          </div>
        ) : null}
      </section>

      {/* Closed-loop pipeline visualizer */}
      <section>
        <PipelineRail
          pulseKey={pulseKey}
          autopilotOn={autopilotOn}
          openCount={openPositions.length}
          realizedPnl={sumRealized(closedPositions)}
          generation={snap.generation ?? 0}
          championId={champ?.agent_id ?? null}
        />
      </section>

      {/* 3-column deck: Inputs | Trading | Outputs */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-6">
          <AutoPilot
            onFire={onFire}
            onPrices={onPrices}
            onStatus={setAutopilotOn}
          />
          <EventSimulator onFire={onFire} lastFired={lastEvent} />
          <SettingsForm />
        </div>

        <div className="space-y-6">
          <HyperliquidPanel
            open={openPositions}
            closed={closedPositions}
            marks={marks}
            equity_usd={EQUITY_USD}
            onClose={handleClosePosition}
            onReset={handleReset}
          />
          <CopyTradePanel
            agents={snap.agents}
            selected={copyAgent}
            onSelect={setCopyAgent}
            equity_usd={EQUITY_USD}
            risk_fraction={RISK_FRACTION}
            btc_price={marks.BTC ?? DEFAULT_BTC}
            eth_price={marks.ETH ?? DEFAULT_ETH}
            reactions={reactions}
            lastEvent={lastEvent}
          />
        </div>

        <div className="space-y-6">
          <LiveTradeFeed entries={feed} />
          <div className="panel p-5">
            <div className="text-xs uppercase tracking-[0.3em] text-mist">
              How the swarm gets smart
            </div>
            <ol className="mt-3 space-y-2 text-xs text-slate-300">
              <li>
                <span className="text-cyan font-mono">1. Event →</span>{" "}
                Every agent observes the same liquidation / funding / candle
                tick simultaneously.
              </li>
              <li>
                <span className="text-cyan font-mono">2. Vote →</span>{" "}
                Each agent fires (or abstains) independently using its own
                rule family.
              </li>
              <li>
                <span className="text-cyan font-mono">3. PeerView →</span>{" "}
                Social agents see peer + champion directions → momentum /
                contrarian meta-behaviours.
              </li>
              <li>
                <span className="text-cyan font-mono">4. Scoreboard →</span>{" "}
                Realized R updates Σ R, rolling Sharpe, win rate — the
                oracle the system reads.
              </li>
              <li>
                <span className="text-cyan font-mono">5. Evolution →</span>{" "}
                Every N events, weak agents replaced by log-space Gaussian
                mutants + elite crossovers.
              </li>
              <li>
                <span className="text-amber font-mono">6. Copy trade →</span>{" "}
                Champion → paper HL — when regime shifts, a different family
                rises → execution follows, no restart.
              </li>
            </ol>
          </div>
        </div>
      </section>

      {/* Full leaderboard */}
      <section>
        <Leaderboard agents={snap.agents} />
      </section>
    </div>
  );
}

