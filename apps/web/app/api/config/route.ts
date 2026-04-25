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
  equity_usd: number; // 100 .. 1_000_000 — sizing base for the paper ledger
  mode: "paper" | "live"; // paper = simulated; live = preview only (no real signing yet)
  wallet_address: string; // EVM address for the live preview only — never used to sign
  // Portfolio meta-agent rules — exit / aggregation / size guardrails
  // applied on top of the router's per-event decisions.
  max_open_positions: number;       // 1..32 — global cap on simultaneously open paper positions
  min_conviction: number;           // 0..1  — refuse new entries below this ensemble conviction
  time_stop_hours: number;          // 0..168 — force-exit positions older than this (0 disables)
  trail_after_r: number;            // 0..5  — ratchet stop to breakeven once unrealized R crosses this
  swarm_flip_conviction: number;    // 0..1  — close a position when fresh ensemble votes opposite at ≥ this
  updated_at: number;
};

const DEFAULT_CONFIG: SwarmConfig = {
  risk_fraction: 0.005,
  position_cap_mult: 3,
  kelly_enabled: false,
  uncertainty_filter: 0.4,
  equity_usd: 1000,
  mode: "paper",
  wallet_address: "",
  max_open_positions: 8,
  min_conviction: 0.30,
  time_stop_hours: 12,
  trail_after_r: 1.0,
  swarm_flip_conviction: 0.40,
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

// EIP-55 / EVM addresses are 42 chars (0x + 40 hex). We don't validate the
// checksum — this is preview-only — but we do reject anything that's not
// vaguely shaped like one to avoid persisting junk.
const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

function sanitize(raw: Partial<SwarmConfig>): SwarmConfig {
  const wallet = String(raw.wallet_address ?? "").trim();
  return {
    risk_fraction: clamp(Number(raw.risk_fraction ?? DEFAULT_CONFIG.risk_fraction), 0.001, 0.02),
    position_cap_mult: clamp(Number(raw.position_cap_mult ?? DEFAULT_CONFIG.position_cap_mult), 1, 10),
    kelly_enabled: Boolean(raw.kelly_enabled ?? DEFAULT_CONFIG.kelly_enabled),
    uncertainty_filter: clamp(
      Number(raw.uncertainty_filter ?? DEFAULT_CONFIG.uncertainty_filter),
      0,
      1,
    ),
    equity_usd: clamp(Number(raw.equity_usd ?? DEFAULT_CONFIG.equity_usd), 100, 1_000_000),
    mode: raw.mode === "live" ? "live" : "paper",
    wallet_address: wallet.length === 0 ? "" : EVM_ADDR_RE.test(wallet) ? wallet : "",
    max_open_positions: Math.round(
      clamp(Number(raw.max_open_positions ?? DEFAULT_CONFIG.max_open_positions), 1, 32),
    ),
    min_conviction: clamp(
      Number(raw.min_conviction ?? DEFAULT_CONFIG.min_conviction),
      0,
      1,
    ),
    time_stop_hours: clamp(
      Number(raw.time_stop_hours ?? DEFAULT_CONFIG.time_stop_hours),
      0,
      168,
    ),
    trail_after_r: clamp(
      Number(raw.trail_after_r ?? DEFAULT_CONFIG.trail_after_r),
      0,
      5,
    ),
    swarm_flip_conviction: clamp(
      Number(raw.swarm_flip_conviction ?? DEFAULT_CONFIG.swarm_flip_conviction),
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
