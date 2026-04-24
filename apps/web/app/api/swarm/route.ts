import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

// Serve the swarm snapshot JSON that `pythia-swarm-live` writes to disk
// every ~10 s. In dev the web app reads from the repo root; in prod it
// reads from wherever PYTHIA_SNAPSHOT points.
export const dynamic = "force-dynamic";
export const revalidate = 0;

type AgentStats = {
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

type Snapshot = {
  generated_at: number;
  n_agents: number;
  champion: AgentStats | null;
  agents: AgentStats[];
  recent_decisions: unknown[];
  consensus: { fires: number };
};

function resolveSnapshotPath(): string {
  const env = process.env.PYTHIA_SNAPSHOT;
  if (env) return env;
  // Web app lives at apps/web; snapshot lives at repo root under data/.
  return path.resolve(process.cwd(), "..", "..", "data", "swarm-snapshot.json");
}

function demoSnapshot(): Snapshot {
  // Deterministic demo data so the page renders before the daemon runs.
  const seeds = [
    ["liq-trend-v0", 12.4, 0.62, 58],
    ["liq-trend-aggressive", 9.1, 0.55, 72],
    ["vol-breakout-v2", 8.6, 0.5, 49],
    ["funding-trend-v0", 7.8, 0.58, 31],
    ["liq-trend-conservative", 6.4, 0.6, 44],
    ["liq-trend-v2", 5.2, 0.54, 51],
    ["vol-breakout-v0", 4.3, 0.48, 62],
    ["funding-arb-v1", 3.1, 0.52, 22],
    ["liq-trend-kelly", 2.5, 0.53, 47],
    ["liq-trend-degen", 1.7, 0.51, 45],
    ["funding-arb-v2", 0.9, 0.5, 18],
    ["liq-fade-v1", 0.2, 0.49, 43],
    ["vol-breakout-v1", -0.5, 0.47, 55],
    ["liq-trend-v3", -1.1, 0.48, 40],
    ["funding-trend-v2", -1.8, 0.45, 15],
    ["liq-fade-v2", -2.4, 0.46, 38],
    ["funding-trend-v1", -3.9, 0.44, 25],
    ["funding-arb-v0", -5.2, 0.42, 30],
    ["liq-fade-v0", -6.8, 0.4, 52],
    ["liq-trend-v1", -7.5, 0.41, 48],
  ];
  const agents: AgentStats[] = seeds.map(([id, r, wr, td]) => ({
    agent_id: String(id),
    total_decisions: Number(td),
    wins: Math.round(Number(td) * Number(wr)),
    losses: Number(td) - Math.round(Number(td) * Number(wr)),
    total_r: Number(r),
    total_pnl_usd: Number(r) * 50,
    rolling_sharpe: Number(r) / 10,
    win_rate: Number(wr),
    last_r: (Number(r) % 3) - 1.2,
    active: true,
  }));
  return {
    generated_at: Math.floor(Date.now() / 1000),
    n_agents: agents.length,
    champion: agents[0] ?? null,
    agents,
    recent_decisions: [],
    consensus: { fires: 47 },
  };
}

export async function GET() {
  const p = resolveSnapshotPath();
  try {
    const raw = await fs.readFile(p, "utf8");
    const snap = JSON.parse(raw) as Snapshot;
    return NextResponse.json({ ...snap, source: "live" });
  } catch {
    return NextResponse.json({ ...demoSnapshot(), source: "demo" });
  }
}
