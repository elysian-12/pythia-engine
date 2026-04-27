import type { AgentStats, RegimeInfo } from "@/lib/swarm";
import { agentFamily } from "@/lib/swarm";

/** Family-vs-regime fitness multiplier — mirrors the Rust
 *  `SystematicAgent::regime_fitness` table so the UI preview matches
 *  what the live agents would actually do. Numerator of the conviction
 *  scale + the gate (return null if < MIN_FITNESS). */
const MIN_FITNESS = 0.3;
function regimeFitness(
  family: ReturnType<typeof agentFamily>,
  regime: RegimeInfo | null | undefined,
): number {
  if (!regime) return 1.0;
  const trendish =
    family === "liq-trend" || family === "funding-trend" || family === "vol-breakout";
  const meanRevert = family === "liq-fade" || family === "funding-arb";
  if (trendish) {
    return { trending: 1.0, ranging: 0.3, chaotic: 0.5, calm: 0.6 }[regime.label] ?? 1.0;
  }
  if (meanRevert) {
    return { trending: 0.3, ranging: 1.0, chaotic: 0.5, calm: 0.7 }[regime.label] ?? 1.0;
  }
  if (family === "polyedge") {
    // Polymarket leadership shows up most in directional regimes — info
    // share rises when the prediction market leads spot. Skip in calm.
    return { trending: 1.1, ranging: 0.6, chaotic: 0.7, calm: 0.4 }[regime.label] ?? 1.0;
  }
  if (family === "polyfusion") {
    // Confluence agent: balanced across regimes since it requires multiple
    // independent signals to align before firing.
    return { trending: 1.0, ranging: 0.8, chaotic: 0.5, calm: 0.6 }[regime.label] ?? 1.0;
  }
  return 1.0; // LLM + other families pass through unchanged
}

export type SimAsset = "BTC" | "ETH";
export type SimEventKind =
  | "liq-spike"
  | "funding-spike"
  | "vol-breakout"
  | "polymarket-lead"
  | "fusion";
export type SimDirection = "long" | "short";

export type SimEvent = {
  id: string;
  ts: number;
  asset: SimAsset;
  kind: SimEventKind;
  magnitude_z: number; // z-score of the input (2.5 = typical trigger)
  direction: SimDirection; // the "raw" sign of the event
  /** Optional human-readable provenance — e.g.
   *  "kiyotaka:LIQUIDATION_AGG" — surfaced in the trade-feed footer so
   *  a visitor can trace back where the signal came from. */
  source?: string;
};

/** A predicted agent reaction, for the UI to visualise which orbs
 *  light up when an event fires. Mirrors the decision logic of the
 *  Rust `SystematicAgent` rules at a coarse level — enough for a
 *  faithful preview, not a replacement for the real backtest. */
export type SimReaction = {
  agent_id: string;
  reacted: boolean;
  direction: SimDirection;
  rationale: string;
  family: ReturnType<typeof agentFamily>;
  /** Effective risk fraction after regime fitness scaling — used by
   *  simulateCopyTrade to size the paper position the same way the
   *  real Rust agents would. */
  fitness: number;
};

/** Maps an input event to the reaction of each agent in the snapshot.
 *  The model:
 *    - liq-trend: reacts to liq-spike in same direction as the cascade
 *    - liq-fade:  reacts to liq-spike in opposite direction
 *    - vol-breakout: reacts to vol-breakout in event direction
 *    - funding-trend / funding-arb: react to funding-spike
 *    - llm: passthrough — assume LLM personas trade with the latest signal
 *  All reactions are gated by magnitude_z ≥ 2.0, matching the threshold the
 *  /api/signals detector uses to emit events in the first place. Keeps the
 *  preview consistent with what the autopilot emits.
 *
 *  This is a coarse model of the real Rust SystematicAgent set — individual
 *  agents have varying calibrated thresholds (2.0…3.0). The simulator
 *  averages those into a single trip-point per family.
 *
 *  Lowered from 2.0 → 1.5 in tandem with the /api/signals threshold
 *  drops (liq-spike rz ≥ 1.7, funding ≥ 1.7, real liqs ≥ 1.8). The
 *  prior 2.0 trigger meant real Kiyotaka events at z=1.7-1.9 fired the
 *  rail but produced *zero* reacted agents — leaderboard, peer-view,
 *  and router all saw an empty reaction set, so the page looked
 *  unresponsive even though detection was working. The Rust systematic
 *  agents apply their own per-family z_threshold inside decide(),
 *  which is the actual gate; this UI mirror just needs to be
 *  permissive enough that the rail visibly responds. */
const TRIGGER_Z = 1.5;

