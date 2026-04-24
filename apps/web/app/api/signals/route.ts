import { NextResponse } from "next/server";

// Live event detector. Pulls the last ~48 hourly candles for BTC and ETH from
// Kiyotaka, z-scores the latest log-return and volume against the prior 47,
// and emits synthetic SimEvents when the magnitude crosses a threshold. These
// are what the AutoPilot loop feeds into the swarm so every event the UI
// simulates on is grounded in an actual market move (not made-up numbers).
//
//   TRADE_SIDE_AGNOSTIC_AGG → close / volume
//
// Shape returned matches apps/web/lib/simulate.ts::SimEvent so the same
// reaction + copy-trade simulators run unchanged.
export const dynamic = "force-dynamic";
export const revalidate = 0;

type SimAsset = "BTC" | "ETH";
type SimDir = "long" | "short";
type SimKind = "liq-spike" | "funding-spike" | "vol-breakout";

type SimEvent = {
  id: string;
  ts: number;
  asset: SimAsset;
  kind: SimKind;
  magnitude_z: number;
  direction: SimDir;
};

type Candle = { close: number; volume: number; ts: number };

async function fetchCandles(
  key: string,
  rawSymbol: string,
  hoursBack = 48,
): Promise<Candle[] | null> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - hoursBack * 3600;
  const url = new URL("https://api.kiyotaka.ai/v1/points");
  url.searchParams.set("type", "TRADE_SIDE_AGNOSTIC_AGG");
  url.searchParams.set("exchange", "BINANCE_FUTURES");
  url.searchParams.set("rawSymbol", rawSymbol);
  url.searchParams.set("interval", "HOUR");
  url.searchParams.set("from", String(from));
  url.searchParams.set("period", String(hoursBack * 3600));
  try {
    const res = await fetch(url, {
      headers: { "X-Kiyotaka-Key": key },
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      series?: Array<{
        points?: Array<{
          Point?: {
            close?: number;
            volume?: number;
            timestamp?: { s?: number };
          };
        }>;
      }>;
    };
    const pts = data.series?.[0]?.points ?? [];
    const out: Candle[] = [];
    for (const p of pts) {
      const c = p.Point?.close;
      const v = p.Point?.volume;
      const t = p.Point?.timestamp?.s;
      if (typeof c === "number" && typeof v === "number" && typeof t === "number") {
        out.push({ close: c, volume: v, ts: t });
      }
    }
    return out;
  } catch {
    return null;
  }
}

function zscore(x: number, arr: number[]): number {
  if (arr.length < 4) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const varr =
    arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (arr.length - 1);
  const sd = Math.sqrt(Math.max(varr, 1e-12));
  return (x - mean) / sd;
}

function detectEvents(asset: SimAsset, candles: Candle[], now: number): SimEvent[] {
  if (candles.length < 6) return [];
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const rest = candles.slice(0, -1);

  // log returns against prior-hour close
  const returns: number[] = [];
  for (let i = 1; i < rest.length; i++) {
    const r = Math.log(rest[i].close / rest[i - 1].close);
    returns.push(r);
  }
  const latestRet = Math.log(last.close / prev.close);
  const rz = zscore(latestRet, returns);

  // volume z-score
  const vols = rest.map((c) => c.volume);
  const vz = zscore(last.volume, vols);

  const out: SimEvent[] = [];

  // Big price move with big volume → cascade-shaped event (liquidation proxy).
  // Direction matches the *sign* of the return so the UI shows the sensible
  // "price pushed X" narrative; fade-agents still take the other side.
  if (Math.abs(rz) >= 2.0 && vz >= 1.5) {
    out.push({
      id: `sig-liq-${asset}-${last.ts}`,
      ts: now,
      asset,
      kind: "liq-spike",
      magnitude_z: Math.min(Math.abs(rz), 6),
      direction: rz >= 0 ? "long" : "short",
    });
  }

  // Vol breakout: big move vs prior range, regardless of whether vol is big.
  // Uses 24h high/low as a cheap Donchian proxy.
  const recent = candles.slice(-24);
  const hi = Math.max(...recent.slice(0, -1).map((c) => c.close));
  const lo = Math.min(...recent.slice(0, -1).map((c) => c.close));
  if (last.close > hi && Math.abs(rz) >= 1.0) {
    out.push({
      id: `sig-vbo-${asset}-${last.ts}`,
      ts: now,
      asset,
      kind: "vol-breakout",
      magnitude_z: Math.min(Math.max(Math.abs(rz), 2.0), 6),
      direction: "long",
    });
  } else if (last.close < lo && Math.abs(rz) >= 1.0) {
    out.push({
      id: `sig-vbo-${asset}-${last.ts}`,
      ts: now,
      asset,
      kind: "vol-breakout",
      magnitude_z: Math.min(Math.max(Math.abs(rz), 2.0), 6),
      direction: "short",
    });
  }

  return out;
}

export async function GET() {
  const key = process.env.KIYOTAKA_API_KEY;
  const now = Math.floor(Date.now() / 1000);
  if (!key) {
    return NextResponse.json({
      ok: false,
      reason: "KIYOTAKA_API_KEY not set",
      ts: now,
      events: [],
      prices: {},
    });
  }

  const [btc, eth] = await Promise.all([
    fetchCandles(key, "BTCUSDT"),
    fetchCandles(key, "ETHUSDT"),
  ]);

  const events: SimEvent[] = [];
  const prices: Record<string, number | null> = {
    BTC: btc?.[btc.length - 1]?.close ?? null,
    ETH: eth?.[eth.length - 1]?.close ?? null,
  };

  if (btc) events.push(...detectEvents("BTC", btc, now));
  if (eth) events.push(...detectEvents("ETH", eth, now));

  return NextResponse.json({
    ok: true,
    ts: now,
    prices,
    events,
    source: "kiyotaka:TRADE_SIDE_AGNOSTIC_AGG",
  });
}
