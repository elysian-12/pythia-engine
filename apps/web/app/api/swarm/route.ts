import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

// Serve the swarm snapshot JSON. Priority:
//   1. data/swarm-snapshot.json   — written by swarm-backtest or the
//                                     live daemon every 10 s
//   2. reports/swarm/<latest>/swarm.json — fall back to the most recent
//                                            backtest if step 1 missing
//   3. Empty snapshot              — signals the UI to show an onboarding
//                                      message instead of fake numbers
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
  generation: number;
  n_agents: number;
  champion: AgentStats | null;
  agents: AgentStats[];
  recent_decisions: unknown[];
  consensus: { fires: number; wins?: number };
  source: "live" | "backtest" | "empty";
};

function repoRoot(): string {
  // apps/web → ../..
  return path.resolve(process.cwd(), "..", "..");
}

/**
 * Snapshot sources, in priority order:
 *   1. PYTHIA_SNAPSHOT env var (explicit override)
 *   2. repo-root data/swarm-snapshot.json (live daemon + swarm-backtest write here)
 *   3. bundled public/swarm-snapshot.json (copied at build time by
 *      scripts/bundle-snapshot.mjs — the only path that works on Vercel)
 */
function snapshotCandidates(): string[] {
  const env = process.env.PYTHIA_SNAPSHOT;
  const out: string[] = [];
  if (env) out.push(env);
  out.push(path.join(repoRoot(), "data", "swarm-snapshot.json"));
  out.push(path.join(process.cwd(), "public", "swarm-snapshot.json"));
  return out;
}

async function readJson(p: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function latestBacktestReport(): Promise<AgentStats[] | null> {
  const base = path.join(repoRoot(), "reports", "swarm");
  try {
    const entries = await fs.readdir(base, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => /^\d+$/.test(n))
      .sort((a, b) => Number(b) - Number(a));
    for (const d of dirs) {
      const p = path.join(base, d, "swarm.json");
      const data = await readJson(p);
      if (Array.isArray(data)) return data as AgentStats[];
    }
    return null;
  } catch {
    return null;
  }
}

function emptySnapshot(): Snapshot {
  return {
    generated_at: Math.floor(Date.now() / 1000),
    generation: 0,
    n_agents: 0,
    champion: null,
    agents: [],
    recent_decisions: [],
    consensus: { fires: 0 },
    source: "empty",
  };
}

export async function GET() {
  // 1. Try each snapshot candidate path in order.
  for (const p of snapshotCandidates()) {
    const live = (await readJson(p)) as Partial<Snapshot> | null;
    if (live && Array.isArray(live.agents) && live.agents.length > 0) {
      return NextResponse.json({ ...live, source: live.source ?? "live" });
    }
  }

  // 2. Fall back to the latest backtest report (dev-only; no fs on Vercel).
  const ranked = await latestBacktestReport();
  if (ranked && ranked.length > 0) {
    return NextResponse.json({
      generated_at: Math.floor(Date.now() / 1000),
      generation: 0,
      n_agents: ranked.length,
      champion: ranked[0],
      agents: ranked,
      recent_decisions: [],
      consensus: { fires: 0 },
      source: "backtest",
    } satisfies Snapshot);
  }

  // 3. Nothing available — UI shows the onboarding copy.
  return NextResponse.json(emptySnapshot());
}
