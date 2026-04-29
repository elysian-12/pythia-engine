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
  /** First trail trigger: at +trail_after_r the stop ratchets to
   *  breakeven. The stepped trail then continues — see `manageOnMark`
   *  for the full ladder (1R → BE, 2R → +1R, 3R → +2R, 4R → +3R). */
  trail_after_r: number;
  /** Strong-opposite-conviction threshold for full swarm-flip exit.
   *  Between `swarm_flip_conviction × 0.6` and this value the position
   *  is *not* closed — instead the trail is tightened so any further
   *  reversal locks the open profit. Continuous, not binary. */
  swarm_flip_conviction: number;
  /** Minimum minutes a position must be open before a swarm-flip can
   *  close it. Stops, take-profit, and reverse-on-entry are NOT
   *  subject to min_hold; only the swarm-flip rule is. Stops the
   *  "every opposite poll-event closes a 30-second-old position at
   *  $0" pathology. */
  min_hold_minutes: number;
  /** Halt new entries when the session's realised PnL drops below
   *  -max_session_dd_pct × equity. Forces a manual reset before
   *  resuming — protects against tilt-trading after a drawdown. Set
   *  to 1.0 to disable the circuit-breaker. */
  max_session_dd_pct: number;
  /** Correlation-aware sizing multiplier for the second asset when
   *  the first is already open. BTC and ETH are ~0.7 correlated on
   *  hourly returns, so opening a full-size ETH long on top of a
   *  full-size BTC long doubles your real exposure. Multiplier in
   *  [0, 1] applied to the secondary position's notional. Set to 1.0
   *  to disable. */
  correlation_size_factor: number;
};

export const DEFAULT_PORTFOLIO_CONFIG: PortfolioConfig = {
  // Quant-grade defaults after the live-ledger autopsy: 9/15 closes
  // were `swarm-flip` for ~$0 realised because the prior config cut
  // winners on every weak opposite signal. The new defaults are:
  //   - flip threshold 0.60 — only flip on strong opposing votes
  //   - trail starts at 1.5R — let winners run, then ratchet via the
  //     stepped trail in manageOnMark (1R→BE, 2R→+1R, 3R→+2R, 4R→+3R)
  //   - 30-min minimum hold before flip — entries get time to move
  //   - 5% session DD circuit-breaker — halt new entries on tilt
  //   - 0.5 correlation factor — second-asset size is halved when the
  //     first is open (BTC/ETH ~0.7 correlated)
  max_open_positions: 8,
  min_conviction: 0.30,
  time_stop_hours: 12,
  trail_after_r: 1.5,
  swarm_flip_conviction: 0.60,
  min_hold_minutes: 30,
  max_session_dd_pct: 0.05,
  correlation_size_factor: 0.5,
};

// --- Entry policy --------------------------------------------------------

export type EntryAction =
  | { kind: "skip"; reason: string }
  | { kind: "open"; reason: string; size_multiplier?: number }
  | { kind: "reverse"; reason: string; close_id: string; size_multiplier?: number };

