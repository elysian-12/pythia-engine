// Portfolio meta-agent backtest harness.
//
// Runs the actual production code path — `lib/simulate.ts` →
// `lib/router.ts` → `lib/portfolio.ts` — against real Kiyotaka
// candle / funding history, hour by hour. Reports session metrics
// so we can see how profitable the configured rules really are.
//
// Run from apps/web:
//   npx tsx scripts/backtest/portfolio-backtest.ts
//
// Env:
//   KIYOTAKA_API_KEY      required
//   BACKTEST_DAYS         lookback window (default 30)
//   BACKTEST_EQUITY_USD   starting equity (default 1000)
//   BACKTEST_VERBOSE      print every event decision (1/0)

import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  simulateReactions,
  type SimAsset,
  type SimDirection,
  type SimEvent,
  type SimEventKind,
} from "../../lib/simulate";
import { routeTrade } from "../../lib/router";
import {
  DEFAULT_PORTFOLIO_CONFIG,
  decideEntry,
  manageOnEvent,
  manageOnMark,
  type PortfolioConfig,
} from "../../lib/portfolio";
import { unrealizedPnl, type CloseReason, type PaperPosition } from "../../lib/paper";
import type { AgentStats, RegimeInfo, SwarmSnapshot } from "../../lib/swarm";

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.KIYOTAKA_API_KEY;
if (!API_KEY) {
  console.error("KIYOTAKA_API_KEY is required");
  process.exit(1);
}
const DAYS = Number(process.env.BACKTEST_DAYS ?? 30);
const EQUITY_START = Number(process.env.BACKTEST_EQUITY_USD ?? 1000);
const VERBOSE = process.env.BACKTEST_VERBOSE === "1";
const RISK_FRACTION = 0.01;

type CandleHr = { ts: number; open: number; high: number; low: number; close: number; volume: number };
type FundingHr = { ts: number; rate: number };

