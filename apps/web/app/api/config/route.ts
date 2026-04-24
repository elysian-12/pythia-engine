import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export type SwarmConfig = {
  risk_fraction: number; // 0.001 .. 0.02 — % equity risked per trade
  position_cap_mult: number; // 1..10 — max position notional as multiple of equity
  kelly_enabled: boolean; // use quarter-Kelly for sizing (from PolySwarm paper)
  uncertainty_filter: number; // 0..1 — skip if top-K disagreement exceeds this
  updated_at: number;
};

const DEFAULT_CONFIG: SwarmConfig = {
  risk_fraction: 0.005,
  position_cap_mult: 3,
  kelly_enabled: false,
  uncertainty_filter: 0.4,
  updated_at: Math.floor(Date.now() / 1000),
};

function configPath(): string {
  const env = process.env.PYTHIA_CONFIG;
  if (env) return env;
  return path.resolve(process.cwd(), "..", "..", "data", "swarm-config.json");
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function sanitize(raw: Partial<SwarmConfig>): SwarmConfig {
  return {
    risk_fraction: clamp(Number(raw.risk_fraction ?? DEFAULT_CONFIG.risk_fraction), 0.001, 0.02),
    position_cap_mult: clamp(Number(raw.position_cap_mult ?? DEFAULT_CONFIG.position_cap_mult), 1, 10),
    kelly_enabled: Boolean(raw.kelly_enabled ?? DEFAULT_CONFIG.kelly_enabled),
    uncertainty_filter: clamp(
      Number(raw.uncertainty_filter ?? DEFAULT_CONFIG.uncertainty_filter),
      0,
      1,
    ),
    updated_at: Math.floor(Date.now() / 1000),
  };
}

export async function GET() {
  try {
    const raw = await fs.readFile(configPath(), "utf8");
    const cfg = JSON.parse(raw) as Partial<SwarmConfig>;
    return NextResponse.json(sanitize(cfg));
  } catch {
    return NextResponse.json(DEFAULT_CONFIG);
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Partial<SwarmConfig>;
  const next = sanitize(body);
  const p = configPath();
  try {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(next, null, 2));
    return NextResponse.json({ ...next, persisted: true });
  } catch (e) {
    // Vercel read-only FS — still reply with the sanitized config so
    // the browser can store it in localStorage.
    return NextResponse.json({
      ...next,
      persisted: false,
      warning: (e as Error).message,
    });
  }
}
