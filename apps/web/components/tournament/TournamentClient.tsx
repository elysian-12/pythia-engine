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
const DEFAULT_RISK_FRACTION = 0.01;
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

function CertificationBadge({
  cert,
}: {
  cert: NonNullable<SwarmSnapshot["champion_certification"]>;
}) {
  const dsrPass = cert.dsr >= 0.95;
  const psrPass = cert.psr >= 0.95;
  const ciPass =
    cert.sharpe_ci_lo !== null && cert.sharpe_ci_lo > 0;
  const allPass = dsrPass && psrPass && ciPass;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[0.6rem] uppercase tracking-[0.2em] px-2 py-0.5 rounded-sm ring-1 ${
        allPass
          ? "ring-green/60 text-green bg-green/5"
          : "ring-amber/60 text-amber bg-amber/5"
      }`}
      title={`PSR ${cert.psr.toFixed(3)} · DSR ${cert.dsr.toFixed(3)} · Sharpe CI 95% [${(cert.sharpe_ci_lo ?? 0).toFixed(2)}, ${(cert.sharpe_ci_hi ?? 0).toFixed(2)}] · skew ${cert.skew.toFixed(2)} · kurt ${cert.kurtosis.toFixed(2)} · ${cert.n_trials} trials`}
    >
      <span>
        {allPass ? "Quant-certified" : "Statistically uncertain"}
      </span>
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
  const [riskFraction, setRiskFraction] = useState<number>(DEFAULT_RISK_FRACTION);

  // Refs mirror state so callbacks passed to AutoPilot stay referentially
  // stable. Without this, `onFire` recreates each time `marks` updates and
  // the autopilot's interval re-arm chain dies.
  const snapRef = useRef<SwarmSnapshot | null>(null);
  const copyAgentRef = useRef<string | null>(null);
  const marksRef = useRef<{ BTC: number | null; ETH: number | null }>({
    BTC: null,
    ETH: null,
  });
  const riskFractionRef = useRef<number>(DEFAULT_RISK_FRACTION);
  useEffect(() => {
    snapRef.current = snap;
  }, [snap]);
  useEffect(() => {
    copyAgentRef.current = copyAgent;
  }, [copyAgent]);
  useEffect(() => {
    marksRef.current = marks;
  }, [marks]);
  useEffect(() => {
    riskFractionRef.current = riskFraction;
  }, [riskFraction]);

  // Read user-configured risk fraction once on mount + whenever the
  // SettingsForm broadcasts a save (CustomEvent for same-tab + storage
  // event for cross-tab). Keeps the paper sizing in sync with the slider.
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const r = await fetch("/api/config", { cache: "no-store" });
        if (!r.ok) return;
        const c = (await r.json()) as { risk_fraction?: number };
        if (!alive) return;
        if (typeof c.risk_fraction === "number" && c.risk_fraction > 0) {
          setRiskFraction(c.risk_fraction);
        }
      } catch {
        // ignore
      }
    };
    refresh();
    const onStorage = (e: StorageEvent) => {
      if (e.key === "pythia-swarm-config") refresh();
    };
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<{ risk_fraction?: number }>).detail;
      if (detail && typeof detail.risk_fraction === "number" && detail.risk_fraction > 0) {
        setRiskFraction(detail.risk_fraction);
      }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("pythia-config-updated", onCustom);
    return () => {
      alive = false;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pythia-config-updated", onCustom);
    };
  }, []);

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

  // One-shot mark fetch on mount so even the first manual EventSimulator
  // fire opens a paper position at a real price, not the DEFAULT fallback.
  useEffect(() => {
    let alive = true;
    fetch("/api/marks", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { marks: { BTC: number | null; ETH: number | null } } | null) => {
        if (!alive || !d) return;
        setMarks((prev) => ({
          BTC: d.marks.BTC ?? prev.BTC,
          ETH: d.marks.ETH ?? prev.ETH,
        }));
      })
      .catch(() => {
        // ignore — fall back to DEFAULT_*
      });
    return () => {
      alive = false;
    };
  }, []);

  // Poll live BTC/ETH marks every 6s once we have any open positions or the
  // autopilot is active — saves bandwidth in the idle case. Merges per-asset
  // so that a transient one-sided null from Kiyotaka does not erase a value
  // the other asset already had.
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
        setMarks((prev) => ({
          BTC: d.marks.BTC ?? prev.BTC,
          ETH: d.marks.ETH ?? prev.ETH,
        }));
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
    return simulateReactions(lastEvent, snap.agents, snap.regime);
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

  // Stable across renders — reads dynamic state from refs. AutoPilot stores
  // this in onFireRef once and keeps polling without rebuilding its timer.
  const onFire = useCallback((ev: SimEvent) => {
    const t0 = performance.now();
    const currentSnap = snapRef.current;
    if (!currentSnap) return;
    const rxs = simulateReactions(ev, currentSnap.agents, currentSnap.regime);
    const championId = currentSnap.champion?.agent_id ?? null;
    // Stamp the wall-clock latency of the synchronous portion of the
    // pipeline (simulate reactions + size the trade). The Rust live
    // executor logs the same number for its async path; surfacing it
    // here lets the visitor see the same end-to-end timing.
    const latencyMs = Math.max(1, Math.round(performance.now() - t0));
    const entry: FeedEntry = {
      id: ev.id,
      ts: ev.ts,
      event: ev,
      reactions: rxs,
      championId,
      latencyMs,
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
    const liveMarks = marksRef.current;
    const btcPx = liveMarks.BTC ?? DEFAULT_BTC;
    const ethPx = liveMarks.ETH ?? DEFAULT_ETH;
    const sim = simulateCopyTrade(
      mirrored,
      ev,
      rxs,
      EQUITY_USD,
      riskFractionRef.current,
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
  }, []);

  const onPrices = useCallback(
    (p: { BTC: number | null; ETH: number | null }) => {
      setMarks((prev) => ({
        BTC: p.BTC ?? prev.BTC,
        ETH: p.ETH ?? prev.ETH,
      }));
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
              <div className="grid grid-cols-4 gap-x-5 gap-y-1 text-xs mt-2 num">
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
                <span title="Average R per trade">
                  <span className="text-mist">E[R]</span>{" "}
                  <span
                    className={
                      (champ.expectancy_r ?? 0) >= 0 ? "text-green" : "text-red"
                    }
                  >
                    {champ.expectancy_r !== undefined
                      ? (champ.expectancy_r >= 0 ? "+" : "") + champ.expectancy_r.toFixed(2)
                      : "—"}
                  </span>
                </span>
                <span title="Profit factor — gross win R / gross loss R">
                  <span className="text-mist">PF</span>{" "}
                  <span
                    className={
                      (champ.profit_factor ?? 0) >= 1.5
                        ? "text-green"
                        : (champ.profit_factor ?? 0) >= 1
                          ? "text-amber"
                          : "text-red"
                    }
                  >
                    {champ.profit_factor !== undefined && Number.isFinite(champ.profit_factor)
                      ? champ.profit_factor.toFixed(2)
                      : "—"}
                  </span>
                </span>
                <span title="Sharpe of per-trade R + 95% block-bootstrap CI">
                  <span className="text-mist">Sharpe</span>{" "}
                  <span
                    className={
                      champ.rolling_sharpe > 0.5
                        ? "text-green"
                        : champ.rolling_sharpe > 0
                          ? "text-amber"
                          : "text-red"
                    }
                  >
                    {champ.rolling_sharpe.toFixed(2)}
                  </span>
                  {snap.champion_certification?.sharpe_ci_lo != null &&
                  snap.champion_certification?.sharpe_ci_hi != null ? (
                    <span className="text-[0.55rem] text-mist ml-1">
                      [{snap.champion_certification.sharpe_ci_lo.toFixed(2)},{" "}
                      {snap.champion_certification.sharpe_ci_hi.toFixed(2)}]
                    </span>
                  ) : null}
                </span>
                {snap.champion_certification ? (
                  <>
                    <span title="Probabilistic Sharpe Ratio — Bailey & López de Prado 2012">
                      <span className="text-mist">PSR</span>{" "}
                      <span
                        className={
                          snap.champion_certification.psr >= 0.95
                            ? "text-green"
                            : snap.champion_certification.psr >= 0.5
                              ? "text-amber"
                              : "text-red"
                        }
                      >
                        {snap.champion_certification.psr.toFixed(2)}
                      </span>
                    </span>
                    <span title="Deflated Sharpe Ratio — corrects PSR for multiple-testing bias across the swarm">
                      <span className="text-mist">DSR</span>{" "}
                      <span
                        className={
                          snap.champion_certification.dsr >= 0.95
                            ? "text-green"
                            : snap.champion_certification.dsr >= 0.5
                              ? "text-amber"
                              : "text-red"
                        }
                      >
                        {snap.champion_certification.dsr.toFixed(2)}
                      </span>
                    </span>
                  </>
                ) : null}
              </div>
              {snap.champion_certification ? (
                <div className="mt-2">
                  <CertificationBadge cert={snap.champion_certification} />
                </div>
              ) : null}
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
            risk_fraction={riskFraction}
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

