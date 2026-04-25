import type { SimAsset, SimDirection } from "@/lib/simulate";

// Paper Hyperliquid position ledger. Positions open when the mirrored
// agent (champion by default) reacts to an event; they close on stop /
// TP / manual action / portfolio-meta-agent rules (trail / time stop /
// swarm-flip / reverse). All numbers are in USD and contract counts
// that mirror what the Rust live-executor crate would do, so the UI's
// ledger is a faithful preview of the real placement path.

export type PaperSide = SimDirection;

export type CloseReason =
  | "stop"
  | "tp"
  | "manual"
  | "trail"        // trailing stop hit after price gave back the gain
  | "time"         // held longer than time_stop_hours; force-exit at mark
  | "reverse"      // swarm flipped to opposite direction → close before opening
  | "swarm-flip";  // swarm voted opposite with conviction; cut without opening anew

export type PaperPosition = {
  id: string;
  agent_id: string;
  asset: SimAsset;
  side: PaperSide;
  size_contracts: number;
  notional_usd: number;
  entry: number;
  /** Initial stop set at entry; used as the R-multiple denominator. */
  initial_stop: number;
  /** Live stop — moved up by the trailing rule once the trade is in profit. */
  stop: number;
  take_profit: number;
  opened_at: number;
  /** Highest mark seen for a long, lowest for a short. Updated on every
   *  mark tick, used by the trailing-stop rule. */
  peak?: number;
  closed_at?: number;
  close_px?: number;
  close_reason?: CloseReason;
  pnl_usd?: number;
  mark?: number; // last seen mark price (for display)
};

/** Risk-per-unit ($) at entry — `|entry − initial_stop| × contracts`.
 *  This is the "1R" denominator. Falls back to `stop` if `initial_stop`
 *  is missing on a legacy session-state position. */
export function riskUsd(p: PaperPosition): number {
  const ref = p.initial_stop ?? p.stop;
  return Math.abs(p.entry - ref) * p.size_contracts;
}

/** Live mark-to-market PnL for an open position. */
export function unrealizedPnl(p: PaperPosition, mark: number): number {
  const diff = p.side === "long" ? mark - p.entry : p.entry - mark;
  return diff * p.size_contracts;
}

/** Live R-multiple of an open position at the given mark. Used by the
 *  trailing-stop and time-stop rules; positive = winning trade. */
export function unrealizedR(p: PaperPosition, mark: number): number {
  const r = riskUsd(p);
  if (r <= 0) return 0;
  return unrealizedPnl(p, mark) / r;
}

/** Realized PnL of a closed position. Uses the close_px it was closed at. */
export function realizedPnl(p: PaperPosition): number {
  if (p.pnl_usd != null) return p.pnl_usd;
  if (p.close_px == null) return 0;
  const diff = p.side === "long" ? p.close_px - p.entry : p.entry - p.close_px;
  return diff * p.size_contracts;
}

/** Check stop/TP triggers against the current mark. Returns the reason the
 *  position should close, or null if it should remain open. */
export function checkTriggers(
  p: PaperPosition,
  mark: number,
): "stop" | "tp" | null {
  if (p.side === "long") {
    if (mark <= p.stop) return "stop";
    if (mark >= p.take_profit) return "tp";
  } else {
    if (mark >= p.stop) return "stop";
    if (mark <= p.take_profit) return "tp";
  }
  return null;
}

export function sumRealized(ps: PaperPosition[]): number {
  return ps.reduce((a, p) => a + realizedPnl(p), 0);
}
