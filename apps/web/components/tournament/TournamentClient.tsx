"use client";

import { useEffect, useMemo, useState } from "react";
import { Arena } from "./Arena";
import { Leaderboard } from "./Leaderboard";
import { fetchSwarm, FAMILY_COLORS, agentFamily, type SwarmSnapshot } from "@/lib/swarm";

function fmt(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString();
}

function SourceBadge({ source }: { source: SwarmSnapshot["source"] }) {
  const map: Record<SwarmSnapshot["source"], { label: string; dot: string }> = {
    live: { label: "Live daemon", dot: "bg-green animate-pulse" },
    backtest: { label: "Backtest replay", dot: "bg-cyan" },
    empty: { label: "No snapshot yet", dot: "bg-mist" },
  };
  const { label, dot } = map[source] ?? map.empty;
  return (
    <span className="inline-flex items-center gap-2 text-xs text-mist">
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

export function TournamentClient() {
  const [snap, setSnap] = useState<SwarmSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);

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

  const familiesActive = useMemo(() => {
    if (!snap) return [] as string[];
    return Array.from(new Set(snap.agents.map((a) => agentFamily(a.agent_id))));
  }, [snap]);

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
{`# simulate the tournament on 365 d of real BTC + ETH data
cargo run --release -p swarm --bin swarm-backtest

# — or — run the live daemon (writes data/swarm-snapshot.json)
cargo run --release -p live-executor --bin pythia-swarm-live`}
        </pre>
        <p className="text-xs text-mist max-w-md">
          Either command populates <span className="num">data/swarm-snapshot.json</span>,
          which this page reads every 5 s.
        </p>
      </div>
    );
  }

  const champ = snap.champion;
  const totalTrades = snap.agents.reduce((s, a) => s + a.wins + a.losses, 0);
  const totalPnl = snap.agents.reduce((s, a) => s + a.total_pnl_usd, 0);
  const totalR = snap.agents.reduce((s, a) => s + a.total_r, 0);

  return (
    <div className="space-y-6">
      <section className="relative rounded-2xl overflow-hidden h-[75vh] -mx-6 md:mx-0 border border-edge/60">
        <Arena agents={snap.agents} generation={snap.generation ?? 0} />

        {/* HUD — top */}
        <div className="pointer-events-none absolute top-0 left-0 right-0 p-6 flex items-start justify-between">
          <div>
            <div className="text-[0.65rem] tracking-[0.4em] text-cyan uppercase">
              The tournament
            </div>
            <h2 className="text-3xl md:text-5xl font-semibold text-slate-100 mt-2 tracking-tight">
              {snap.n_agents} agents. One champion.
            </h2>
            <p className="text-xs text-mist mt-2 max-w-md">
              Scoreboard picks the winner; the winner&apos;s decisions
              drive the executor. Position lerps when ranks reshuffle.
            </p>
          </div>
          <div className="text-right text-xs space-y-1">
            <SourceBadge source={snap.source} />
            <div className="text-mist num">{fmt(snap.generated_at)}</div>
            {snap.generation ? (
              <div className="text-amber num">
                Generation {snap.generation.toString().padStart(3, "0")}
              </div>
            ) : null}
          </div>
        </div>

        {/* HUD — bottom */}
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 p-6 flex items-end justify-between">
          {champ ? (
            <div className="panel px-5 py-4 pointer-events-auto backdrop-blur-sm bg-black/30">
              <div className="text-[0.65rem] tracking-[0.4em] text-amber uppercase">
                Current champion
              </div>
              <div className="mt-1 text-xl font-mono text-slate-100">
                {champ.agent_id}
              </div>
              <div className="flex gap-4 text-xs mt-2 num">
                <span>
                  <span className="text-mist">Σ R</span>{" "}
                  <span
                    className={
                      champ.total_r >= 0 ? "text-green" : "text-red"
                    }
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
                <span>
                  <span className="text-mist">PnL</span>{" "}
                  <span
                    className={
                      champ.total_pnl_usd >= 0 ? "text-green" : "text-red"
                    }
                  >
                    {champ.total_pnl_usd >= 0 ? "+" : ""}$
                    {champ.total_pnl_usd.toFixed(0)}
                  </span>
                </span>
              </div>
            </div>
          ) : null}

          {/* Family legend */}
          <div className="flex flex-wrap gap-3 items-center text-[0.65rem] text-mist pointer-events-auto justify-end max-w-[360px]">
            {Object.entries(FAMILY_COLORS)
              .filter(([k]) => k !== "other" && familiesActive.includes(k))
              .map(([k, v]) => (
                <span key={k} className="flex items-center gap-1.5">
                  <span
                    className="inline-block w-2 h-2 rounded-full"
                    style={{ background: v, boxShadow: `0 0 8px ${v}` }}
                  />
                  <span className="font-mono uppercase tracking-widest">{k}</span>
                </span>
              ))}
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Leaderboard agents={snap.agents} />
        </div>
        <div className="space-y-6">
          <div className="panel p-5">
            <div className="text-xs uppercase tracking-[0.3em] text-mist">
              Aggregate
            </div>
            <div className="mt-4 space-y-3 num">
              <div className="flex justify-between text-sm">
                <span className="text-mist">Population</span>
                <span>{snap.n_agents}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-mist">Total decisions</span>
                <span>{totalTrades}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-mist">Aggregate Σ R</span>
                <span className={totalR >= 0 ? "text-green" : "text-red"}>
                  {totalR >= 0 ? "+" : ""}
                  {totalR.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-mist">Aggregate PnL</span>
                <span className={totalPnl >= 0 ? "text-green" : "text-red"}>
                  {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-mist">Generation</span>
                <span>{snap.generation ?? 0}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-mist">Active families</span>
                <span>{familiesActive.length}</span>
              </div>
            </div>
          </div>

          <div className="panel p-5">
            <div className="text-xs uppercase tracking-[0.3em] text-mist">
              How it works
            </div>
            <ol className="mt-3 space-y-2 text-sm text-slate-300 list-decimal list-inside">
              <li>
                Binance public WS streams live forced-order events.
              </li>
              <li>
                Every agent emits an independent opinion (or abstains).
              </li>
              <li>
                Scoreboard tracks per-agent Σ R and rolling Sharpe,
                identifying the current champion.
              </li>
              <li>
                The champion&apos;s decision → executor (Hyperliquid EIP-712
                + risk guard).
              </li>
              <li>
                Every N events, the weakest half is replaced via log-space
                Gaussian mutation + same-family crossover — a new generation.
              </li>
            </ol>
          </div>
        </div>
      </section>
    </div>
  );
}
