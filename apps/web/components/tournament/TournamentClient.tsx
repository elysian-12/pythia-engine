"use client";

import { useEffect, useState } from "react";
import { Arena } from "./Arena";
import { Leaderboard } from "./Leaderboard";
import { fetchSwarm, FAMILY_COLORS, type SwarmSnapshot } from "@/lib/swarm";

function fmt(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString();
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

  if (!snap) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center text-mist">
        {err ?? "Loading swarm…"}
      </div>
    );
  }

  const champ = snap.champion;
  const totalTrades = snap.agents.reduce((s, a) => s + a.wins + a.losses, 0);
  const totalPnl = snap.agents.reduce((s, a) => s + a.total_pnl_usd, 0);
  const activeFamilies = Array.from(
    new Set(snap.agents.map((a) => a.agent_id.split("-")[0] + (a.agent_id.split("-")[1] === "trend" || a.agent_id.split("-")[1] === "fade" || a.agent_id.split("-")[1] === "arb" || a.agent_id.split("-")[1] === "breakout" ? "-" + a.agent_id.split("-")[1] : ""))),
  );

  return (
    <div className="space-y-6">
      <section className="relative rounded-2xl overflow-hidden h-[70vh] -mx-6 md:mx-0">
        <Arena agents={snap.agents} />
        <div className="pointer-events-none absolute top-0 left-0 right-0 p-6 flex items-start justify-between">
          <div>
            <div className="text-[0.65rem] tracking-[0.35em] text-cyan uppercase">
              The swarm
            </div>
            <h2 className="text-3xl md:text-4xl font-semibold text-slate-100 mt-1">
              {snap.n_agents} agents · one champion
            </h2>
            <p className="text-xs text-mist mt-2 max-w-md">
              Heterogeneous traders — systematic rules, LLM personas,
              meta-agents — all see the same event stream. The
              scoreboard picks the champion; the champion&apos;s
              strategy drives the executor.
            </p>
          </div>
          <div className="text-right text-xs text-mist">
            <div>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-green align-middle mr-2 animate-pulse" />
              {snap.source === "live" ? "Live" : "Demo"} · {fmt(snap.generated_at)}
            </div>
            <div className="mt-1 num">
              Consensus fires: {snap.consensus.fires}
            </div>
          </div>
        </div>

        {champ ? (
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 p-6 flex items-end justify-between">
            <div className="panel px-4 py-3 pointer-events-auto">
              <div className="text-[0.65rem] tracking-[0.35em] text-amber uppercase">
                Current champion
              </div>
              <div className="mt-1 text-lg font-mono text-slate-100">
                {champ.agent_id}
              </div>
              <div className="text-xs text-mist num mt-1">
                Σ R {champ.total_r >= 0 ? "+" : ""}
                {champ.total_r.toFixed(2)} · win {(champ.win_rate * 100).toFixed(0)}% ·{" "}
                {champ.wins + champ.losses} trades
              </div>
            </div>
            <div className="flex gap-3 items-center text-xs text-mist pointer-events-auto">
              {Object.entries(FAMILY_COLORS)
                .filter(([k]) => k !== "other")
                .map(([k, v]) => (
                  <span key={k} className="flex items-center gap-1.5">
                    <span
                      className="inline-block w-2 h-2 rounded-full"
                      style={{ background: v, boxShadow: `0 0 6px ${v}` }}
                    />
                    <span className="font-mono">{k}</span>
                  </span>
                ))}
            </div>
          </div>
        ) : null}
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Leaderboard agents={snap.agents} />
        </div>
        <div className="space-y-6">
          <div className="panel p-4">
            <div className="text-xs uppercase tracking-[0.3em] text-mist">
              Aggregate
            </div>
            <div className="mt-3 space-y-3 num">
              <div className="flex justify-between text-sm">
                <span className="text-mist">Total decisions</span>
                <span>{totalTrades}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-mist">Total PnL</span>
                <span className={totalPnl >= 0 ? "text-green" : "text-red"}>
                  {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-mist">Consensus fires</span>
                <span>{snap.consensus.fires}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-mist">Active families</span>
                <span>{activeFamilies.length}</span>
              </div>
            </div>
          </div>

          <div className="panel p-4">
            <div className="text-xs uppercase tracking-[0.3em] text-mist">
              How it works
            </div>
            <ol className="mt-3 space-y-2 text-sm text-slate-300 list-decimal list-inside">
              <li>
                Binance public WS streams forced-order events live.
              </li>
              <li>
                Every agent emits an independent opinion (or passes).
              </li>
              <li>
                Scoreboard tracks per-agent rolling Sharpe + Σ R and
                identifies the current champion.
              </li>
              <li>
                The champion&apos;s own decision is applied via the
                executor — Hyperliquid EIP-712 + risk guard.
              </li>
              <li>
                Every N events, the weakest half are replaced via log-space
                Gaussian mutation + same-family crossover.
              </li>
            </ol>
          </div>
        </div>
      </section>
    </div>
  );
}
