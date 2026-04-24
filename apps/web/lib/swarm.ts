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
};

export type SwarmSnapshot = {
  generated_at: number;
  n_agents: number;
  champion: AgentStats | null;
  agents: AgentStats[];
  recent_decisions: unknown[];
  consensus: { fires: number };
  source: "live" | "demo";
};

export async function fetchSwarm(): Promise<SwarmSnapshot> {
  const res = await fetch("/api/swarm", { cache: "no-store" });
  if (!res.ok) throw new Error("swarm snapshot unavailable");
  return res.json();
}

/** Parent rule-family for colouring / clustering. */
export function agentFamily(id: string): "liq-trend" | "liq-fade" | "vol-breakout" | "funding-trend" | "funding-arb" | "other" {
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
  other: "#94a3b8",
};
