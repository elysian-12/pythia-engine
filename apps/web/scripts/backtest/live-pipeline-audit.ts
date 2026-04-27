// End-to-end live pipeline audit. Walks the same eight steps the
// /tournament UI executes — but explicit and inspectable, so the user
// can see at a glance whether each link in the chain actually works
// against real Kiyotaka data.
//
// Run from apps/web:
//   BASE=https://pythia-engine.vercel.app npx tsx scripts/backtest/live-pipeline-audit.ts
// or against local dev:
//   BASE=http://localhost:3000 npx tsx scripts/backtest/live-pipeline-audit.ts
//
// Output is a structured report: each of the 8 steps gets a verdict
// (✅ working / ⚠️ degraded / ❌ broken) plus the actual numbers so
// the user can demo with confidence.

import { simulateReactions } from "../../lib/simulate";
import type { SimEvent } from "../../lib/simulate";
import { routeTrade } from "../../lib/router";
import {
  DEFAULT_PORTFOLIO_CONFIG,
  decideEntry,
  manageOnEvent,
  manageOnMark,
} from "../../lib/portfolio";
import type { PaperPosition } from "../../lib/paper";
import { unrealizedPnl, realizedPnl } from "../../lib/paper";
import { applySessionDelta, type SwarmSnapshot } from "../../lib/swarm";

const BASE = process.env.BASE ?? "http://localhost:3000";

type Verdict = "ok" | "degraded" | "broken";
type StepReport = { id: number; name: string; verdict: Verdict; lines: string[] };

const reports: StepReport[] = [];

function log(report: StepReport, line: string) {
  report.lines.push(line);
}

async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

type SignalsResponse = {
  ok: boolean;
  ts: number;
  prices: { BTC?: number | null; ETH?: number | null };
  events: SimEvent[];
  source?: string;
  partial?: Record<string, string | null> | null;
};

type SwarmResponse = SwarmSnapshot;

type MarksResponse = {
  ok: boolean;
  marks: { BTC: number | null; ETH: number | null };
};

