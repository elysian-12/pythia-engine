// Portfolio meta-agent. The router picks *which* specialist to follow
// for an inbound event, but it doesn't manage exits, doesn't aggregate
// across events, and doesn't react when the swarm changes its mind on
// an asset we already have exposure on. That is this module's job.
//
// Three policy functions, each a pure step the UI orchestrates:
//
//  - decideEntry  — decide what to do on a fresh router decision: skip,
//                   reverse-then-open, or open new.
//  - manageOnMark — run on every mark tick; emit trail-stop adjustments
//                   and time-stop closes.
//  - manageOnEvent— run on every fresh event before decideEntry: emit
//                   "swarm voted opposite to my open position with high
//                   conviction" closes so we follow the swarm out as
//                   well as in.
//
// Configurable per-user via PortfolioConfig — the SettingsForm exposes
// the same fields and persists them through /api/config so the rules
// follow the user across reloads.

import type { SimAsset } from "@/lib/simulate";
import type { CloseReason, PaperPosition } from "@/lib/paper";
import { riskUsd, unrealizedPnl, unrealizedR } from "@/lib/paper";

export type PortfolioConfig = {
  /** Hard cap on simultaneously open paper positions across all assets. */
  max_open_positions: number;
  /** Skip new entries below this ensemble conviction (router output). */
  min_conviction: number;
  /** Force-exit a position older than this many hours — even at a loss.
   *  Stops paper sessions from carrying stale entries forever. */
  time_stop_hours: number;
  /** Once unrealized R crosses this threshold, ratchet the stop up so
   *  the trade can only close at break-even or better. Set to 0 to
   *  disable trailing entirely. */
  trail_after_r: number;
  /** Once a fresh event arrives on the same asset and the ensemble
   *  vote runs *opposite* to our open position with at least this much
   *  conviction, close the position. Set to 1.01 to disable. */
  swarm_flip_conviction: number;
};

export const DEFAULT_PORTFOLIO_CONFIG: PortfolioConfig = {
  max_open_positions: 8,
  min_conviction: 0.30,
  time_stop_hours: 12,
  trail_after_r: 1.0,
  swarm_flip_conviction: 0.40,
};

// --- Entry policy --------------------------------------------------------

export type EntryAction =
  | { kind: "skip"; reason: string }
  | { kind: "open"; reason: string }
  | { kind: "reverse"; reason: string; close_id: string };

type EntryInputs = {
  asset: SimAsset;
  direction: "long" | "short" | null;
  conviction: number;
  open: PaperPosition[];
  config: PortfolioConfig;
};

/** Decide whether a fresh router signal should open a new position,
 *  close an opposite one first, or be skipped. Pure — no side effects.
 *
 *  NB: `conviction` from `routeTrade` is *signed* — `+1` = unanimous
 *  long, `-1` = unanimous short, `0` = split. The strength threshold
 *  must therefore compare the *magnitude*; direction is in the
 *  `direction` field already. The earlier implementation compared the
 *  signed conviction directly, which meant strong-short signals
 *  (conviction ≤ -0.5) always failed `conviction < min_conviction`
 *  and the meta-agent skipped every short trade. */
export function decideEntry(inp: EntryInputs): EntryAction {
  const { asset, direction, conviction, open, config } = inp;
  const strength = Math.abs(conviction);

  if (!direction) {
    return { kind: "skip", reason: "router stayed flat" };
  }
  if (strength < config.min_conviction) {
    return {
      kind: "skip",
      reason: `conviction ${strength.toFixed(2)} below floor ${config.min_conviction.toFixed(2)}`,
    };
  }

  // Same-asset, opposite-direction position → reverse out of it before
  // opening the new one. This is the "follow the swarm out" behaviour
  // — strongest signal that the prior thesis is wrong.
  const opposite = open.find(
    (p) => p.asset === asset && p.side !== direction,
  );
  if (opposite) {
    return {
      kind: "reverse",
      reason: `flipping ${opposite.side} → ${direction} on ${asset}`,
      close_id: opposite.id,
    };
  }

  // Same-asset, same-direction position already exists → skip. Avoids
  // 25× same-direction stack-up. Pyramiding could be a future opt-in.
  const same = open.find(
    (p) => p.asset === asset && p.side === direction,
  );
  if (same) {
    return {
      kind: "skip",
      reason: `already ${direction} ${asset} (id ${same.id.slice(0, 12)})`,
    };
  }

  if (open.length >= config.max_open_positions) {
    return {
      kind: "skip",
      reason: `at position cap ${open.length}/${config.max_open_positions}`,
    };
  }

  return { kind: "open", reason: "fresh exposure" };
}

// --- Mark-tick management ------------------------------------------------

