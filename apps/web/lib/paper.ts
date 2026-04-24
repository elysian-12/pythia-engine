import type { SimAsset, SimDirection } from "@/lib/simulate";

// Paper Hyperliquid position ledger. Positions open when the mirrored agent
// (champion by default) reacts to an event; they close on stop / TP /
// manual action / session end. All numbers are in USD and contract counts
// that mirror what the Rust live-executor crate would do, so the UI's
// ledger is a faithful preview of the real placement path.

export type PaperSide = SimDirection;

export type PaperPosition = {
  id: string;
  agent_id: string;
  asset: SimAsset;
  side: PaperSide;
  size_contracts: number;
  notional_usd: number;
  entry: number;
  stop: number;
  take_profit: number;
  opened_at: number;
  closed_at?: number;
  close_px?: number;
  close_reason?: "stop" | "tp" | "manual";
  pnl_usd?: number;
  mark?: number; // last seen mark price (for display)
};

/** Live mark-to-market PnL for an open position. */
export function unrealizedPnl(p: PaperPosition, mark: number): number {
  const diff = p.side === "long" ? mark - p.entry : p.entry - mark;
  return diff * p.size_contracts;
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
