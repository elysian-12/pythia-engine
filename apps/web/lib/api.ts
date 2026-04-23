// Server-fetched read models. All routes are served by the Rust API via
// Next's rewrite in next.config.mjs, so absolute URLs aren't needed during
// local dev — the `fetch('/api/...')` call hits the rewritten path.

export type Overview = {
  candles_btc: number;
  candles_eth: number;
  funding: number;
  oi: number;
  liquidations: number;
  trader_profiles: number;
  user_positions: number;
  market_summaries: number;
  signals: number;
  trades: number;
};

export type MarketRow = { condition_id: string };

export type Rate = {
  limit: number;
  remaining: number;
  used: number;
  reset_at: number;
};

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const base = process.env.PYTHIA_API || process.env.POLYEDGE_API || "http://localhost:8080";
    const r = await fetch(base + path, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export const getOverview = () => fetchJson<Overview>("/api/overview");
export const getMarkets = () => fetchJson<MarketRow[]>("/api/markets");
export const getRate = () => fetchJson<Rate>("/api/rate");
