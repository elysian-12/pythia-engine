"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentLineageGraph } from "./AgentLineageGraph";
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
  applySessionDelta,
  FAMILY_COLORS,
  agentFamily,
  type SwarmSnapshot,
} from "@/lib/swarm";
import type { SimEvent } from "@/lib/simulate";
import { simulateReactions, simulateCopyTrade } from "@/lib/simulate";
import { checkTriggers, sumRealized, type PaperPosition } from "@/lib/paper";
import { routeTrade } from "@/lib/router";
import {
  DEFAULT_PORTFOLIO_CONFIG,
  decideEntry,
  manageOnEvent,
  manageOnMark,
  type PortfolioConfig,
} from "@/lib/portfolio";

const COPY_LS_KEY = "pythia-copytrade-agent";
const FEED_MAX = 25;
const EQUITY_USD = 1000;
const DEFAULT_RISK_FRACTION = 0.01;
const DEFAULT_BTC = 77_500;
const DEFAULT_ETH = 3_200;

function fmt(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString();
}

/** Coerce an incoming config value into a sane numeric range; falls
 *  back to `prev` when missing or invalid. Keeps the portfolio rules
 *  resilient to partial /api/config responses (older clients, etc). */
function clampNum(v: unknown, prev: number, lo: number, hi: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return prev;
  return Math.max(lo, Math.min(hi, v));
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
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null);
  const [autopilotOn, setAutopilotOn] = useState(false);

  // Paper HL ledger — opens when the copy-trader's agent reacts to an event.
  const [openPositions, setOpenPositions] = useState<PaperPosition[]>([]);
  const [closedPositions, setClosedPositions] = useState<PaperPosition[]>([]);
  const [marks, setMarks] = useState<{ BTC: number | null; ETH: number | null }>(
    { BTC: null, ETH: null },
  );
  const [riskFraction, setRiskFraction] = useState<number>(DEFAULT_RISK_FRACTION);
  // Portfolio meta-agent settings — open caps, exit rules. Loaded from
  // /api/config + same broadcast plumbing as risk_fraction.
  const [portfolioCfg, setPortfolioCfg] = useState<PortfolioConfig>(
    DEFAULT_PORTFOLIO_CONFIG,
  );

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
  const portfolioCfgRef = useRef<PortfolioConfig>(DEFAULT_PORTFOLIO_CONFIG);
  const openPositionsRef = useRef<PaperPosition[]>([]);
  const closedPositionsRef = useRef<PaperPosition[]>([]);
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
  useEffect(() => {
    portfolioCfgRef.current = portfolioCfg;
  }, [portfolioCfg]);
  useEffect(() => {
    openPositionsRef.current = openPositions;
  }, [openPositions]);
  useEffect(() => {
    closedPositionsRef.current = closedPositions;
    // Persist closed positions to localStorage so /performance can
    // replay the meta-agent's full trade history across page loads.
    // Cap at 500 trades — that's months of typical session activity
    // at the live polling cadence, well under the localStorage 5MB
    // ceiling. Older trades drop off the front (FIFO).
    if (typeof window === "undefined") return;
    try {
      const trimmed = closedPositions.slice(-500);
      window.localStorage.setItem(
        "pythia-closed-positions",
        JSON.stringify(trimmed),
      );
    } catch {
      // localStorage full / disabled — fail silently; the live
      // ledger still works in-memory.
    }
  }, [closedPositions]);

  // Hydrate from localStorage on mount so a fresh page-load picks up
  // the prior session's closed positions and the realized-pnl line
  // doesn't reset to zero. Stops the "every reload looks like a
  // brand-new account" UX.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem("pythia-closed-positions");
      if (!raw) return;
      const parsed = JSON.parse(raw) as PaperPosition[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        setClosedPositions(parsed);
      }
    } catch {
      // ignore corrupt LS payload
    }
  }, []);

  // Read user-configured risk fraction + portfolio rules once on mount
  // and whenever the SettingsForm broadcasts a save (CustomEvent for
  // same-tab + storage event for cross-tab).
  useEffect(() => {
    let alive = true;
    const apply = (c: Partial<PortfolioConfig & { risk_fraction: number }>) => {
      if (!alive) return;
      if (typeof c.risk_fraction === "number" && c.risk_fraction > 0) {
        setRiskFraction(c.risk_fraction);
      }
      setPortfolioCfg((prev) => ({
        max_open_positions: clampNum(c.max_open_positions, prev.max_open_positions, 1, 32),
        min_conviction: clampNum(c.min_conviction, prev.min_conviction, 0, 1),
        time_stop_hours: clampNum(c.time_stop_hours, prev.time_stop_hours, 0, 168),
        trail_after_r: clampNum(c.trail_after_r, prev.trail_after_r, 0, 5),
        swarm_flip_conviction: clampNum(
          c.swarm_flip_conviction,
          prev.swarm_flip_conviction,
          0,
          1,
        ),
        min_hold_minutes: clampNum(c.min_hold_minutes, prev.min_hold_minutes, 0, 240),
        max_session_dd_pct: clampNum(c.max_session_dd_pct, prev.max_session_dd_pct, 0, 1),
        correlation_size_factor: clampNum(
          c.correlation_size_factor,
          prev.correlation_size_factor,
          0,
          1,
        ),
      }));
    };
    const refresh = async () => {
      try {
        const r = await fetch("/api/config", { cache: "no-store" });
        if (!r.ok) return;
        apply((await r.json()) as Partial<PortfolioConfig & { risk_fraction: number }>);
      } catch {
        // ignore
      }
    };
    refresh();
    const onStorage = (e: StorageEvent) => {
      if (e.key === "pythia-swarm-config") refresh();
    };
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<Partial<PortfolioConfig & { risk_fraction: number }>>).detail;
      if (detail) apply(detail);
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

  // Mark-tick policy sweep: stop / TP / trail / time stop. Runs on
  // every mark refresh. The portfolio meta-agent holds the trail-stop
  // and time-stop logic; checkTriggers() still owns the original stop
  // and TP since those are price-driven and the meta-agent's trail
  // adjustment writes through to the same `stop` field.
  useEffect(() => {
    if (openPositions.length === 0) return;
    const cfg = portfolioCfgRef.current;
    const nowSec = Math.floor(Date.now() / 1000);
    const { updated, closes } = manageOnMark(openPositions, marks, cfg, nowSec);
    const closeIds = new Set(closes.map((c) => c.id));
    const closesByAge: Record<string, { reason: PaperPosition["close_reason"]; mark: number }> = {};
    for (const c of closes) closesByAge[c.id] = { reason: c.reason, mark: c.mark };

    // After meta-agent applies trails, re-check stop / TP triggers — a
    // ratcheted stop may now be in the money.
    const hits: PaperPosition[] = [];
    const survivors: PaperPosition[] = [];
    for (const p of updated) {
      if (closeIds.has(p.id)) {
        const c = closesByAge[p.id];
        const px = c.mark;
        const diff = p.side === "long" ? px - p.entry : p.entry - px;
        hits.push({
          ...p,
          closed_at: nowSec,
          close_px: px,
          close_reason: c.reason,
          pnl_usd: diff * p.size_contracts,
        });
        continue;
      }
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
      // If the trail rule pulled the stop above entry, surface the
      // close as `trail` rather than `stop` — semantically distinct
      // (locked-in profit vs. losing trade hitting initial stop).
      const initial = p.initial_stop ?? p.stop;
      const trailed = p.side === "long" ? p.stop > initial : p.stop < initial;
      const reason: PaperPosition["close_reason"] =
        trig === "stop" && trailed ? "trail" : trig;
      const diff = p.side === "long" ? m - p.entry : p.entry - m;
      hits.push({
        ...p,
        closed_at: nowSec,
        close_px: m,
        close_reason: reason,
        pnl_usd: diff * p.size_contracts,
      });
    }
    // Bail if nothing actually changed — avoids re-renders when the
    // only diff is a transient peak-watermark update.
    const noTrailChange = updated.every((u, i) => {
      const o = openPositions[i];
      return o && u.id === o.id && u.stop === o.stop && u.peak === o.peak;
    });
    if (hits.length === 0 && noTrailChange) return;
    setOpenPositions(survivors);
    if (hits.length > 0) setClosedPositions((prev) => [...prev, ...hits]);
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

    // Route via the new specialist + ensemble policy. Replaces "follow
    // global champion" with "follow this kind's specialist if the
    // weighted-Sharpe ensemble agrees with conviction > 0.25".
    const route = routeTrade(ev, rxs, currentSnap.agents);
    const userOverride = copyAgentRef.current; // explicit pin from CopyTradePanel

    // Keep float precision — performance.now() reports sub-ms (clamped
    // to ~5µs in Chrome). Rounding to integer ms collapsed every cycle
    // to "1ms"; the formatter downstream picks ms / µs / ns adaptively.
    const latencyMs = performance.now() - t0;
    const entry: FeedEntry = {
      id: ev.id,
      ts: ev.ts,
      event: ev,
      reactions: rxs,
      championId,
      latencyMs,
      routing: {
        specialist_id: route.specialist?.agent_id ?? null,
        specialist_short:
          route.specialist?.agent_id.replace(/^gen\d+-mut\d+-/, "") ?? null,
        fired_count: route.vote.fired_count,
        total_reactors: rxs.length,
        vote_direction: route.vote.direction,
        conviction: route.vote.conviction,
        decision_direction: route.decision.direction,
        size_factor: route.decision.size_factor,
        rationale: route.decision.rationale,
      },
    };
    setLastEvent(ev);
    setFeed((prev) => [entry, ...prev].slice(0, FEED_MAX));
    setPulseKey((k) => k + 1);
    setLastLatencyMs(latencyMs);

    setSnap((prevSnap) =>
      prevSnap ? applySessionDelta(prevSnap, rxs, ev.ts) : prevSnap,
    );

    // Paper-HL placement. If the user pinned a specific agent in the
    // CopyTradePanel we honour that (manual override); otherwise we
    // follow the router's chosen specialist + ensemble direction +
    // ensemble-conviction-scaled size. Both paths run through the
    // portfolio meta-agent (decideEntry) which holds the cap, the
    // conviction floor, and the reversal logic.
    const liveMarks = marksRef.current;
    const btcPx = liveMarks.BTC ?? DEFAULT_BTC;
    const ethPx = liveMarks.ETH ?? DEFAULT_ETH;

    // Step 1: act on swarm flips first — close any open positions on
    // this asset whose direction is now opposite the high-conviction
    // ensemble vote AND have aged past the min_hold_minutes floor.
    // "Follow the swarm out" rule, but only when the swarm is sure
    // and the position has had time to find its direction.
    const nowSec = Math.floor(Date.now() / 1000);
    const flipIds = manageOnEvent({
      asset: ev.asset,
      vote_direction: route.vote.direction,
      conviction: route.vote.conviction,
      positions: openPositionsRef.current,
      config: portfolioCfgRef.current,
      now_secs: nowSec,
    });
    if (flipIds.length > 0) {
      const px = ev.asset === "BTC" ? btcPx : ethPx;
      setOpenPositions((prev) => {
        const remain: PaperPosition[] = [];
        const closed: PaperPosition[] = [];
        for (const p of prev) {
          if (flipIds.includes(p.id)) {
            const m = p.asset === "BTC" ? marksRef.current.BTC : marksRef.current.ETH;
            const cpx = m ?? px;
            const diff = p.side === "long" ? cpx - p.entry : p.entry - cpx;
            closed.push({
              ...p,
              closed_at: Math.floor(Date.now() / 1000),
              close_px: cpx,
              close_reason: "swarm-flip",
              pnl_usd: diff * p.size_contracts,
            });
          } else {
            remain.push(p);
          }
        }
        if (closed.length > 0) {
          setClosedPositions((c) => [...c, ...closed]);
        }
        return remain;
      });
    }

    // Step 2: figure out the new direction + size. User override wins
    // over router; otherwise router decides.
    let direction: "long" | "short" | null = null;
    let agentId: string | null = null;
    let entryPx = 0;
    let stop = 0;
    let take = 0;
    let notional = 0;

    if (userOverride) {
      const mirrored = currentSnap.agents.find((a) => a.agent_id === userOverride);
      if (!mirrored) return;
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
      direction = sim.direction;
      agentId = sim.agent_id;
      entryPx = sim.entry;
      stop = sim.stop;
      take = sim.take_profit;
      notional = sim.size_usd;
    } else {
      if (!route.decision.direction || !route.specialist) return;
      const price = ev.asset === "BTC" ? btcPx : ethPx;
      if (!Number.isFinite(price) || price <= 0) return;
      // Stop multiplier widened 1.5 → 2.0 ATR. The 1.5× stops were
      // catching too much noise on minute-resolution moves; 2.0× is
      // closer to the systematic agents' internal risk model.
      // Take-profit kept at 3× ATR so reward:risk stays at 1.5:1.
      const atr = price * 0.005;
      const stopDist = 2.0 * atr;
      const riskUsd =
        EQUITY_USD * riskFractionRef.current * route.decision.size_factor;
      const n = Math.min((riskUsd * price) / stopDist, EQUITY_USD * 3);
      if (n <= 0) return;
      direction = route.decision.direction;
      agentId = route.specialist.agent_id;
      entryPx = price;
      stop = direction === "long" ? price - stopDist : price + stopDist;
      take = direction === "long" ? price + 3 * atr : price - 3 * atr;
      notional = n;
    }

    // Step 3: ask the portfolio meta-agent what to do with this fresh
    // signal, given current exposure. "skip" / "open" / "reverse".
    // Pass realised session PnL + equity so the drawdown circuit-breaker
    // can halt new entries on tilt. Realised PnL is summed live from
    // the closedPositionsRef set by the mark sweep.
    const realizedNow = sumRealized(closedPositionsRef.current);
    const action = decideEntry({
      asset: ev.asset,
      direction,
      conviction: route.vote.conviction,
      open: openPositionsRef.current,
      config: portfolioCfgRef.current,
      session_realized_pnl: realizedNow,
      equity_usd: EQUITY_USD,
    });
    if (action.kind === "skip") return;
    // Honour any correlation-aware size multiplier the meta-agent
    // returned. After the `kind === "skip"` early-return TypeScript
    // narrows action to the open/reverse variants, both of which carry
    // the optional `size_multiplier` field. notional is downstream of
    // `n`, so we multiply once here and the size_contracts derives
    // from notional/entryPx in the setOpenPositions call below.
    const sizeMul = action.size_multiplier ?? 1;
    if (sizeMul !== 1) {
      notional *= sizeMul;
    }

    setOpenPositions((prev) => {
      let next = prev;
      // Reversal: close the opposite position before opening the new one.
      if (action.kind === "reverse") {
        const opp = prev.find((p) => p.id === action.close_id);
        if (opp) {
          const m = opp.asset === "BTC" ? marksRef.current.BTC : marksRef.current.ETH;
          const cpx = m ?? opp.entry;
          const diff = opp.side === "long" ? cpx - opp.entry : opp.entry - cpx;
          setClosedPositions((c) => [
            ...c,
            {
              ...opp,
              closed_at: Math.floor(Date.now() / 1000),
              close_px: cpx,
              close_reason: "reverse",
              pnl_usd: diff * opp.size_contracts,
            },
          ]);
          next = prev.filter((p) => p.id !== opp.id);
        }
      }
      // Defensive cap recheck — meta-agent already enforced this, but
      // a concurrent setState burst could push the array past the cap
      // before the meta-agent runs against fresh state.
      if (next.length >= portfolioCfgRef.current.max_open_positions) return next;
      return [
        ...next,
        {
          id: `pos-${ev.id}`,
          agent_id: agentId!,
          asset: ev.asset,
          side: direction!,
          size_contracts: notional / entryPx,
          notional_usd: notional,
          entry: entryPx,
          initial_stop: stop,
          stop,
          take_profit: take,
          opened_at: ev.ts,
        },
      ];
    });
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
    <div className="space-y-4 sm:space-y-6">
      {/* HERO header — flat (the 3D arena was retired in favour of the
          force-directed lineage graph below; that view shows real
          mutation/evolution structure instead of a decorative scene). */}
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 chip chip-cyan text-[0.6rem]">
                <span className="w-1 h-1 rounded-full bg-cyan animate-pulse" />
                Live
              </span>
              <span className="text-[0.6rem] sm:text-[0.65rem] tracking-[0.4em] text-purple-300 uppercase">
                Pythia tournament
              </span>
            </div>
            <h2 className="text-xl sm:text-3xl md:text-5xl font-semibold text-slate-100 mt-1 tracking-tight leading-tight">
              Events → Swarm → Champion → Your trade
            </h2>
            <p className="mt-2 text-[0.7rem] text-mist max-w-xl">
              Live decision loop on real Kiyotaka events. The leaderboard
              re-ranks the moment an agent fires — page is dynamic, not a
              static snapshot.
            </p>
          </div>
          <div className="text-right space-y-1 shrink-0">
            <KiyotakaBadge />
            <SourceBadge source={snap.source} />
            <RegimeBadge regime={snap.regime} />
            <div className="text-[0.65rem] text-mist num">
              {fmt(snap.generated_at)}
            </div>
            <PhaseBadge phase={phase} />
          </div>
        </div>

        {champ ? (
          <div className="panel p-3 sm:p-4 backdrop-blur-sm bg-black/30">
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="text-[0.6rem] sm:text-[0.65rem] tracking-[0.3em] sm:tracking-[0.4em] text-amber uppercase">
                  Current champion
                </div>
                <div className="mt-1 text-base sm:text-lg font-mono text-slate-100 truncate">
                  {champ.agent_id}
                </div>
              </div>
              {snap.champion_certification ? (
                <CertificationBadge cert={snap.champion_certification} />
              ) : null}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-x-3 sm:gap-x-5 gap-y-1 text-[0.7rem] sm:text-xs mt-3 num">
              <span>
                <span className="text-mist">Σ R</span>{" "}
                <span className={champ.total_r >= 0 ? "text-green" : "text-red"}>
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
                <span className={(champ.expectancy_r ?? 0) >= 0 ? "text-green" : "text-red"}>
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
                  <span title="Deflated Sharpe Ratio — corrects PSR for multiple-testing bias">
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
          </div>
        ) : null}
      </section>

      {/* Force-directed lineage graph — interactive replacement for
          the prior 3D arena. Updates with each cron-driven snapshot
          refresh; champion glows gold, families colour-coded, edges
          encode mutation/revive lineage. */}
      <AgentLineageGraph
        agents={snap.agents}
        championId={champ?.agent_id ?? null}
        generation={snap.generation ?? 0}
      />

      {/* Closed-loop pipeline visualizer */}
      <section>
        <PipelineRail
          pulseKey={pulseKey}
          autopilotOn={autopilotOn}
          openCount={openPositions.length}
          realizedPnl={sumRealized(closedPositions)}
          generation={snap.generation ?? 0}
          championId={champ?.agent_id ?? null}
          lastLatencyMs={lastLatencyMs}
        />
      </section>

      {/* New-user wayfinding: a single "what to do here" strip with three
          numbered actions matching the columns below. Without this,
          first-time visitors land on a wall of similarly-styled panels
          and have no entry point. */}
      <section
        aria-label="Quick start"
        className="rounded-md border border-royal/30 bg-royal/5 px-3 sm:px-4 py-3 flex items-start sm:items-center flex-wrap gap-x-4 sm:gap-x-6 gap-y-2 text-[0.7rem] sm:text-[0.75rem]"
      >
        <span className="text-[0.6rem] tracking-[0.4em] uppercase text-purple-300">
          Start here
        </span>
        <a href="#zone-controls" className="hover:text-cyan flex items-center gap-2">
          <span className="num text-purple-300">1.</span>
          Configure your size + risk
        </a>
        <a href="#zone-controls" className="hover:text-cyan flex items-center gap-2">
          <span className="num text-purple-300">2.</span>
          Watch the live feed (or fire a synthetic event)
        </a>
        <a href="#zone-trading" className="hover:text-cyan flex items-center gap-2">
          <span className="num text-purple-300">3.</span>
          Watch the paper position open under the champion
        </a>
        <a href="#zone-monitoring" className="hover:text-cyan flex items-center gap-2">
          <span className="num text-purple-300">4.</span>
          Read the trade feed + leaderboard
        </a>
      </section>

      {/* 3-column deck — each zone has its own header so a first-time
          visitor knows what each column is for at a glance. Order chosen
          to match the natural left-to-right reading flow: configure →
          observe positions → review history. */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6 items-start">
        {/* CONTROLS */}
        <section
          id="zone-controls"
          aria-labelledby="zone-controls-h"
          className="space-y-4"
        >
          <h2 id="zone-controls-h" className="zone-header">
            <span className="text-purple-300">A · Controls</span>
            <span className="text-mist normal-case tracking-normal text-[0.6rem]">
              your inputs · settings · autopilot · what-if events
            </span>
          </h2>
          <AutoPilot
            onFire={onFire}
            onPrices={onPrices}
            onStatus={setAutopilotOn}
          />
          <EventSimulator onFire={onFire} lastFired={lastEvent} />
          <SettingsForm />
        </section>

        {/* TRADING */}
        <section
          id="zone-trading"
          aria-labelledby="zone-trading-h"
          className="space-y-4"
        >
          <h2 id="zone-trading-h" className="zone-header">
            <span className="text-purple-300">B · Trading</span>
            <span className="text-mist normal-case tracking-normal text-[0.6rem]">
              your paper positions · who you mirror
            </span>
          </h2>
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
        </section>

        {/* MONITORING + INFO */}
        <section
          id="zone-monitoring"
          aria-labelledby="zone-monitoring-h"
          className="space-y-4"
        >
          <h2 id="zone-monitoring-h" className="zone-header">
            <span className="text-purple-300">C · Monitoring</span>
            <span className="text-mist normal-case tracking-normal text-[0.6rem]">
              live feed · how the swarm thinks
            </span>
          </h2>
          {/* The explainer sits above the feed on purpose — once the
              feed fills up it scrolls inside its own bounded height, so
              the 8-step walkthrough stays anchored on screen instead of
              getting pushed below the fold by every new event. */}
          <div className="panel p-5">
            <div className="text-xs uppercase tracking-[0.3em] text-mist">
              How the swarm gets smart
            </div>
            <ol className="mt-3 space-y-2 text-xs text-slate-300 leading-relaxed">
              <li>
                <span className="text-purple-300 font-mono">1. Event →</span>{" "}
                A market tick arrives from Kiyotaka — a forced
                liquidation, a funding spike, a price breakout, a
                Polymarket lead, or two of those at once.
              </li>
              <li>
                <span className="text-purple-300 font-mono">2. Vote →</span>{" "}
                All 27 agents see it at the same time. Each one decides
                independently: trade or sit out. 7 are rule-based, 5 are
                LLM personas reasoning in plain English.
              </li>
              <li>
                <span className="text-purple-300 font-mono">3. Self-check →</span>{" "}
                Before voting, every agent looks at its own recent
                results. If it's been losing money lately, it benches
                itself until it recovers (the self-backtest gate).
              </li>
              <li>
                <span className="text-purple-300 font-mono">4. Scoreboard →</span>{" "}
                After a trade closes, the realised win or loss feeds
                back. Each agent's running profit, win rate, and
                statistical confidence (Sharpe / PSR / DSR) update.
              </li>
              <li>
                <span className="text-purple-300 font-mono">5. Specialist →</span>{" "}
                For this kind of event, who has the best track record?
                Polymarket leads go to <span className="font-mono">polyedge</span>,
                liquidation cascades to <span className="font-mono">liq-trend</span>,
                funding spikes to <span className="font-mono">funding-trend</span>,
                and so on. Specialists, not generalists.
              </li>
              <li>
                <span className="text-purple-300 font-mono">6. Ensemble →</span>{" "}
                Among the agents that did fire, sum their votes weighted
                by track record. If they agree strongly enough, trade in
                that direction; if they're split, sit out. Size the
                trade by how confident the specialist usually is when
                right (quarter-Kelly).
              </li>
              <li>
                <span className="text-amber-300 font-mono">7. Evolution →</span>{" "}
                Every N events, the worst agents get replaced by tweaked
                copies of the best — small random parameter shifts plus
                some swaps between top performers in the same family.
                Bad agents die out; good ones spawn lookalikes.
              </li>
              <li>
                <span className="text-amber-300 font-mono">8. Trade →</span>{" "}
                The chosen direction + size opens a paper position on
                Hyperliquid. When that trade closes, its result flows
                straight back to step 4 — the loop closes.
              </li>
            </ol>
          </div>
          <LiveTradeFeed entries={feed} />
        </section>
      </section>

      {/* Full leaderboard */}
      <section aria-labelledby="zone-leaderboard-h" className="space-y-4">
        <h2 id="zone-leaderboard-h" className="zone-header">
          <span className="text-purple-300">D · Leaderboard</span>
          <span className="text-mist normal-case tracking-normal text-[0.6rem]">
            every agent · ranked by Σ R · click any column header to re-sort
          </span>
        </h2>
        <Leaderboard agents={snap.agents} />
      </section>
    </div>
  );
}