async function kiyotaka<T>(url: URL): Promise<T> {
  const res = await fetch(url, {
    headers: { "X-Kiyotaka-Key": API_KEY!, "User-Agent": "pythia-backtest" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Kiyotaka ${url.pathname}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function fetchCandles(symbol: string, hoursBack: number): Promise<CandleHr[]> {
  const now = Math.floor(Date.now() / 1000);
  const url = new URL("https://api.kiyotaka.ai/v1/points");
  url.searchParams.set("type", "TRADE_SIDE_AGNOSTIC_AGG");
  url.searchParams.set("exchange", "BINANCE_FUTURES");
  url.searchParams.set("rawSymbol", symbol);
  url.searchParams.set("interval", "HOUR");
  url.searchParams.set("from", String(now - hoursBack * 3600));
  url.searchParams.set("period", String(hoursBack * 3600));
  type R = { series?: Array<{ points?: Array<{ Point?: { open?: number; high?: number; low?: number; close?: number; volume?: number; timestamp?: { s?: number } } }> }> };
  const data = await kiyotaka<R>(url);
  const pts = data.series?.[0]?.points ?? [];
  const out: CandleHr[] = [];
  for (const p of pts) {
    const P = p.Point;
    if (!P || P.close == null || P.timestamp?.s == null) continue;
    out.push({
      ts: P.timestamp.s,
      open: P.open ?? P.close,
      high: P.high ?? P.close,
      low: P.low ?? P.close,
      close: P.close,
      volume: P.volume ?? 0,
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

async function fetchFunding(symbol: string, hoursBack: number): Promise<FundingHr[]> {
  const now = Math.floor(Date.now() / 1000);
  const url = new URL("https://api.kiyotaka.ai/v1/points");
  url.searchParams.set("type", "FUNDING_RATE_AGG");
  url.searchParams.set("exchange", "BINANCE_FUTURES");
  url.searchParams.set("rawSymbol", symbol);
  url.searchParams.set("interval", "HOUR");
  url.searchParams.set("from", String(now - hoursBack * 3600));
  url.searchParams.set("period", String(hoursBack * 3600));
  type R = { series?: Array<{ points?: Array<{ Point?: { rate?: number; rateClose?: number; timestamp?: { s?: number } } }> }> };
  const data = await kiyotaka<R>(url);
  const pts = data.series?.[0]?.points ?? [];
  const out: FundingHr[] = [];
  for (const p of pts) {
    const P = p.Point;
    if (!P || P.timestamp?.s == null) continue;
    const rate = P.rateClose ?? P.rate;
    if (rate == null) continue;
    out.push({ ts: P.timestamp.s, rate });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// Mirror of /api/signals event detection — same z-score thresholds, so
// the events we feed the swarm match what production autopilot would.
function zscore(x: number, arr: number[]): number {
  if (arr.length < 4) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (arr.length - 1);
  const sd = Math.sqrt(Math.max(v, 1e-12));
  return (x - mean) / sd;
}

function detectAtHour(
  asset: SimAsset,
  candles: CandleHr[],
  rates: FundingHr[],
  hourEnd: number,
): SimEvent[] {
  const cWindow = candles.filter((c) => c.ts <= hourEnd).slice(-48);
  if (cWindow.length < 6) return [];
  const last = cWindow[cWindow.length - 1];
  const prev = cWindow[cWindow.length - 2];
  const rest = cWindow.slice(0, -1);

  const returns: number[] = [];
  for (let i = 1; i < rest.length; i++) {
    returns.push(Math.log(rest[i].close / rest[i - 1].close));
  }
  const latestRet = Math.log(last.close / prev.close);
  const rz = zscore(latestRet, returns);
  const vols = rest.map((c) => c.volume);
  const vz = zscore(last.volume, vols);

  const out: SimEvent[] = [];
  if (Math.abs(rz) >= 2.0 && vz >= 1.5) {
    out.push({
      id: `bt-liq-${asset}-${last.ts}`,
      ts: last.ts,
      asset,
      kind: "liq-spike",
      magnitude_z: Math.min(Math.abs(rz), 6),
      direction: rz >= 0 ? "long" : "short",
    });
  }

  const recent = cWindow.slice(-24);
  const refHi = Math.max(...recent.slice(0, -1).map((c) => c.close));
  const refLo = Math.min(...recent.slice(0, -1).map((c) => c.close));
  if (last.close > refHi && Math.abs(rz) >= 1.0) {
    out.push({ id: `bt-vbo-${asset}-${last.ts}`, ts: last.ts, asset, kind: "vol-breakout", magnitude_z: Math.min(Math.max(Math.abs(rz), 2.0), 6), direction: "long" });
  } else if (last.close < refLo && Math.abs(rz) >= 1.0) {
    out.push({ id: `bt-vbo-${asset}-${last.ts}`, ts: last.ts, asset, kind: "vol-breakout", magnitude_z: Math.min(Math.max(Math.abs(rz), 2.0), 6), direction: "short" });
  }

  const rWindow = rates.filter((r) => r.ts <= hourEnd).slice(-96);
  if (rWindow.length >= 12) {
    const lastR = rWindow[rWindow.length - 1];
    const restR = rWindow.slice(0, -1).map((r) => r.rate);
    const z = zscore(lastR.rate, restR);
    if (Math.abs(z) >= 2.0) {
      out.push({ id: `bt-fund-${asset}-${lastR.ts}`, ts: lastR.ts, asset, kind: "funding-spike", magnitude_z: Math.min(Math.abs(z), 6), direction: lastR.rate >= 0 ? "long" : "short" });
    }
  }

  if (rWindow.length >= 24 && cWindow.length >= 24) {
    const recent = rWindow.slice(-8).map((r) => r.rate);
    const baseline = rWindow.slice(-24, -8).map((r) => r.rate);
    if (recent.length >= 4 && baseline.length >= 8) {
      const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;
      const z = zscore(recentMean, baseline);
      if (Math.abs(z) >= 2.5) {
        out.push({ id: `bt-pm-${asset}-${last.ts}`, ts: last.ts, asset, kind: "polymarket-lead", magnitude_z: Math.min(Math.abs(z), 5), direction: recentMean >= 0 ? "long" : "short" });
      }
    }
  }

  // Fusion event when ≥2 signals align on this asset.
  if (out.length >= 2) {
    const longs = out.filter((e) => e.direction === "long").length;
    const dir: SimDirection = longs > out.length / 2 ? "long" : "short";
    const z = Math.max(...out.map((e) => e.magnitude_z));
    out.push({ id: `bt-fusion-${asset}-${last.ts}`, ts: last.ts, asset, kind: "fusion", magnitude_z: Math.min(z + 0.5, 6), direction: dir });
  }
  return out;
}

// ---------------------------------------------------------------------------

type Trial = { name: string; cfg: PortfolioConfig };

const TRIALS: Trial[] = [
  { name: "default", cfg: DEFAULT_PORTFOLIO_CONFIG },
  { name: "tight (cap 4 / conv 0.5)", cfg: { ...DEFAULT_PORTFOLIO_CONFIG, max_open_positions: 4, min_conviction: 0.50 } },
  { name: "no-trail",                  cfg: { ...DEFAULT_PORTFOLIO_CONFIG, trail_after_r: 0 } },
  { name: "no-time-stop",              cfg: { ...DEFAULT_PORTFOLIO_CONFIG, time_stop_hours: 0 } },
  { name: "no-swarm-flip",             cfg: { ...DEFAULT_PORTFOLIO_CONFIG, swarm_flip_conviction: 1.01 } },
  { name: "no-meta (open every event)",cfg: { ...DEFAULT_PORTFOLIO_CONFIG, max_open_positions: 99, min_conviction: 0, time_stop_hours: 0, trail_after_r: 0, swarm_flip_conviction: 1.01 } },
];

type SessionResult = {
  cfg_name: string;
  events: number;
  decisions: number;
  trades: number;
  closes_by_reason: Record<string, number>;
  wins: number;
  losses: number;
  total_r: number;
  total_pnl_usd: number;
  best_r: number;
  worst_r: number;
  max_drawdown_pct: number;
  final_equity: number;
  avg_hold_hours: number;
  end_open_count: number;
  end_open_unrealized: number;
};

async function runOneSession(
  name: string,
  cfg: PortfolioConfig,
  snap: SwarmSnapshot,
  btcCandles: CandleHr[],
  ethCandles: CandleHr[],
  btcFunding: FundingHr[],
  ethFunding: FundingHr[],
): Promise<SessionResult> {
  let open: PaperPosition[] = [];
  const closed: PaperPosition[] = [];
  let nextId = 0;

  // Build aligned hour-by-hour timeline using BTC's candle ts as the
  // master clock. ETH gets its closest-mark snapped per hour.
  const hourEnds = btcCandles.map((c) => c.ts);
  let totalEvents = 0;
  let routedDecisions = 0;
  let opens = 0;
  let equity = EQUITY_START;
  let peakEquity = EQUITY_START;
  let maxDDPct = 0;
  let bestR = 0;
  let worstR = 0;

  const ethByTs = new Map(ethCandles.map((c) => [c.ts, c]));

  for (const hourTs of hourEnds) {
    const btcMark = btcCandles.find((c) => c.ts === hourTs)?.close ?? null;
    const ethMark = (() => {
      // Snap to nearest ETH hour (Kiyotaka usually has them aligned).
      const exact = ethByTs.get(hourTs);
      if (exact) return exact.close;
      // Find latest ETH candle ≤ hourTs.
      let last: number | null = null;
      for (const c of ethCandles) {
        if (c.ts > hourTs) break;
        last = c.close;
      }
      return last;
    })();

    // 1) Mark-tick management (trail + time stop) BEFORE handling events.
    {
      const marks = { BTC: btcMark, ETH: ethMark };
      const { updated, closes } = manageOnMark(open, marks, cfg, hourTs);
      const closeIds = new Set(closes.map((c) => c.id));
      const remain: PaperPosition[] = [];
      for (const p of updated) {
        if (closeIds.has(p.id)) {
          const c = closes.find((cc) => cc.id === p.id)!;
          const diff = p.side === "long" ? c.mark - p.entry : p.entry - c.mark;
          const pnl = diff * p.size_contracts;
          equity += pnl;
          closed.push({ ...p, closed_at: hourTs, close_px: c.mark, close_reason: c.reason, pnl_usd: pnl });
          continue;
        }
        const m = p.asset === "BTC" ? btcMark : ethMark;
        if (m == null) {
          remain.push(p);
          continue;
        }
        // Stop / TP check (mirrors paper.checkTriggers + the trail-derived
        // `trail` reason logic in TournamentClient's mark sweep).
        let trig: CloseReason | null = null;
        if (p.side === "long") {
          if (m <= p.stop) trig = "stop";
          else if (m >= p.take_profit) trig = "tp";
        } else {
          if (m >= p.stop) trig = "stop";
          else if (m <= p.take_profit) trig = "tp";
        }
        if (trig === "stop") {
          const init = p.initial_stop ?? p.stop;
          const trailed = p.side === "long" ? p.stop > init : p.stop < init;
          if (trailed) trig = "trail";
        }
        if (trig) {
          const diff = p.side === "long" ? m - p.entry : p.entry - m;
          const pnl = diff * p.size_contracts;
          equity += pnl;
          closed.push({ ...p, closed_at: hourTs, close_px: m, close_reason: trig, pnl_usd: pnl });
        } else {
          remain.push(p);
        }
      }
      open = remain;
    }

    // 2) Detect events at this hour, then run the entry pipeline.
    const events: SimEvent[] = [
      ...detectAtHour("BTC", btcCandles, btcFunding, hourTs),
      ...detectAtHour("ETH", ethCandles, ethFunding, hourTs),
    ];
    totalEvents += events.length;

    for (const ev of events) {
      const route = routeTrade(ev, simulateReactions(ev, snap.agents, snap.regime), snap.agents);
      routedDecisions++;
      if (VERBOSE) {
        console.log(
          `${new Date(ev.ts * 1000).toISOString()} [${name}] ${ev.asset} ${ev.kind} → ${route.decision.direction ?? "FLAT"} (conv=${route.vote.conviction.toFixed(2)})`,
        );
      }

      // Swarm-flip exit on existing positions for this asset.
      const flipIds = manageOnEvent({
        asset: ev.asset,
        vote_direction: route.vote.direction,
        conviction: route.vote.conviction,
        positions: open,
        config: cfg,
      });
      if (flipIds.length > 0) {
        const px = ev.asset === "BTC" ? btcMark : ethMark;
        if (px != null) {
          open = open.filter((p) => {
            if (!flipIds.includes(p.id)) return true;
            const diff = p.side === "long" ? px - p.entry : p.entry - px;
            const pnl = diff * p.size_contracts;
            equity += pnl;
            closed.push({ ...p, closed_at: ev.ts, close_px: px, close_reason: "swarm-flip", pnl_usd: pnl });
            return false;
          });
        }
      }

      // Compute the prospective entry the same way TournamentClient does.
      if (!route.decision.direction || !route.specialist) continue;
      const price = ev.asset === "BTC" ? btcMark : ethMark;
      if (price == null || price <= 0) continue;
      const atr = price * 0.005;
      const stopDist = 1.5 * atr;
      const riskUsd = equity * RISK_FRACTION * route.decision.size_factor;
      const notional = Math.min((riskUsd * price) / stopDist, equity * 3);
      if (notional <= 0) continue;
      const dir = route.decision.direction;
      const stopPx = dir === "long" ? price - stopDist : price + stopDist;
      const tp = dir === "long" ? price + 3 * atr : price - 3 * atr;

      const action = decideEntry({
        asset: ev.asset,
        direction: dir,
        conviction: route.vote.conviction,
        open,
        config: cfg,
      });
      if (action.kind === "skip") continue;

      if (action.kind === "reverse") {
        const opp = open.find((p) => p.id === action.close_id);
        if (opp && price != null) {
          const diff = opp.side === "long" ? price - opp.entry : opp.entry - price;
          const pnl = diff * opp.size_contracts;
          equity += pnl;
          closed.push({ ...opp, closed_at: ev.ts, close_px: price, close_reason: "reverse", pnl_usd: pnl });
          open = open.filter((p) => p.id !== opp.id);
        }
      }
      if (open.length >= cfg.max_open_positions) continue;

      const id = `bt-${++nextId}`;
      open.push({
        id,
        agent_id: route.specialist.agent_id,
        asset: ev.asset,
        side: dir,
        size_contracts: notional / price,
        notional_usd: notional,
        entry: price,
        initial_stop: stopPx,
        stop: stopPx,
        take_profit: tp,
        opened_at: ev.ts,
      });
      opens++;
    }

    // 3) Track equity peak / drawdown including unrealized.
    const unreal = open.reduce((acc, p) => {
      const m = p.asset === "BTC" ? btcMark : ethMark;
      if (m == null) return acc;
      return acc + unrealizedPnl(p, m);
    }, 0);
    const equityNow = equity + unreal;
    if (equityNow > peakEquity) peakEquity = equityNow;
    const dd = (peakEquity - equityNow) / peakEquity;
    if (dd > maxDDPct) maxDDPct = dd;
  }

  // Force-close anything still open at the last mark — would otherwise
  // distort the final equity number.
  const finalBtc = btcCandles[btcCandles.length - 1].close;
  const finalEth = ethCandles[ethCandles.length - 1]?.close ?? null;
  let endOpenUnrealized = 0;
  for (const p of open) {
    const m = p.asset === "BTC" ? finalBtc : finalEth;
    if (m == null) continue;
    endOpenUnrealized += unrealizedPnl(p, m);
  }

  // Stats.
  const closesByReason: Record<string, number> = {};
  let wins = 0, losses = 0, totalR = 0, totalPnl = 0, holdSum = 0;
  for (const p of closed) {
    const reason = p.close_reason ?? "manual";
    closesByReason[reason] = (closesByReason[reason] ?? 0) + 1;
    const pnl = p.pnl_usd ?? 0;
    totalPnl += pnl;
    if (pnl > 0) wins++; else if (pnl < 0) losses++;
    const init = p.initial_stop ?? p.stop;
    const r = Math.abs(p.entry - init) * p.size_contracts;
    if (r > 0) {
      const rMult = pnl / r;
      totalR += rMult;
      if (rMult > bestR) bestR = rMult;
      if (rMult < worstR) worstR = rMult;
    }
    holdSum += ((p.closed_at ?? p.opened_at) - p.opened_at) / 3600;
  }

  return {
    cfg_name: name,
    events: totalEvents,
    decisions: routedDecisions,
    trades: opens,
    closes_by_reason: closesByReason,
    wins,
    losses,
    total_r: totalR,
    total_pnl_usd: totalPnl,
    best_r: bestR,
    worst_r: worstR,
    max_drawdown_pct: maxDDPct,
    final_equity: equity + endOpenUnrealized,
    avg_hold_hours: closed.length > 0 ? holdSum / closed.length : 0,
    end_open_count: open.length,
    end_open_unrealized: endOpenUnrealized,
  };
}

async function main() {
  const snapshotPath = resolve(__dirname, "../../lib/bundled/swarm-snapshot.json");
  const rawSnap = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const snap: SwarmSnapshot = {
    generated_at: rawSnap.generated_at,
    generation: rawSnap.generation,
    n_agents: rawSnap.n_agents ?? rawSnap.agents.length,
    champion: rawSnap.champion,
    agents: rawSnap.agents as AgentStats[],
    recent_decisions: rawSnap.recent_decisions ?? [],
    consensus: rawSnap.consensus ?? { fires: 0 },
    regime: rawSnap.regime as RegimeInfo | null | undefined,
    source: rawSnap.source ?? "backtest",
    champion_certification: rawSnap.champion_certification,
  };

  const hours = DAYS * 24;
  console.log(`# Pythia portfolio backtest`);
  console.log(`# window: ${DAYS} days (${hours} hours), starting equity $${EQUITY_START}`);
  console.log(`# pulling Kiyotaka history…`);

  const t0 = Date.now();
  const [btcCandles, ethCandles, btcFunding, ethFunding] = await Promise.all([
    fetchCandles("BTCUSDT", hours),
    fetchCandles("ETHUSDT", hours),
    fetchFunding("BTCUSDT", hours),
    fetchFunding("ETHUSDT", hours),
  ]);
  console.log(
    `# fetched btc=${btcCandles.length} eth=${ethCandles.length} btcF=${btcFunding.length} ethF=${ethFunding.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );
  if (btcCandles.length < 48) {
    console.error("Not enough BTC candles to backtest");
    process.exit(1);
  }
  console.log(
    `# BTC range: $${Math.min(...btcCandles.map((c) => c.close)).toFixed(0)}–$${Math.max(...btcCandles.map((c) => c.close)).toFixed(0)} · drift ${(((btcCandles[btcCandles.length - 1].close / btcCandles[0].close) - 1) * 100).toFixed(2)}%`,
  );
  console.log(
    `# ETH range: $${Math.min(...ethCandles.map((c) => c.close)).toFixed(0)}–$${Math.max(...ethCandles.map((c) => c.close)).toFixed(0)} · drift ${(((ethCandles[ethCandles.length - 1].close / ethCandles[0].close) - 1) * 100).toFixed(2)}%`,
  );
  console.log(`# population: ${snap.agents.length} agents, champion ${snap.champion?.agent_id}\n`);

  const results: SessionResult[] = [];
  for (const trial of TRIALS) {
    const r = await runOneSession(trial.name, trial.cfg, snap, btcCandles, ethCandles, btcFunding, ethFunding);
    results.push(r);
  }

  // Render the comparison.
  console.log(`config                                    | trades | win% | Σ R   | $PnL  | maxDD% | endEq | reasons`);
  console.log(`------------------------------------------|--------|------|-------|-------|--------|-------|---------`);
  for (const r of results) {
    const reasons = Object.entries(r.closes_by_reason).map(([k, v]) => `${k}:${v}`).join(" ");
    const wrate = r.wins + r.losses > 0 ? (r.wins / (r.wins + r.losses)) * 100 : 0;
    console.log(
      `${r.cfg_name.padEnd(41).slice(0, 41)} | ${String(r.trades).padStart(6)} | ${wrate.toFixed(0).padStart(3)}% | ${r.total_r.toFixed(2).padStart(5)} | ${r.total_pnl_usd >= 0 ? "+" : ""}${r.total_pnl_usd.toFixed(0).padStart(5)} | ${(r.max_drawdown_pct * 100).toFixed(1).padStart(5)}% | $${r.final_equity.toFixed(0).padStart(4)} | ${reasons}`,
    );
  }
  console.log("");

  // Best and detail lines.
  const best = results.slice().sort((a, b) => b.final_equity - a.final_equity)[0];
  console.log(`# best by final equity: "${best.cfg_name}" ending at $${best.final_equity.toFixed(2)} (${(((best.final_equity / EQUITY_START) - 1) * 100).toFixed(2)}% over ${DAYS}d, ${best.trades} trades, ${best.wins}W/${best.losses}L, max DD ${(best.max_drawdown_pct * 100).toFixed(1)}%)`);
  for (const r of results) {
    const annualisedPct = (((r.final_equity / EQUITY_START) ** (365 / DAYS)) - 1) * 100;
    const reasons = Object.entries(r.closes_by_reason).map(([k, v]) => `${k}=${v}`).join(", ");
    const expectancyR = r.wins + r.losses > 0 ? r.total_r / (r.wins + r.losses) : 0;
    console.log(
      `# ${r.cfg_name}: events=${r.events} routed=${r.decisions} opened=${r.trades} closes={${reasons}} avg_hold=${r.avg_hold_hours.toFixed(1)}h expectancy=${expectancyR.toFixed(3)}R/trade end_open=${r.end_open_count} (${r.end_open_unrealized >= 0 ? "+" : ""}$${r.end_open_unrealized.toFixed(2)} unrealized) annualised≈${annualisedPct.toFixed(0)}%`,
    );
  }
}

main().catch((e) => {
  console.error("backtest failed:", e);
  process.exit(1);
});
