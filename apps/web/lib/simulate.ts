import type { AgentStats } from "@/lib/swarm";
import { agentFamily } from "@/lib/swarm";

export type SimAsset = "BTC" | "ETH";
export type SimEventKind = "liq-spike" | "funding-spike" | "vol-breakout";
export type SimDirection = "long" | "short";

export type SimEvent = {
  id: string;
  ts: number;
  asset: SimAsset;
  kind: SimEventKind;
  magnitude_z: number; // z-score of the input (2.5 = typical trigger)
  direction: SimDirection; // the "raw" sign of the event
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
 *  averages those into a single trip-point per family. */
const TRIGGER_Z = 2.0;

export function simulateReactions(
  ev: SimEvent,
  agents: AgentStats[],
): SimReaction[] {
  return agents.map((a) => {
    const family = agentFamily(a.agent_id);
    let reacted = false;
    let dir: SimDirection = ev.direction;
    let rationale = "no match";

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

    return { agent_id: a.agent_id, reacted, direction: dir, rationale, family };
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
  const risk_usd = equity_usd * risk_fraction;
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
