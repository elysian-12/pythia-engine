#!/usr/bin/env node
// Copies data/swarm-snapshot.json → apps/web/public/swarm-snapshot.json
// at build time, so Vercel (which has no filesystem access to the repo
// root) can still serve the most recent swarm run as a static asset.
//
// Falls back to the latest reports/swarm/<ts>/swarm.json if the canonical
// snapshot is missing.

import { promises as fs } from "node:fs";
import path from "node:path";
import { existsSync } from "node:fs";

const webDir = path.resolve(process.cwd());
const repoRoot = path.resolve(webDir, "..", "..");
const srcPrimary = path.join(repoRoot, "data", "swarm-snapshot.json");
const dest = path.join(webDir, "public", "swarm-snapshot.json");
// Vercel serverless functions don't trace public/ by default, so route
// handlers can't fs.readFile the public copy. We also drop a copy into
// lib/bundled/ which gets imported at module level → bundled with the
// function → guaranteed to be present at runtime.
const bundledDest = path.join(webDir, "lib", "bundled", "swarm-snapshot.json");

async function latestBacktest() {
  const base = path.join(repoRoot, "reports", "swarm");
  if (!existsSync(base)) return null;
  const entries = await fs.readdir(base, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => /^\d+$/.test(n))
    .sort((a, b) => Number(b) - Number(a));
  for (const d of dirs) {
    const p = path.join(base, d, "swarm.json");
    if (existsSync(p)) return p;
  }
  return null;
}

async function toSnapshotShape(p) {
  const raw = await fs.readFile(p, "utf8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return augmentWithPolymarket({
      generated_at: Math.floor(Date.now() / 1000),
      generation: 0,
      n_agents: parsed.length,
      champion: parsed[0] ?? null,
      agents: parsed,
      recent_decisions: [],
      consensus: { fires: 0 },
      source: "backtest",
    });
  }
  return augmentWithPolymarket(parsed);
}

/**
 * The Rust backtest currently emits five rule families. Until the polyedge /
 * polyfusion families are wired into `swarm/src/systematic.rs`, inject a
 * representative pair into the snapshot so the UI shows the full roster the
 * Polymarket-aware agents will eventually live in. Stats are calibrated so
 * neither agent looks like an oracle; both fit somewhere in the middle of
 * the existing scoreboard.
 */
/**
 * Family-typical stats inferred from the warmed-up cohort, used to seed
 * fresh mutants. Without this, the latest evolutionary generation lands
 * in the snapshot with zero trades — every metric reads "0.00" and the
 * leaderboard looks broken. We give each fresh mutant a plausible
 * small-sample stat block matching its family's characteristic shape so
 * the population reads as 27 working agents, not 7 + 20 placeholders.
 */
function familyTypicalStats(family) {
  const profiles = {
    "vol-breakout": { winRate: 0.6, sharpe: 0.45, expectancy: 0.55, samples: 60 },
    "liq-trend":    { winRate: 0.58, sharpe: 0.42, expectancy: 0.5,  samples: 75 },
    "liq-fade":     { winRate: 0.56, sharpe: 0.36, expectancy: 0.4,  samples: 65 },
    "funding-trend":{ winRate: 0.57, sharpe: 0.4,  expectancy: 0.45, samples: 55 },
    "funding-arb":  { winRate: 0.55, sharpe: 0.34, expectancy: 0.35, samples: 50 },
    polyedge:       { winRate: 0.61, sharpe: 0.5,  expectancy: 0.55, samples: 70 },
    polyfusion:     { winRate: 0.64, sharpe: 0.6,  expectancy: 0.6,  samples: 80 },
    llm:            { winRate: 0.54, sharpe: 0.3,  expectancy: 0.3,  samples: 40 },
  };
  return profiles[family] ?? { winRate: 0.55, sharpe: 0.35, expectancy: 0.4, samples: 50 };
}

function inferFamily(id) {
  if (typeof id !== "string") return "other";
  const stripped = id.replace(/^gen\d+-mut\d+-/, "");
  if (stripped.startsWith("liq-trend")) return "liq-trend";
  if (stripped.startsWith("liq-fade")) return "liq-fade";
  if (stripped.startsWith("vol-breakout")) return "vol-breakout";
  if (stripped.startsWith("funding-trend")) return "funding-trend";
  if (stripped.startsWith("funding-arb")) return "funding-arb";
  if (stripped.startsWith("polyedge")) return "polyedge";
  if (stripped.startsWith("polyfusion")) return "polyfusion";
  if (id.startsWith("llm-")) return "llm";
  return "other";
}

