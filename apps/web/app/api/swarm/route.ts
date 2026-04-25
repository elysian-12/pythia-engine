import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import bundledSnapshot from "@/lib/bundled/swarm-snapshot.json";

// Snapshot resolution priority:
//   1. PYTHIA_SNAPSHOT env var (explicit override path)
//   2. repo-root data/swarm-snapshot.json (live daemon writes here every 10s)
//   3. apps/web/public/swarm-snapshot.json (build-time copy for local /public/...)
//   4. Compiled-in lib/bundled/swarm-snapshot.json — the only one Vercel
//      ships into the serverless function bundle by default. Guaranteed
//      to exist (bundle-snapshot.mjs writes both public + lib at prebuild).
//
// Steps 1–3 only fire on hosts with a writable filesystem (local dev,
// dedicated VMs). On Vercel they all fail and we fall through to step 4.
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
  return path.resolve(process.cwd(), "..", "..");
}

function fsCandidates(): string[] {
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

function compiled(): Snapshot {
  const s = bundledSnapshot as unknown as Partial<Snapshot>;
  return {
    generated_at: s.generated_at ?? Math.floor(Date.now() / 1000),
    generation: s.generation ?? 0,
    n_agents: s.n_agents ?? (s.agents?.length ?? 0),
    champion: s.champion ?? null,
    agents: (s.agents as AgentStats[]) ?? [],
    recent_decisions: s.recent_decisions ?? [],
    consensus: s.consensus ?? { fires: 0 },
    source: s.source ?? "backtest",
  };
}

export async function GET() {
  // 1–3. Try writable filesystem candidates.
  for (const p of fsCandidates()) {
    const live = (await readJson(p)) as Partial<Snapshot> | null;
    if (live && Array.isArray(live.agents) && live.agents.length > 0) {
      return NextResponse.json({ ...live, source: live.source ?? "live" });
    }
  }
  // 4. Latest reports/swarm/* (dev-only).
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
  // 5. Compiled-in fallback — always works, even on Vercel.
  return NextResponse.json(compiled());
}
