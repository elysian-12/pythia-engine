export type AgentStats = {
  agent_id: string;
  total_decisions: number;
  wins: number;
  losses: number;
  total_r: number;
  total_pnl_usd: number;
  rolling_sharpe: number;
  win_rate: number;
  last_r: number;
  active: boolean;
  // Quant-grade per-trade metrics — populated by the Rust scoreboard.
  // All are optional because older bundled snapshots lacked them.
  gross_win_r?: number;
  gross_loss_r?: number;
  expectancy_r?: number;
  profit_factor?: number;
  max_drawdown_r?: number;
};

export type RegimeInfo = {
  label: "trending" | "ranging" | "chaotic" | "calm";
  directional: number; // 0..1
  vol_ratio: number; // 1 = normal
};

export type ChampionCertification = {
  /** Probability the champion's true Sharpe is positive given sample
   * size, skew, and kurtosis. >0.95 = "real edge, not noise". */
  psr: number;
  /** PSR after deflating for multiple-testing bias from N trials. >0.95
   * means the edge survives even after correcting for picking the best
   * of N agents. The strict statistical green-light. */
  dsr: number;
  sharpe_ci_lo: number | null;
  sharpe_ci_hi: number | null;
  skew: number;
  kurtosis: number;
  n_trials: number;
};

export type SwarmSnapshot = {
  generated_at: number;
  generation?: number;
  n_agents: number;
  champion: AgentStats | null;
  agents: AgentStats[];
  recent_decisions: unknown[];
  consensus: { fires: number; wins?: number };
  regime?: RegimeInfo | null;
  champion_certification?: ChampionCertification | null;
  source: "live" | "backtest" | "empty";
};

export async function fetchSwarm(): Promise<SwarmSnapshot> {
  const res = await fetch("/api/swarm", { cache: "no-store" });
  if (!res.ok) throw new Error("swarm snapshot unavailable");
  return res.json();
}

/** Parent rule-family for colouring / clustering. */
export function agentFamily(
  id: string,
): "liq-trend" | "liq-fade" | "vol-breakout" | "funding-trend" | "funding-arb" | "llm" | "other" {
  if (id.startsWith("llm-")) return "llm";
  if (id.startsWith("liq-trend")) return "liq-trend";
  if (id.startsWith("liq-fade")) return "liq-fade";
  if (id.startsWith("vol-breakout")) return "vol-breakout";
  if (id.startsWith("funding-trend")) return "funding-trend";
  if (id.startsWith("funding-arb")) return "funding-arb";
  return "other";
}

export const FAMILY_COLORS: Record<string, string> = {
  "liq-trend": "#34d399",
  "liq-fade": "#f87171",
  "vol-breakout": "#fbbf24",
  "funding-trend": "#60a5fa",
  "funding-arb": "#c084fc",
  llm: "#f0abfc",
  other: "#94a3b8",
};