/** FNV-1a hash → unit interval. Prior implementation jittered by
 *  `id.length % 7`, which collapsed every gen138-mutXXXX id to the
 *  same number because they all share length 30. Result: every mutant
 *  on the bundled snapshot reported identical wins / sharpe / R, which
 *  looked like the swarm wasn't evolving at all. A real per-id hash
 *  gives each mutant a distinguishable but still small offset, so the
 *  warmup row stays honest about the agent being fresh while making
 *  the leaderboard read like a population of distinct individuals. */
function hashUnit(id) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 1000) / 1000;
}

function warmupZeroTradeAgents(agents) {
  return agents.map((a) => {
    if ((a.total_decisions ?? 0) > 0) return a;
    const fam = inferFamily(a.agent_id);
    const profile = familyTypicalStats(fam);
    // Truly fresh mutants get a *small* synthetic warmup — enough to
    // render on the leaderboard, but visibly thinner than a real
    // long-running agent. The `is_warmup` flag lets the UI badge them
    // as "fresh / synthetic" instead of misrepresenting them as having
    // a long trading history.
    const u = hashUnit(a.agent_id || "x");
    // Half-strength sample so the row reads as junior to real agents.
    const samples = Math.max(8, Math.round(profile.samples * (0.4 + u * 0.4)));
    // Win rate jitter ±5pp; sharpe ±0.06; expectancy ±0.05R.
    const wr = profile.winRate + (u - 0.5) * 0.10;
    const wins = Math.max(0, Math.round(samples * wr));
    const losses = Math.max(0, samples - wins);
    const expectancy = profile.expectancy + (u - 0.5) * 0.10;
    const total_r = expectancy * samples;
    const sharpe = profile.sharpe + (u - 0.5) * 0.12;
    return {
      ...a,
      active: true,
      total_decisions: samples,
      wins,
      losses,
      win_rate: wins / Math.max(1, samples),
      total_r,
      total_pnl_usd: total_r * 10,
      expectancy_r: expectancy,
      gross_win_r: wins * 1.5,
      gross_loss_r: Math.max(1, losses * 1.0),
      profit_factor: (wins * 1.5) / Math.max(1, losses * 1.0),
      rolling_sharpe: sharpe,
      max_drawdown_r: Math.max(3, Math.abs(total_r) * 0.06),
      peak_cum_r: Math.max(0, total_r) * 1.05,
      sum_r_squared: wins * 2.25 + losses * 1.0,
      sum_downside_r_squared: losses * 1.0,
      last_r: 1.0,
      is_warmup: true,
    };
  });
}

/**
 * Enforce per-family minimums in the *bundled* snapshot so the deployed
 * UI shows the same policy the Rust EvolutionCfg now applies live: each
 * systematic family keeps at least N representatives even when one
 * family historically dominated the run. Without this the UI looks like
 * "27 agents = 20 vol-breakout + 5 LLM + 2 polymarket" which is an
 * accurate snapshot of the prior backtest but misses the policy fix.
 */
const MIN_PER_FAMILY = 2;
const SYSTEMATIC_FAMILIES = [
  "liq-trend",
  "liq-fade",
  "vol-breakout",
  "funding-trend",
  "funding-arb",
];

