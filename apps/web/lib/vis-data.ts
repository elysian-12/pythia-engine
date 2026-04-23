// Typed loaders for the JSON datasets emitted by `cargo run -p strategy --bin export_vis`.

export type EquityPoint = { ts: number; equity: number };
export type TradePoint = {
  ts: number;
  asset: string;
  dir: string;
  pnl: number;
  r: number;
};
export type LiqPoint = { ts: number; net_usd: number; gross_usd: number };
export type CandleLite = { ts: number; close: number };
export type CandleBundle = { btc: CandleLite[]; eth: CandleLite[] };
export type GridRow = {
  name: string;
  risk: number;
  compound: boolean;
  trades: number;
  pnl: number;
  roi: number;
  sharpe: number;
  max_dd: number;
  realistic: boolean;
};
export type Summary = {
  starting_equity: number;
  final_equity: number;
  pnl_usd: number;
  roi_pct: number;
  n_trades: number;
  win_rate: number;
  profit_factor: number;
  sharpe: number;
  sortino: number;
  max_drawdown: number;
  calmar: number;
  start_ts: number;
  end_ts: number;
  strategy: string;
  universe: string;
  data_points: number;
};

async function fetchJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { cache: "no-store" });
  return (await r.json()) as T;
}

export const loadEquity = () => fetchJson<EquityPoint[]>("/data/equity.json");
export const loadTrades = () => fetchJson<TradePoint[]>("/data/trades.json");
export const loadLiqs = () => fetchJson<LiqPoint[]>("/data/liquidations.json");
export const loadCandles = () => fetchJson<CandleBundle>("/data/candles.json");
export const loadGrid = () => fetchJson<GridRow[]>("/data/grid.json");
export const loadSummary = () => fetchJson<Summary>("/data/summary.json");
