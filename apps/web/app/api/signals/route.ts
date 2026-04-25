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

/** GET wrapper with retry on transient errors (429 + 5xx + abort) and a
 *  short fixed-jitter backoff. Kiyotaka's documented rate limit is ~10
 *  req/sec / 600 req/min, but transient 503s do happen — surface them as
 *  clear failures instead of silently degrading to "no signal". */
async function fetchKiyotaka(
  url: URL,
  key: string,
  attempts = 3,
): Promise<{ ok: true; data: unknown } | { ok: false; reason: string }> {
  let lastReason = "no attempts";
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { "X-Kiyotaka-Key": key, "User-Agent": "pythia-web" },
        cache: "no-store",
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        return { ok: true, data: await res.json() };
      }
      // 4xx (other than 429) — bad request, no point retrying.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        return { ok: false, reason: `HTTP ${res.status}` };
      }
      lastReason = `HTTP ${res.status}`;
    } catch (e) {
      lastReason = (e as Error).message;
    }
    // Exponential backoff with jitter: 200ms, 600ms, 1.4s.
    if (i < attempts - 1) {
      const backoff = 200 * Math.pow(3, i) + Math.random() * 100;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  return { ok: false, reason: lastReason };
}

async function fetchCandles(
  key: string,
  rawSymbol: string,
  hoursBack = 48,
): Promise<{ ok: true; candles: Candle[] } | { ok: false; reason: string }> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - hoursBack * 3600;
  const url = new URL("https://api.kiyotaka.ai/v1/points");
  url.searchParams.set("type", "TRADE_SIDE_AGNOSTIC_AGG");
  url.searchParams.set("exchange", "BINANCE_FUTURES");
  url.searchParams.set("rawSymbol", rawSymbol);
  url.searchParams.set("interval", "HOUR");
  url.searchParams.set("from", String(from));
  url.searchParams.set("period", String(hoursBack * 3600));
  const r = await fetchKiyotaka(url, key);
  if (!r.ok) return r;
  const data = r.data as {
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
    // Drop empty / unfilled candles — they break log returns and pull
    // the z-score baseline toward 0, masking real signals.
    if (
      typeof c === "number" &&
      typeof v === "number" &&
      typeof t === "number" &&
      Number.isFinite(c) &&
      c > 0 &&
      v >= 0
    ) {
      out.push({ close: c, volume: v, ts: t });
    }
  }
  return { ok: true, candles: out };
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

  // If both upstream calls failed, return a clear error so the autopilot
  // surfaces it rather than silently looking idle.
  if (!btc.ok && !eth.ok) {
    return NextResponse.json({
      ok: false,
      ts: now,
      reason: `BTC: ${btc.reason} · ETH: ${eth.reason}`,
      events: [],
      prices: { BTC: null, ETH: null },
    });
  }

  const btcCandles = btc.ok ? btc.candles : [];
  const ethCandles = eth.ok ? eth.candles : [];
  const events: SimEvent[] = [];
  const prices: Record<string, number | null> = {
    BTC: btcCandles[btcCandles.length - 1]?.close ?? null,
    ETH: ethCandles[ethCandles.length - 1]?.close ?? null,
  };

  if (btc.ok) events.push(...detectEvents("BTC", btcCandles, now));
  if (eth.ok) events.push(...detectEvents("ETH", ethCandles, now));

  return NextResponse.json({
    ok: true,
    ts: now,
    prices,
    events,
    // Surface a per-asset partial-failure note so the UI can show "ETH down"
    // distinct from "no signals". Empty when both succeeded.
    partial:
      !btc.ok || !eth.ok
        ? { btc: btc.ok ? null : btc.reason, eth: eth.ok ? null : eth.reason }
        : null,
    source: "kiyotaka:TRADE_SIDE_AGNOSTIC_AGG",
  });
}