export function simulateReactions(
  ev: SimEvent,
  agents: AgentStats[],
  regime?: RegimeInfo | null,
): SimReaction[] {
  return agents.map((a) => {
    const family = agentFamily(a.agent_id);
    let reacted = false;
    let dir: SimDirection = ev.direction;
    let rationale = "no match";
    const fitness = regimeFitness(family, regime);

    switch (family) {
      case "liq-trend":
        if (ev.kind === "liq-spike" && ev.magnitude_z >= TRIGGER_Z) {
          reacted = true;
          dir = ev.direction; // trend: with the cascade
          rationale = `|z|=${ev.magnitude_z.toFixed(2)} ≥ ${TRIGGER_Z} · ride the cascade`;
        }
        break;
      case "liq-fade":
        if (ev.kind === "liq-spike" && ev.magnitude_z >= TRIGGER_Z) {
          reacted = true;
          dir = ev.direction === "long" ? "short" : "long";
          rationale = `|z|=${ev.magnitude_z.toFixed(2)} ≥ ${TRIGGER_Z} · fade the cascade`;
        }
        break;
      case "vol-breakout":
        if (ev.kind === "vol-breakout") {
          reacted = true;
          dir = ev.direction;
          rationale = "donchian breakout in event direction";
        }
        break;
      case "funding-trend":
        if (ev.kind === "funding-spike" && ev.magnitude_z >= TRIGGER_Z) {
          reacted = true;
          dir = ev.direction;
          rationale = "ride the funding tilt";
        }
        break;
      case "funding-arb":
        if (ev.kind === "funding-spike" && ev.magnitude_z >= TRIGGER_Z) {
          reacted = true;
          dir = ev.direction === "long" ? "short" : "long";
          rationale = "fade funding (arb)";
        }
        break;
      case "polyedge":
        // Fires on Polymarket leadership signals. Direction = sign of
        // (skill-weighted-prob - mid). |z| here is the SWP-mid gap in
        // standard deviations (a proxy for cointegration-gated lead).
        if (ev.kind === "polymarket-lead" && ev.magnitude_z >= TRIGGER_Z) {
          reacted = true;
          dir = ev.direction;
          rationale = `Polymarket lead · SWP-mid gap |z|=${ev.magnitude_z.toFixed(2)}`;
        }
        break;
      case "polyfusion":
        // Confluence agent: triggers on any large-enough event but needs
        // a slightly stronger signal. Stand-in for the Rust agent that
        // votes only when ≥2 of {liq, funding, vol, polymarket} agree.
        if (ev.magnitude_z >= TRIGGER_Z + 0.4) {
          reacted = true;
          dir = ev.direction;
          rationale = `confluence · ${ev.kind} · |z|=${ev.magnitude_z.toFixed(2)}`;
        }
        break;
      case "llm":
        // LLM agents in the live system call AnthropicDecider; here we
        // model them as passthrough on big enough events of any kind.
        if (ev.magnitude_z >= TRIGGER_Z + 0.5) {
          reacted = true;
          dir = ev.direction;
          rationale = `LLM persona: |z|=${ev.magnitude_z.toFixed(2)} clears its prudence band`;
        }
        break;
    }

    // Regime gate: if the regime is too hostile, skip even though the
    // base rule matched. This mirrors the Rust SystematicAgent.
    if (reacted && fitness < MIN_FITNESS && family !== "llm") {
      reacted = false;
      rationale = `${rationale} · skipped (regime ${regime?.label}, fit ${fitness.toFixed(2)})`;
    } else if (reacted && regime) {
      rationale = `${rationale} · ${regime.label} fit ${fitness.toFixed(2)}`;
    }

    return {
      agent_id: a.agent_id,
      reacted,
      direction: dir,
      rationale,
      family,
      fitness,
    };
  });
}

/** The trade the copy-trader would end up with, if they're mirroring
 *  `agent` and this event fires and that agent reacted. */
export type CopyTradeSim = {
  agent_id: string;
  direction: SimDirection;
  size_usd: number;
  size_contracts: number;
  entry: number;
  stop: number;
  take_profit: number;
};

export function simulateCopyTrade(
  mirrored: AgentStats,
  ev: SimEvent,
  reactions: SimReaction[],
  equity_usd: number,
  risk_fraction: number,
  btc_price: number,
  eth_price: number,
): CopyTradeSim | null {
  const react = reactions.find((r) => r.agent_id === mirrored.agent_id);
  if (!react || !react.reacted) return null;
  const price = ev.asset === "BTC" ? btc_price : eth_price;
  // Refuse to size on bogus inputs — a 0-priced asset (empty hour from the
  // upstream) would propagate as NaN through stop_dist / notional / size.
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(equity_usd) || equity_usd <= 0) return null;
  if (!Number.isFinite(risk_fraction) || risk_fraction <= 0) return null;
  const atr_est = price * 0.005; // rough ATR proxy, matches Rust executor
  const stop_dist = 1.5 * atr_est;
  // Scale risk by regime fitness so the paper notional matches what the
  // real Rust agent would size at — keeps the UI's what-if honest.
  const risk_usd = equity_usd * risk_fraction * react.fitness;
  const notional = Math.min((risk_usd * price) / stop_dist, equity_usd * 3);
  const size_contracts = notional / price;
  const entry = price;
  const stop = react.direction === "long" ? entry - stop_dist : entry + stop_dist;
  const take_profit =
    react.direction === "long" ? entry + 3 * atr_est : entry - 3 * atr_est;
  return {
    agent_id: mirrored.agent_id,
    direction: react.direction,
    size_usd: notional,
    size_contracts,
    entry,
    stop,
    take_profit,
  };
}
