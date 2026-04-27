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
  /** Probability of Backtest Overfitting (Bailey & López de Prado).
   * Lower is better; < 0.5 = winning configuration generalises out
   * of sample more than half the time. Optional because older
   * snapshots predate the PBO wiring. */
  pbo?: number | null;
  pbo_splits?: number;
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

/**
 * Fold a simulated event's reactions into the snapshot — the page-local
 * mutation that keeps the leaderboard alive between server refreshes.
 *
 * The Rust scoreboard does this server-side every event; on Vercel we
 * only get the static bundled snapshot, so without this the swarm reads
 * as a frozen tableau no matter how many events the user fires. We
 * apply each fired agent a small synthetic R drawn from the agent's own
 * empirical win-rate, increment trade counters, and re-rank.
 */
export type SimReactionLite = {
  agent_id: string;
  reacted: boolean;
};

export function applySessionDelta(
  snap: SwarmSnapshot,
  reactions: SimReactionLite[],
  rngSeed: number,
): SwarmSnapshot {
  if (!snap.agents.length) return snap;
  const fired = new Set(reactions.filter((r) => r.reacted).map((r) => r.agent_id));
  if (fired.size === 0) return snap;
  // Cheap deterministic hash → uniform [0,1).
  const h = (n: number) => {
    let s = (n + 0x9e3779b9) >>> 0;
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  };
  let i = 0;
  const nextAgents = snap.agents.map((a) => {
    if (!fired.has(a.agent_id)) return a;
    i += 1;
    const u = h(rngSeed * 1000 + i);
    // Win at the agent's empirical rate; +1.5R on win, -1.0R on loss.
    const r = u < a.win_rate ? 1.5 : -1.0;
    const wins = a.wins + (r > 0 ? 1 : 0);
    const losses = a.losses + (r > 0 ? 0 : 1);
    const decided = wins + losses;
    const total_r = a.total_r + r;
    return {
      ...a,
      total_decisions: a.total_decisions + 1,
      wins,
      losses,
      total_r,
      total_pnl_usd: a.total_pnl_usd + r * 10,
      win_rate: decided > 0 ? wins / decided : a.win_rate,
      last_r: r,
      expectancy_r: decided > 0 ? total_r / decided : a.expectancy_r,
    };
  });
  // Re-rank by total_r and update champion.
  const sorted = [...nextAgents].sort((x, y) => y.total_r - x.total_r);
  return {
    ...snap,
    agents: sorted,
    champion: sorted[0] ?? null,
    consensus: {
      ...snap.consensus,
      fires: snap.consensus.fires + fired.size,
    },
  };
}

/** Parent rule-family for colouring / clustering. */
export type AgentFam =
  | "liq-trend"
  | "liq-fade"
  | "vol-breakout"
  | "funding-trend"
  | "funding-arb"
  | "polyedge"
  | "polyfusion"
  | "llm"
  | "other";

export function agentFamily(id: string): AgentFam {
  if (id.startsWith("llm-")) return "llm";
  if (id.startsWith("liq-trend")) return "liq-trend";
  if (id.startsWith("liq-fade")) return "liq-fade";
  if (id.startsWith("vol-breakout")) return "vol-breakout";
  if (id.startsWith("funding-trend")) return "funding-trend";
  if (id.startsWith("funding-arb")) return "funding-arb";
  if (id.startsWith("polyedge")) return "polyedge";
  if (id.startsWith("polyfusion")) return "polyfusion";
  return "other";
}

// Palette borrowed from Project Hail Mary — astrophage teal, Tau
// Ceti amber, Petrova magenta, Eridian copper-green, Hail Mary
// hull silver. Each family gets a distinct slot in the spectrum so
// the lineage orb reads as a starfield of related but separable
// strategies.
export const FAMILY_COLORS: Record<AgentFam, string> = {
  "liq-trend": "#14b8a6", // astrophage teal — the alien glow
  "liq-fade": "#ef4444", // emergency scarlet
  "vol-breakout": "#fb923c", // Tau Ceti amber
  "funding-trend": "#3b82f6", // navigation blue
  "funding-arb": "#d946ef", // Petrova magenta
  polyedge: "#a855f7", // Adrian violet (prediction-market signal)
  polyfusion: "#cbd5e1", // Hail Mary hull chrome
  llm: "#84cc16", // Eridian ammonia green
  other: "#64748b",
};

export const FAMILY_LABEL: Record<AgentFam, string> = {
  "liq-trend": "Liq trend · ride the cascade",
  "liq-fade": "Liq fade · sell the panic",
  "vol-breakout": "Vol breakout · donchian",
  "funding-trend": "Funding trend · ride the tilt",
  "funding-arb": "Funding arb · fade the tilt",
  polyedge: "Polymarket edge · prediction-market lead",
  polyfusion: "Poly + liq + vol + price fusion",
  llm: "LLM persona · narrative reasoner",
  other: "Other",
};