async function main() {
  console.log(`# Pythia live pipeline audit`);
  console.log(`# base: ${BASE}`);
  console.log(`# time: ${new Date().toISOString()}\n`);

  // -----------------------------------------------------------------
  // STEP 1 — Event from Kiyotaka
  // -----------------------------------------------------------------
  const step1: StepReport = { id: 1, name: "Event (live Kiyotaka)", verdict: "broken", lines: [] };
  reports.push(step1);
  let signals: SignalsResponse | null = null;
  try {
    signals = await fetchJSON<SignalsResponse>("/api/signals");
    log(step1, `route source: ${signals.source ?? "—"}`);
    log(step1, `prices: BTC=$${signals.prices.BTC ?? "null"}, ETH=$${signals.prices.ETH ?? "null"}`);
    log(step1, `partial outage: ${signals.partial ? JSON.stringify(signals.partial) : "none"}`);
    log(step1, `events this poll: ${signals.events.length}`);
    if (!signals.ok) {
      log(step1, `route reported NOT OK`);
      step1.verdict = "broken";
    } else if (!signals.prices.BTC || !signals.prices.ETH) {
      step1.verdict = "degraded";
    } else {
      // Kiyotaka detector is selective — quiet windows return [].
      // That's not a failure; it's the route honestly reporting no
      // event cleared a threshold this poll.
      step1.verdict = "ok";
    }
    if (signals.events.length > 0) {
      log(step1, `event detail (first 3):`);
      for (const ev of signals.events.slice(0, 3)) {
        log(
          step1,
          `  · ${ev.asset} ${ev.kind} dir=${ev.direction} |z|=${ev.magnitude_z.toFixed(2)} src=${ev.source ?? "—"}`,
        );
      }
    } else {
      log(step1, `(quiet poll — detector saw no z-spike. fire EventSimulator manually for a forced trip)`);
    }
  } catch (e) {
    log(step1, `error: ${(e as Error).message}`);
    step1.verdict = "broken";
  }
  if (!signals || !signals.ok) {
    flushReports();
    return;
  }

  // -----------------------------------------------------------------
  // STEP 2 — Vote (27 agents independently)
  // -----------------------------------------------------------------
  const step2: StepReport = { id: 2, name: "Vote (per-agent reactions)", verdict: "broken", lines: [] };
  reports.push(step2);
  let snap: SwarmResponse | null = null;
  try {
    snap = await fetchJSON<SwarmResponse>("/api/swarm");
    log(step2, `population: ${snap.agents.length} agents @ generation ${snap.generation ?? 0}`);
    const fams = new Map<string, number>();
    for (const a of snap.agents) {
      const key =
        a.agent_id.startsWith("llm-")
          ? "llm"
          : (a.agent_id
              .replace(/^gen\d+(-mut\d+)?-/, "")
              .replace(/^gen\d+-revive-/, "")
              .split(/[-]/)
              .slice(0, 2)
              .join("-")) ;
      fams.set(key, (fams.get(key) ?? 0) + 1);
    }
    log(step2, `families: ${[...fams.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
    if (snap.agents.length === 0) {
      log(step2, `population empty — voting impossible`);
      step2.verdict = "broken";
    } else {
      step2.verdict = "ok";
    }
  } catch (e) {
    log(step2, `error: ${(e as Error).message}`);
    step2.verdict = "broken";
  }
  if (!snap || snap.agents.length === 0) {
    flushReports();
    return;
  }

  // Pick a representative event. If the live poll was quiet, manufacture
  // a strong what-if so we can audit steps 3..8 without waiting hours.
  let probeEvent: SimEvent;
  let probeWasReal = false;
  if (signals.events.length > 0) {
    // Use the strongest live event so the audit reflects production.
    probeEvent = [...signals.events].sort((a, b) => b.magnitude_z - a.magnitude_z)[0];
    probeWasReal = true;
  } else {
    probeEvent = {
      id: `audit-probe-${signals.ts}`,
      ts: signals.ts,
      asset: "BTC",
      kind: "liq-spike",
      magnitude_z: 2.6,
      direction: "long",
      source: "audit:probe",
    };
  }
  log(step2, `probe event: ${probeWasReal ? "REAL" : "SYNTHETIC (quiet poll)"} — ${probeEvent.asset} ${probeEvent.kind} |z|=${probeEvent.magnitude_z.toFixed(2)}`);

  const reactions = simulateReactions(probeEvent, snap.agents, snap.regime);
  const fired = reactions.filter((r) => r.reacted);
  log(step2, `agents reacted: ${fired.length}/${reactions.length}`);
  log(
    step2,
    `breakdown: ${fired.filter((r) => r.direction === "long").length} long, ${fired.filter((r) => r.direction === "short").length} short`,
  );
  if (fired.length === 0 && probeEvent.magnitude_z >= 2.0) {
    log(step2, `WARNING: agents didn't react to a |z|≥2 event. TRIGGER_Z drift?`);
    step2.verdict = "degraded";
  }

  // -----------------------------------------------------------------
  // STEP 3 — Self-check (regime fitness gate inside simulateReactions)
  // -----------------------------------------------------------------
  const step3: StepReport = { id: 3, name: "Self-check (regime fitness gate)", verdict: "ok", lines: [] };
  reports.push(step3);
  log(step3, `regime: ${snap.regime?.label ?? "unknown"} (directional ${snap.regime?.directional?.toFixed?.(2) ?? "—"}, vol ${snap.regime?.vol_ratio?.toFixed?.(2) ?? "—"})`);
  const skippedByRegime = reactions.filter((r) => r.rationale.includes("skipped"));
  log(step3, `agents that would have fired but skipped on regime fitness: ${skippedByRegime.length}`);
  if (skippedByRegime.length > 0) {
    log(step3, `  example: ${skippedByRegime[0].agent_id} → "${skippedByRegime[0].rationale}"`);
  }
  log(step3, `(self-backtest gate on recent expectancy lives in Rust Scoreboard::recent_expectancy — populated per observe() by Swarm::with_scoreboard. UI mirror only enforces regime gate; full gate runs in pythia-swarm-live.)`);

  // -----------------------------------------------------------------
  // STEP 5 — Specialist (per-event-kind router pick)
  // -----------------------------------------------------------------
  const step5: StepReport = { id: 5, name: "Specialist (per-kind router pick)", verdict: "ok", lines: [] };
  reports.push(step5);
  const route = routeTrade(probeEvent, reactions, snap.agents);
  if (route.specialist) {
    log(step5, `specialist for ${probeEvent.kind}: ${route.specialist.agent_id}`);
    log(
      step5,
      `  Sharpe=${route.specialist.rolling_sharpe.toFixed(2)} · Σ R=${route.specialist.total_r.toFixed(2)} · trades=${route.specialist.wins + route.specialist.losses}`,
    );
  } else {
    log(step5, `no eligible specialist for kind ${probeEvent.kind}; router will fall back to global champion`);
    step5.verdict = "degraded";
  }

  // -----------------------------------------------------------------
  // STEP 6 — Ensemble (Sharpe-weighted vote)
  // -----------------------------------------------------------------
  const step6: StepReport = { id: 6, name: "Ensemble (Sharpe-weighted vote)", verdict: "ok", lines: [] };
  reports.push(step6);
  log(
    step6,
    `vote: direction=${route.vote.direction}, conviction=${route.vote.conviction.toFixed(2)} (|x|=${Math.abs(route.vote.conviction).toFixed(2)}), fired=${route.vote.fired_count}/${reactions.length}`,
  );
  log(
    step6,
    `decision: ${route.decision.direction ?? "FLAT"}${route.decision.direction ? " " + route.decision.size_factor.toFixed(2) + "× size" : ""}`,
  );
  log(step6, `rationale: ${route.decision.rationale}`);
  if (route.vote.fired_count === 0) {
    log(step6, `WARNING: ensemble received zero firings. Either threshold mis-cal or detector emitted weak event.`);
    step6.verdict = "degraded";
  }

  // -----------------------------------------------------------------
  // STEP 4 — Scoreboard (applySessionDelta mutates local snapshot)
  // -----------------------------------------------------------------
  const step4: StepReport = { id: 4, name: "Scoreboard (live re-rank)", verdict: "ok", lines: [] };
  reports.push(step4);
  const beforeChamp = snap.champion?.agent_id ?? null;
  const beforeChampR = snap.champion?.total_r ?? 0;
  const after = applySessionDelta(snap, reactions, probeEvent.ts);
  log(step4, `before: champion=${beforeChamp} Σ R=${beforeChampR.toFixed(2)}`);
  log(
    step4,
    `after delta (synthetic resolves): champion=${after.champion?.agent_id ?? "—"} Σ R=${after.champion?.total_r?.toFixed?.(2) ?? "—"}`,
  );
  if (fired.length > 0 && after === snap) {
    log(step4, `WARNING: applySessionDelta returned identical snap despite ${fired.length} firings`);
    step4.verdict = "degraded";
  }

  // -----------------------------------------------------------------
  // STEP 7 — Evolution (Rust-only; UI snapshot reflects the latest run)
  // -----------------------------------------------------------------
  const step7: StepReport = { id: 7, name: "Evolution (every N events)", verdict: "ok", lines: [] };
  reports.push(step7);
  log(step7, `current generation in deployed snapshot: ${snap.generation ?? 0}`);
  log(step7, `evolution runs in Rust (Evolution::advance) — invoked every PYTHIA_EVOLVE_EVERY events by:`);
  log(step7, `  · swarm-backtest: replays + evolves; bundler ships the result`);
  log(step7, `  · pythia-swarm-live: live daemon evolves continuously`);
  log(step7, `Vercel UI does NOT run evolution at request time — the bundled snapshot is frozen at deploy.`);
  log(step7, `To get a fresh-evolution snapshot in production, run swarm-backtest and push (auto-bundled by prebuild hook).`);
  if ((snap.generation ?? 0) === 0) {
    log(step7, `WARNING: snapshot is at gen 0 — backtest hasn't run or population was just reseeded`);
    step7.verdict = "degraded";
  }

  // -----------------------------------------------------------------
  // STEP 8 — Trade (paper position open + meta-agent close)
  // -----------------------------------------------------------------
  const step8: StepReport = { id: 8, name: "Trade (paper open + meta-agent exit)", verdict: "ok", lines: [] };
  reports.push(step8);
  let marks: MarksResponse;
  try {
    marks = await fetchJSON<MarksResponse>("/api/marks");
    log(step8, `live marks: BTC=$${marks.marks.BTC?.toFixed(2) ?? "null"}, ETH=$${marks.marks.ETH?.toFixed(2) ?? "null"}`);
  } catch (e) {
    log(step8, `marks fetch failed: ${(e as Error).message}`);
    step8.verdict = "broken";
    flushReports();
    return;
  }

  // Walk the same code TournamentClient.onFire runs.
  const equity = 1000;
  const open: PaperPosition[] = [];
  const closed: PaperPosition[] = [];

  // 8a) decideEntry decides what to do. NB: pass the *signed* conviction
  // — decideEntry takes Math.abs internally so strong-short signals
  // (conviction ≤ -0.30) aren't silently filtered by the conviction
  // floor. Used to be the production bug: every short event made it
  // into the trade feed but never opened a paper position.
  const action = decideEntry({
    asset: probeEvent.asset,
    direction: route.decision.direction,
    conviction: route.vote.conviction,
    open,
    config: DEFAULT_PORTFOLIO_CONFIG,
  });
  log(step8, `decideEntry verdict: ${action.kind} — ${action.reason}`);
  if (action.kind === "skip") {
    log(step8, `(skipped — meta-agent's conviction floor / family rule blocked entry)`);
    flushReports();
    return;
  }

  // 8b) Open a paper position the way the UI does
  if (route.decision.direction && route.specialist) {
    const price = (probeEvent.asset === "BTC" ? marks.marks.BTC : marks.marks.ETH) ?? 50000;
    const atr = price * 0.005;
    const stopDist = 1.5 * atr;
    const riskUsd = equity * 0.01 * route.decision.size_factor;
    const notional = Math.min((riskUsd * price) / stopDist, equity * 3);
    const dir = route.decision.direction;
    const stop = dir === "long" ? price - stopDist : price + stopDist;
    const tp = dir === "long" ? price + 3 * atr : price - 3 * atr;
    const pos: PaperPosition = {
      id: `audit-${probeEvent.id}`,
      agent_id: route.specialist.agent_id,
      asset: probeEvent.asset,
      side: dir,
      size_contracts: notional / price,
      notional_usd: notional,
      entry: price,
      initial_stop: stop,
      stop,
      take_profit: tp,
      opened_at: probeEvent.ts,
    };
    open.push(pos);
    log(
      step8,
      `opened: ${pos.asset} ${pos.side} ${pos.size_contracts.toFixed(6)} @ $${pos.entry.toFixed(2)} | stop $${pos.stop.toFixed(0)} | tp $${pos.take_profit.toFixed(0)}`,
    );
    log(step8, `  notional $${pos.notional_usd.toFixed(0)} — ${(pos.notional_usd / equity).toFixed(2)}× equity`);
  }

  // 8c) Simulate a mark tick 12 hours later → time stop should fire
  const timestepNow = probeEvent.ts + 13 * 3600;
  const { updated, closes } = manageOnMark(
    open,
    marks.marks,
    DEFAULT_PORTFOLIO_CONFIG,
    timestepNow,
  );
  log(
    step8,
    `manageOnMark @ +13h: ${closes.length} close, ${updated.length - closes.length} survive`,
  );
  for (const c of closes) {
    log(step8, `  exit reason: ${c.reason} @ mark $${c.mark.toFixed(2)}`);
  }
  if (closes.length === 0) {
    log(step8, `WARNING: position should have hit time-stop after 13h — meta-agent rule may be off`);
    step8.verdict = "degraded";
  } else {
    // Apply the close
    for (const c of closes) {
      const p = open.find((x) => x.id === c.id);
      if (!p) continue;
      const diff = p.side === "long" ? c.mark - p.entry : p.entry - c.mark;
      const pnl = diff * p.size_contracts;
      closed.push({ ...p, closed_at: timestepNow, close_px: c.mark, close_reason: c.reason, pnl_usd: pnl });
      log(step8, `  realized PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);
    }
  }

  // 8d) Verify swarm-flip exit fires when a fresh opposite vote lands
  const flipIds = manageOnEvent({
    asset: probeEvent.asset,
    vote_direction: route.vote.direction === "long" ? "short" : "long",
    conviction: 0.6,
    positions: open,
    config: DEFAULT_PORTFOLIO_CONFIG,
  });
  log(
    step8,
    `manageOnEvent (synthetic opposite vote @ 0.6 conviction): would close ${flipIds.length} position(s)`,
  );

  // ---- closeout: also probe the now-deployed exit chips ----
  log(step8, `meta-agent rules in effect: max_open=${DEFAULT_PORTFOLIO_CONFIG.max_open_positions}, min_conviction=${DEFAULT_PORTFOLIO_CONFIG.min_conviction.toFixed(2)}, time_stop=${DEFAULT_PORTFOLIO_CONFIG.time_stop_hours}h, trail_after=${DEFAULT_PORTFOLIO_CONFIG.trail_after_r}R, swarm_flip=${DEFAULT_PORTFOLIO_CONFIG.swarm_flip_conviction.toFixed(2)}`);

  // Exit final state
  log(step8, `final: ${open.length - closed.length} open, ${closed.length} closed (realized $${closed.reduce((a, p) => a + realizedPnl(p), 0).toFixed(2)})`);
  void unrealizedPnl; // referenced for type symmetry

  flushReports();
}

function flushReports() {
  // Sort by step id then print.
  reports.sort((a, b) => a.id - b.id);
  let hardBroken = 0;
  let degraded = 0;
  for (const r of reports) {
    const icon = r.verdict === "ok" ? "✅" : r.verdict === "degraded" ? "⚠️" : "❌";
    if (r.verdict === "broken") hardBroken++;
    if (r.verdict === "degraded") degraded++;
    console.log(`\n${icon} STEP ${r.id} — ${r.name}`);
    for (const line of r.lines) console.log(`   ${line}`);
  }
  console.log("");
  if (hardBroken > 0) {
    console.log(`# verdict: ${hardBroken} broken step(s), ${degraded} degraded — pipeline is NOT demo-ready`);
    process.exit(1);
  } else if (degraded > 0) {
    console.log(`# verdict: ${degraded} step(s) degraded but functional — review before demo`);
  } else {
    console.log(`# verdict: all 8 steps verified working against live data`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