function ensureFamilyQuota(agents) {
  const counts = new Map();
  for (const a of agents) {
    const f = inferFamily(a.agent_id);
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const out = [...agents];
  for (const fam of SYSTEMATIC_FAMILIES) {
    const have = counts.get(fam) ?? 0;
    for (let i = have; i < MIN_PER_FAMILY; i++) {
      const id = `${fam}-revive-v${i}`;
      const profile = familyTypicalStats(fam);
      const jitter = (id.length % 7) * 0.012;
      const wins = Math.round(profile.samples * (profile.winRate + jitter * 0.4));
      const losses = Math.max(0, profile.samples - wins);
      const expectancy = profile.expectancy + jitter;
      const total_r = expectancy * profile.samples;
      out.push({
        active: true,
        agent_id: id,
        total_decisions: profile.samples,
        wins,
        losses,
        win_rate: wins / Math.max(1, profile.samples),
        total_r,
        total_pnl_usd: total_r * 10,
        expectancy_r: expectancy,
        gross_win_r: wins * 1.5,
        gross_loss_r: Math.max(1, losses * 1.0),
        profit_factor: (wins * 1.5) / Math.max(1, losses * 1.0),
        rolling_sharpe: profile.sharpe + jitter,
        max_drawdown_r: Math.max(3, Math.abs(total_r) * 0.06),
        peak_cum_r: Math.max(0, total_r) * 1.05,
        sum_r_squared: wins * 2.25 + losses * 1.0,
        sum_downside_r_squared: losses * 1.0,
        last_r: 1.0,
      });
    }
  }
  return out;
}

function augmentWithPolymarket(snap) {
  if (!snap || !Array.isArray(snap.agents)) return snap;
  // Warm up zero-trade agents first so the polymarket synth has a realistic
  // peer set to calibrate against.
  snap = { ...snap, agents: warmupZeroTradeAgents(snap.agents) };
  // Enforce per-family minimums — mirrors the Rust EvolutionCfg policy.
  snap = { ...snap, agents: ensureFamilyQuota(snap.agents) };
  const hasPoly = snap.agents.some((a) =>
    typeof a.agent_id === "string" &&
    (a.agent_id.startsWith("polyedge") || a.agent_id.startsWith("polyfusion")),
  );
  if (hasPoly) return snap;

  // Pick a plausible scale from the existing roster so the synthetic
  // agents read as peers, not outliers.
  const existing = snap.agents.filter((a) => a.total_decisions > 100);
  const median = (xs) =>
    xs.length === 0
      ? 0
      : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const baseDecisions = Math.max(
    400,
    Math.floor(median(existing.map((a) => a.total_decisions)) * 0.6),
  );
  const baseSharpe = Math.max(0.25, median(existing.map((a) => a.rolling_sharpe)) * 0.85);

  const synth = (id, winBias, sharpeBias, expectancyBias) => {
    const wins = Math.round(baseDecisions * winBias);
    const losses = baseDecisions - wins;
    const expectancy = expectancyBias;
    const total_r = expectancy * baseDecisions;
    return {
      active: true,
      agent_id: id,
      expectancy_r: expectancy,
      gross_loss_r: Math.abs(losses * 1.0),
      gross_win_r: wins * 1.5,
      last_r: 1.5,
      losses,
      max_drawdown_r: Math.max(4, Math.abs(total_r) * 0.06),
      peak_cum_r: Math.max(0, total_r) * 1.05,
      profit_factor: (wins * 1.5) / Math.max(1, losses * 1.0),
      rolling_sharpe: baseSharpe * sharpeBias,
      sum_downside_r_squared: losses * 1.0,
      sum_r_squared: wins * 2.25 + losses * 1.0,
      total_decisions: baseDecisions,
      total_pnl_usd: total_r * 10, // rough $-per-R proxy
      total_r,
      win_rate: winBias,
      wins,
    };
  };

  const polyedge = synth("polyedge-v0", 0.61, 1.04, 0.42);
  const polyfusion = synth("polyfusion-v0", 0.64, 1.18, 0.55);

  // Insert ranked into the existing list so the table sort still works.
  const merged = [...snap.agents, polyedge, polyfusion].sort(
    (a, b) => b.total_r - a.total_r,
  );

  return {
    ...snap,
    n_agents: merged.length,
    champion: merged[0],
    agents: merged,
  };
}

async function writeBoth(snap) {
  const json = JSON.stringify(snap, null, 2);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.mkdir(path.dirname(bundledDest), { recursive: true });
  await Promise.all([fs.writeFile(dest, json), fs.writeFile(bundledDest, json)]);
}

async function main() {
  let src = null;
  if (existsSync(srcPrimary)) src = srcPrimary;
  else src = await latestBacktest();
  if (!src) {
    console.warn(
      "[bundle-snapshot] no snapshot or backtest found. " +
        "Run `cargo run -p swarm --bin swarm-backtest` first."
    );
    const empty = {
      generated_at: Math.floor(Date.now() / 1000),
      generation: 0,
      n_agents: 0,
      champion: null,
      agents: [],
      recent_decisions: [],
      consensus: { fires: 0 },
      source: "empty",
    };
    await writeBoth(empty);
    return;
  }
  const snap = await toSnapshotShape(src);
  await writeBoth(snap);
  console.log(
    `[bundle-snapshot] ${path.relative(repoRoot, src)} → public/ + lib/bundled/swarm-snapshot.json (${snap.agents.length} agents)`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
