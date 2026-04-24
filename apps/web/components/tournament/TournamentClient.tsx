"use client";

import { useEffect, useMemo, useState } from "react";
import { Arena } from "./Arena";
import { Leaderboard } from "./Leaderboard";
import { SettingsForm } from "./SettingsForm";
import { EventSimulator } from "./EventSimulator";
import { CopyTradePanel } from "./CopyTradePanel";
import { LiveTradeFeed, type FeedEntry } from "./LiveTradeFeed";
import { KiyotakaBadge } from "./KiyotakaBadge";
import {
  fetchSwarm,
  FAMILY_COLORS,
  agentFamily,
  type SwarmSnapshot,
} from "@/lib/swarm";
import type { SimEvent } from "@/lib/simulate";
import { simulateReactions } from "@/lib/simulate";

const COPY_LS_KEY = "pythia-copytrade-agent";
const FEED_MAX = 25;

function fmt(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString();
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

  const reactions = useMemo(() => {
    if (!snap || !lastEvent) return [];
    return simulateReactions(lastEvent, snap.agents);
  }, [snap, lastEvent]);

  const onFire = (ev: SimEvent) => {
    if (!snap) return;
    const rxs = simulateReactions(ev, snap.agents);
    const championId = snap.champion?.agent_id ?? null;
    const entry: FeedEntry = {
      id: ev.id,
      ts: ev.ts,
      event: ev,
      reactions: rxs,
      championId,
    };
    setLastEvent(ev);
    setFeed((prev) => [entry, ...prev].slice(0, FEED_MAX));
  };

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
  const BTC_PX = 77_500;
  const ETH_PX = 3_200;

  return (
    <div className="space-y-6">
      {/* HERO Arena */}
      <section className="relative rounded-2xl overflow-hidden h-[68vh] -mx-6 md:mx-0 border border-edge/60">
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

      {/* 3-ZONE DECK: Simulator+Settings | Copy-trade + Explainer | Trade Feed */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-6">
          <EventSimulator onFire={onFire} lastFired={lastEvent} />
          <SettingsForm />
        </div>

        <div className="space-y-6">
          <CopyTradePanel
            agents={snap.agents}
            selected={copyAgent}
            onSelect={setCopyAgent}
            equity_usd={1000}
            risk_fraction={0.01}
            btc_price={BTC_PX}
            eth_price={ETH_PX}
            reactions={reactions}
            lastEvent={lastEvent}
          />

          <div className="panel p-5">
            <div className="text-xs uppercase tracking-[0.3em] text-mist">
              How the swarm gets smart
            </div>
            <ol className="mt-3 space-y-3 text-xs text-slate-300">
              <li>
                <span className="text-cyan font-mono">1. Event →</span>{" "}
                Every agent observes the same liquidation / funding / candle
                tick simultaneously.
              </li>
              <li>
                <span className="text-cyan font-mono">2. Vote →</span>{" "}
                Each agent fires (or abstains) independently using its own
                rule family and parameters.
              </li>
              <li>
                <span className="text-cyan font-mono">3. PeerView →</span>{" "}
                Social agents additionally see what peers + the current
                champion just did → momentum / contrarian meta-behaviours.
              </li>
              <li>
                <span className="text-cyan font-mono">4. Scoreboard →</span>{" "}
                Every closed trade updates Σ R, rolling Sharpe, win rate.
                The oracle the rest of the system reads.
              </li>
              <li>
                <span className="text-cyan font-mono">5. Evolution →</span>{" "}
                Every N events, weak agents are replaced by log-space
                Gaussian mutants + same-family crossovers of the elite.
                Drift toward profitable parameter regions.
              </li>
              <li>
                <span className="text-amber font-mono">6. Copy trade →</span>{" "}
                Whoever leads now is the agent you mirror. When the regime
                shifts, a different family rises → execution follows, no
                restart.
              </li>
            </ol>
          </div>
        </div>

        <LiveTradeFeed entries={feed} />
      </section>

      {/* Full leaderboard */}
      <section>
        <Leaderboard agents={snap.agents} />
      </section>
    </div>
  );
}