type EntryInputs = {
  asset: SimAsset;
  direction: "long" | "short" | null;
  conviction: number;
  open: PaperPosition[];
  config: PortfolioConfig;
  /** Realised session PnL in USD. Used by the drawdown circuit-breaker
   *  to halt new entries when the session is bleeding. Optional — when
   *  omitted (or equity is 0) the breaker is a no-op. */
  session_realized_pnl?: number;
  /** Equity baseline for the DD-percentage check. */
  equity_usd?: number;
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
  const { asset, direction, conviction, open, config, session_realized_pnl, equity_usd } = inp;
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

  // DRAWDOWN CIRCUIT-BREAKER. Halt new entries when realised session
  // PnL drops below -max_session_dd_pct × equity. Tilt-trading after
  // a drawdown is the single most expensive thing a discretionary or
  // semi-systematic operator does; this is the rule book equivalent.
  // Reverse-on-flip still works (closing a wrong-side position is
  // never blocked) but no fresh exposure opens until the user resets.
  if (
    config.max_session_dd_pct < 1.0 &&
    typeof session_realized_pnl === "number" &&
    typeof equity_usd === "number" &&
    equity_usd > 0
  ) {
    const ddFraction = -session_realized_pnl / equity_usd;
    if (ddFraction >= config.max_session_dd_pct) {
      // Reversal is still allowed — flipping out of a losing trade
      // is corrective, not additive risk.
      const opp = open.find((p) => p.asset === asset && p.side !== direction);
      if (!opp) {
        return {
          kind: "skip",
          reason: `session DD ${(ddFraction * 100).toFixed(1)}% past circuit-breaker (${(config.max_session_dd_pct * 100).toFixed(1)}%)`,
        };
      }
    }
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

  // CORRELATION-AWARE SIZING. BTC and ETH have ~0.7 correlation on
  // hourly returns. Opening a full-size ETH long when a full-size BTC
  // long is already up doubles your effective exposure to the same
  // factor. Multiplier in [0, 1] halves the second position's notional
  // by default — caller multiplies its computed `notional` by this.
  let size_multiplier: number | undefined;
  if (config.correlation_size_factor < 1.0) {
    const otherAssetOpen = open.find((p) => p.asset !== asset);
    if (otherAssetOpen) {
      size_multiplier = config.correlation_size_factor;
      return {
        kind: "open",
        reason: `fresh exposure (correlation-scaled to ${(size_multiplier * 100).toFixed(0)}% — ${otherAssetOpen.asset} already open)`,
        size_multiplier,
      };
    }
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

    // STEPPED TRAILING STOP — quant-grade profit lock-in ladder.
    // Each rung locks in more of the peak unrealised gain so a winner
    // that gives back can't fully retrace. Only ratchets up; the stop
    // never moves against the position. The cliff intervals are
    // calibrated for 1R-unit Van-Tharp sizing:
    //
    //   r ≥ 1.0 R  →  stop = breakeven                (free trade)
    //   r ≥ 2.0 R  →  stop = peak − 1.00 R            (lock 1R+)
    //   r ≥ 3.0 R  →  stop = peak − 0.75 R            (lock 2.25R+)
    //   r ≥ 4.0 R  →  stop = peak − 0.50 R            (lock 3.50R+)
    //   r ≥ 6.0 R  →  stop = peak − 0.25 R            (squeeze the runner)
    //
    // Replaces the prior 2-step `breakeven → peak−1R` rule, which let
    // huge winners retrace 1R+ before triggering. Configurable: when
    // `trail_after_r` is bumped, the whole ladder shifts.
    let stop = p.stop;
    if (config.trail_after_r > 0) {
      const r = unrealizedR({ ...p, peak }, mark);
      const baseR = config.trail_after_r;
      if (r >= baseR) {
        const r1 = riskUsd(p) / p.size_contracts; // 1R as price distance
        const breakeven = p.entry;
        let trailDistanceR: number | null = null;
        if (r >= 6 * baseR) trailDistanceR = 0.25;
        else if (r >= 4 * baseR) trailDistanceR = 0.5;
        else if (r >= 3 * baseR) trailDistanceR = 0.75;
        else if (r >= 2 * baseR) trailDistanceR = 1.0;
        // First rung: just lock breakeven; below the 2× threshold the
        // peak hasn't moved enough to give a meaningful trail target.
        if (p.side === "long") {
          const target =
            trailDistanceR != null
              ? (peak ?? mark) - trailDistanceR * r1
              : breakeven;
          if (target > stop) stop = target;
        } else {
          const target =
            trailDistanceR != null
              ? (peak ?? mark) + trailDistanceR * r1
              : breakeven;
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
  /** Wall-clock now in unix seconds. Used by the `min_hold_minutes`
   *  floor so swarm-flip can't close positions younger than the
   *  configured window. */
  now_secs: number;
  /** Champion-mode override. When provided (live UI path) the
   *  champion's own reaction direction drives the flip — closes only
   *  if THE CHAMPION reacted opposite the position. Aligns the exit
   *  with the entry: in champion-only routing the entry signal is the
   *  champion's vote, so the exit signal should be too. The ensemble
   *  has no track record advantage over the champion, so letting it
   *  override the champion's exit timing creates premature exits.
   *  Pass null/undefined for research scripts that want the ensemble
   *  fall-through behaviour. */
  champion_direction?: "long" | "short" | null;
};

/** When a fresh signal on an asset runs *opposite* an open position
 *  with sufficient strength, close the position. Two gating modes:
 *
 *  Champion mode (live UI path) — `champion_direction` provided:
 *    The champion's own reaction direction drives the flip. If the
 *    champion didn't react, or reacted same-side as the position,
 *    no close. The conviction threshold is bypassed because the
 *    champion's binary fire/no-fire IS the conviction signal in
 *    champion-only mode.
 *
 *  Ensemble mode (research scripts) — `champion_direction` omitted:
 *    Ensemble vote magnitude `|conviction| ≥ swarm_flip_conviction`
 *    must clear the threshold AND vote_direction must oppose the
 *    position.
 *
 *  Both modes apply the `min_hold_minutes` floor so fresh entries
 *  can't be cut within seconds of opening. Stops + reverse-on-entry
 *  are NOT subject to min_hold; only the swarm-flip rule is. */
export function manageOnEvent(inp: EventPolicyInputs): string[] {
  const {
    asset,
    vote_direction,
    conviction,
    positions,
    config,
    now_secs,
    champion_direction,
  } = inp;

  // Determine the opposing-side test.
  let opposingSide: "long" | "short" | null = null;
  if (champion_direction !== undefined) {
    // Champion mode: champion's reaction direction governs (or null
    // if champion didn't react this event).
    if (!champion_direction) return [];
    opposingSide = champion_direction;
  } else {
    // Ensemble fallback (research scripts).
    if (vote_direction === "flat") return [];
    if (Math.abs(conviction) < config.swarm_flip_conviction) return [];
    opposingSide = vote_direction;
  }

  const minAgeSecs = Math.max(0, config.min_hold_minutes) * 60;
  return positions
    .filter((p) => p.asset === asset && p.side !== opposingSide)
    .filter((p) => now_secs - p.opened_at >= minAgeSecs)
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