/** Result of running the mark-tick policy. `updated` carries any
 *  per-position field changes (trail stops, peak watermark). `closes`
 *  is the list of positions the policy wants to flatten — the caller
 *  applies the close at the most recent mark. */
export type MarkPolicyResult = {
  updated: PaperPosition[];
  closes: Array<{ id: string; reason: CloseReason; mark: number }>;
};

/** Run trailing-stop and time-stop rules against the current marks.
 *  Pure — caller commits the diff to React state. */
export function manageOnMark(
  positions: PaperPosition[],
  marks: { BTC: number | null; ETH: number | null },
  config: PortfolioConfig,
  nowSec: number,
): MarkPolicyResult {
  const updated: PaperPosition[] = [];
  const closes: MarkPolicyResult["closes"] = [];

  for (const p of positions) {
    const mark = p.asset === "BTC" ? marks.BTC : marks.ETH;
    if (mark == null) {
      updated.push(p);
      continue;
    }

    // Time stop — forced exit on age. Comes first so a stale position
    // doesn't get its stop trailed into a never-closing zombie.
    if (config.time_stop_hours > 0) {
      const ageHours = (nowSec - p.opened_at) / 3600;
      if (ageHours >= config.time_stop_hours) {
        closes.push({ id: p.id, reason: "time", mark });
        continue;
      }
    }

    // Update peak watermark — used by the trailing stop.
    let peak = p.peak;
    if (p.side === "long") {
      peak = peak == null ? mark : Math.max(peak, mark);
    } else {
      peak = peak == null ? mark : Math.min(peak, mark);
    }

    // Trailing stop. Only ratchets up; never moves the stop against us.
    let stop = p.stop;
    if (config.trail_after_r > 0) {
      const r = unrealizedR({ ...p, peak }, mark);
      if (r >= config.trail_after_r) {
        const r1 = riskUsd(p) / p.size_contracts; // 1R as price distance
        const trailLong = (peak ?? mark) - r1;
        const trailShort = (peak ?? mark) + r1;
        const breakeven = p.entry;
        if (p.side === "long") {
          // First lock breakeven, then trail at peak − 1R.
          const target = r >= 2 * config.trail_after_r ? trailLong : breakeven;
          if (target > stop) stop = target;
        } else {
          const target = r >= 2 * config.trail_after_r ? trailShort : breakeven;
          if (target < stop) stop = target;
        }
      }
    }

    updated.push({ ...p, peak, stop });
  }

  return { updated, closes };
}

// --- Event-tick management ----------------------------------------------

type EventPolicyInputs = {
  asset: SimAsset;
  vote_direction: "long" | "short" | "flat";
  conviction: number;
  positions: PaperPosition[];
  config: PortfolioConfig;
};

/** When a fresh ensemble vote on an asset runs *opposite* the side of
 *  an open position with high enough conviction, close the position.
 *  Returns the ids that should be flattened — caller closes them at
 *  the latest mark. Same signed-vs-magnitude trap as `decideEntry`:
 *  conviction is `[-1, +1]` (sign = direction), so the threshold check
 *  must compare against the magnitude. */
export function manageOnEvent(inp: EventPolicyInputs): string[] {
  const { asset, vote_direction, conviction, positions, config } = inp;
  if (vote_direction === "flat") return [];
  if (Math.abs(conviction) < config.swarm_flip_conviction) return [];
  return positions
    .filter((p) => p.asset === asset && p.side !== vote_direction)
    .map((p) => p.id);
}

// --- Display helpers -----------------------------------------------------

const EXIT_LABEL: Record<CloseReason, string> = {
  stop: "stop",
  tp: "take profit",
  manual: "manual",
  trail: "trail",
  time: "time stop",
  reverse: "reverse",
  "swarm-flip": "swarm flip",
};

export function formatExitReason(r: CloseReason | undefined): string {
  return EXIT_LABEL[r ?? "manual"] ?? "manual";
}

/** Total notional of open positions, summed across assets. Used as the
 *  exposure floor in the panel and for circuit-breaker logic. */
export function grossNotional(positions: PaperPosition[]): number {
  return positions.reduce((a, p) => a + p.notional_usd, 0);
}

/** Useful for a header chip — sum of all unrealized PnL at the current
 *  marks, ignoring positions whose asset doesn't have a price yet. */
export function totalUnrealized(
  positions: PaperPosition[],
  marks: { BTC: number | null; ETH: number | null },
): number {
  return positions.reduce((a, p) => {
    const m = p.asset === "BTC" ? marks.BTC : marks.ETH;
    if (m == null) return a;
    return a + unrealizedPnl(p, m);
  }, 0);
}
