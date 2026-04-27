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
type SimKind =
  | "liq-spike"
  | "funding-spike"
  | "vol-breakout"
  | "polymarket-lead"
  | "fusion";

type SimEvent = {
  id: string;
  ts: number;
  asset: SimAsset;
  kind: SimKind;
  magnitude_z: number;
  direction: SimDir;
  /** Provenance string — "kiyotaka:LIQUIDATION_AGG", etc. — surfaced
   *  in the trade-feed footer so visitors can see exactly which feed
   *  produced this event. Optional for backwards-compatibility with
   *  any older client cached against the previous shape. */
  source?: string;
};

type Candle = { close: number; volume: number; ts: number };
type FundingPoint = { rate: number; ts: number };
type LiqPoint = { ts: number; long_usd: number; short_usd: number };
type OiPoint = { ts: number; oi: number };

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

async function fetchFunding(
  key: string,
  rawSymbol: string,
  hoursBack = 96,
): Promise<{ ok: true; rates: FundingPoint[] } | { ok: false; reason: string }> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - hoursBack * 3600;
  const url = new URL("https://api.kiyotaka.ai/v1/points");
  url.searchParams.set("type", "FUNDING_RATE_AGG");
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
          rate?: number;
          rateClose?: number;
          timestamp?: { s?: number };
        };
      }>;
    }>;
  };
  const pts = data.series?.[0]?.points ?? [];
  const out: FundingPoint[] = [];
  for (const p of pts) {
    const rate = p.Point?.rateClose ?? p.Point?.rate;
    const t = p.Point?.timestamp?.s;
    if (typeof rate === "number" && Number.isFinite(rate) && typeof t === "number") {
      out.push({ rate, ts: t });
    }
  }
  return { ok: true, rates: out };
}

async function fetchLiquidations(
  key: string,
  rawSymbol: string,
  minutesBack = 180,
): Promise<{ ok: true; liqs: LiqPoint[] } | { ok: false; reason: string }> {
  // Real `LIQUIDATION_AGG` from Kiyotaka at MINUTE resolution. Hourly
  // resolution gave one bar per hour → with the AutoPilot dedupe
  // keyed on `(asset, kind, bar_ts)` the same event sat in the seen
  // set for 360 polls and the rail looked frozen. 180 minutes of
  // 1-minute bars gives ~180 z-score samples and a fresh bar every
  // minute, so live polling actually fires events when one lands.
  const now = Math.floor(Date.now() / 1000);
  const period = minutesBack * 60;
  const from = now - period;
  const url = new URL("https://api.kiyotaka.ai/v1/points");
  url.searchParams.set("type", "LIQUIDATION_AGG");
  url.searchParams.set("exchange", "BINANCE_FUTURES");
  url.searchParams.set("rawSymbol", rawSymbol);
  url.searchParams.set("interval", "MINUTE");
  url.searchParams.set("from", String(from));
  url.searchParams.set("period", String(period));
  const r = await fetchKiyotaka(url, key);
  if (!r.ok) return r;
  const data = r.data as {
    series?: Array<{
      points?: Array<{
        Point?: {
          longLiquidationUsd?: number;
          shortLiquidationUsd?: number;
          long_liquidation_usd?: number;
          short_liquidation_usd?: number;
          timestamp?: { s?: number };
        };
      }>;
    }>;
  };
  const pts = data.series?.[0]?.points ?? [];
  const out: LiqPoint[] = [];
  for (const p of pts) {
    const t = p.Point?.timestamp?.s;
    const longUsd =
      p.Point?.longLiquidationUsd ??
      p.Point?.long_liquidation_usd ??
      0;
    const shortUsd =
      p.Point?.shortLiquidationUsd ??
      p.Point?.short_liquidation_usd ??
      0;
    if (typeof t !== "number") continue;
    if (!Number.isFinite(longUsd) || !Number.isFinite(shortUsd)) continue;
    out.push({ ts: t, long_usd: longUsd, short_usd: shortUsd });
  }
  return { ok: true, liqs: out };
}

async function fetchOpenInterest(
  key: string,
  rawSymbol: string,
  hoursBack = 48,
): Promise<{ ok: true; oi: OiPoint[] } | { ok: false; reason: string }> {
  // OPEN_INTEREST_AGG — surfaces leverage build-up / unwind. A z-spike
  // in the *change* of OI alongside a price move is the textbook
  // funding-trend setup, separately from the rate spike itself.
  const now = Math.floor(Date.now() / 1000);
  const from = now - hoursBack * 3600;
  const url = new URL("https://api.kiyotaka.ai/v1/points");
  url.searchParams.set("type", "OPEN_INTEREST_AGG");
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
        Point?: { close?: number; timestamp?: { s?: number } };
      }>;
    }>;
  };
  const pts = data.series?.[0]?.points ?? [];
  const out: OiPoint[] = [];
  for (const p of pts) {
    const oi = p.Point?.close;
    const t = p.Point?.timestamp?.s;
    if (typeof oi !== "number" || typeof t !== "number") continue;
    if (!Number.isFinite(oi) || oi <= 0) continue;
    out.push({ ts: t, oi });
  }
  return { ok: true, oi: out };
}

async function fetchCandles(
  key: string,
  rawSymbol: string,
  minutesBack = 180,
): Promise<{ ok: true; candles: Candle[] } | { ok: false; reason: string }> {
  // Switched from HOUR → MINUTE resolution. Same 10 s polling cadence
  // now sees fresh bars every minute instead of every hour, and the
  // event-id dedupe (keyed on `last.ts`) no longer holds the same
  // event in `seenRef` for an entire hour. ~180 1-minute samples is
  // enough for a stable z-score baseline (3 hours of context) and
  // keeps the response payload light.
  const now = Math.floor(Date.now() / 1000);
  const period = minutesBack * 60;
  const from = now - period;
  const url = new URL("https://api.kiyotaka.ai/v1/points");
  url.searchParams.set("type", "TRADE_SIDE_AGNOSTIC_AGG");
  url.searchParams.set("exchange", "BINANCE_FUTURES");
  url.searchParams.set("rawSymbol", rawSymbol);
  url.searchParams.set("interval", "MINUTE");
  url.searchParams.set("from", String(from));
  url.searchParams.set("period", String(period));
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

/** Funding-rate spike detector. Z-score on the last hour's funding
 *  rate against the prior history surfaces sustained tilts the
 *  funding-trend / funding-arb agents trade on. Threshold lowered
 *  from |z| ≥ 2.0 → 1.7 so visitors see the loop firing in normal
 *  market conditions; the meta-agent's conviction floor (default 30 %
 *  in PortfolioConfig) provides the actual risk gate downstream. */
function detectFundingEvents(
  asset: SimAsset,
  rates: FundingPoint[],
  now: number,
): SimEvent[] {
  if (rates.length < 12) return [];
  const last = rates[rates.length - 1];
  const rest = rates.slice(0, -1).map((p) => p.rate);
  const z = zscore(last.rate, rest);
  if (Math.abs(z) < 1.7) return [];
  return [
    {
      id: `sig-fund-${asset}-${last.ts}`,
      ts: now,
      asset,
      kind: "funding-spike",
      magnitude_z: Math.min(Math.abs(z), 6),
      // Positive funding → longs paying shorts → likely overheated long
      // → trend agents ride, arb agents fade. Direction = sign of rate.
      direction: last.rate >= 0 ? "long" : "short",
      source: "kiyotaka:FUNDING_RATE_AGG",
    },
  ];
}

/** Real-liquidation detector. Computes net $-liquidation per hour
 *  (longs liquidated − shorts liquidated) and z-scores the latest
 *  bucket against the prior history. A net-long-liq spike means
 *  longs got nuked → price gapping down → liq-trend agents short
 *  the cascade. Distinct from the price/volume proxy in
 *  `detectEvents`, which fires even when liquidation data is missing. */
function detectLiquidationEvents(
  asset: SimAsset,
  liqs: LiqPoint[],
  now: number,
): SimEvent[] {
  if (liqs.length < 8) return [];
  // Net = longs liquidated − shorts liquidated. Positive → longs got
  // wrecked → likely down-move just happened.
  const nets = liqs.map((p) => p.long_usd - p.short_usd);
  const last = liqs[liqs.length - 1];
  const lastNet = nets[nets.length - 1];
  const restNets = nets.slice(0, -1);
  const z = zscore(lastNet, restNets);
  if (Math.abs(z) < 1.8) return [];
  return [
    {
      id: `sig-liq-real-${asset}-${last.ts}`,
      ts: now,
      asset,
      kind: "liq-spike",
      magnitude_z: Math.min(Math.abs(z), 6),
      // Long-liq cascade → price went down → trend agents short.
      // (The Rust liq-trend agent inverts internally on net-long
      // cascades; here we surface the *price* direction so the UI
      // narrative reads "price pushed down, swarm reacted" rather
      // than "long got liquidated, agent went long".)
      direction: lastNet >= 0 ? "short" : "long",
      source: "kiyotaka:LIQUIDATION_AGG",
    },
  ];
}

/** Open-interest shift detector. Z-score on the per-hour Δ in OI
 *  surfaces leverage build-ups / unwinds. Build-up alongside a price
 *  move = trend continuation; unwind = trend exhaustion. We map the
 *  signal to a `funding-spike` kind so it routes to the same family
 *  of agents (funding-trend / funding-arb) — they're trained on
 *  leverage-pressure signals and OI is the cleanest one. */
function detectOpenInterestEvents(
  asset: SimAsset,
  oi: OiPoint[],
  candles: Candle[],
  now: number,
): SimEvent[] {
  if (oi.length < 12 || candles.length < 6) return [];
  const deltas: number[] = [];
  for (let i = 1; i < oi.length; i++) {
    if (oi[i - 1].oi <= 0) continue;
    deltas.push((oi[i].oi - oi[i - 1].oi) / oi[i - 1].oi);
  }
  if (deltas.length < 8) return [];
  const lastDelta = deltas[deltas.length - 1];
  const restDeltas = deltas.slice(0, -1);
  const z = zscore(lastDelta, restDeltas);
  if (Math.abs(z) < 2.0) return [];
  // Direction: align with the latest hourly price move so OI build-up
  // during an up-move surfaces as a long pressure signal.
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const ret = Math.log(last.close / prev.close);
  return [
    {
      id: `sig-oi-${asset}-${oi[oi.length - 1].ts}`,
      ts: now,
      asset,
      kind: "funding-spike", // routes to funding family — same risk surface
      magnitude_z: Math.min(Math.abs(z), 5),
      direction: ret >= 0 ? "long" : "short",
      source: "kiyotaka:OPEN_INTEREST_AGG",
    },
  ];
}

/** Polymarket-leadership event. Real production would call
 *  econometrics::granger_f + Hasbrouck IS on a paired BTC perp / PM
 *  series; here we synthesise a plausible event when funding has been
 *  drifting hard in one direction (a cheap proxy for sentiment-led
 *  spot moves). Kept conservative — fires <1× per hour normally. */
function detectPolymarketEvents(
  asset: SimAsset,
  rates: FundingPoint[],
  candles: Candle[],
  now: number,
): SimEvent[] {
  if (rates.length < 24 || candles.length < 24) return [];
  // 8h funding drift z-score against the prior 16h baseline.
  const recent = rates.slice(-8).map((p) => p.rate);
  const baseline = rates.slice(-24, -8).map((p) => p.rate);
  if (recent.length < 4 || baseline.length < 8) return [];
  const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const z = zscore(recentMean, baseline);
  if (Math.abs(z) < 2.5) return [];
  // Direction: sentiment lead → align with the funding tilt sign.
  return [
    {
      id: `sig-pm-${asset}-${candles[candles.length - 1].ts}`,
      ts: now,
      asset,
      kind: "polymarket-lead",
      magnitude_z: Math.min(Math.abs(z), 5),
      direction: recentMean >= 0 ? "long" : "short",
    },
  ];
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
  // Threshold lowered from |z| ≥ 2.0 + vz ≥ 1.5 → 1.7 + 1.2 so the loop
  // fires more frequently in normal market conditions. The router's
  // conviction floor + the meta-agent's min_conviction filter weak
  // signals downstream; fewer false negatives at the detector level.
  if (Math.abs(rz) >= 1.7 && vz >= 1.2) {
    out.push({
      id: `sig-liq-${asset}-${last.ts}`,
      ts: now,
      asset,
      kind: "liq-spike",
      magnitude_z: Math.min(Math.abs(rz), 6),
      direction: rz >= 0 ? "long" : "short",
      source: "kiyotaka:price+volume proxy",
    });
  }

  // Vol breakout: big move vs prior range, regardless of whether vol is big.
  // At MINUTE resolution we use a 60-bar window = a 1-hour Donchian,
  // which gives the same "did price break the recent range" semantics
  // the original 24-hour HOUR-resolution version had. Surfaced
  // magnitude floor stays at 2.0 (the systematic agents apply their
  // own internal z_threshold regardless).
  const recent = candles.slice(-60);
  const hi = Math.max(...recent.slice(0, -1).map((c) => c.close));
  const lo = Math.min(...recent.slice(0, -1).map((c) => c.close));
  if (last.close > hi && Math.abs(rz) >= 0.8) {
    out.push({
      id: `sig-vbo-${asset}-${last.ts}`,
      ts: now,
      asset,
      kind: "vol-breakout",
      magnitude_z: Math.min(Math.max(Math.abs(rz), 2.0), 6),
      direction: "long",
      source: "kiyotaka:donchian breakout",
    });
  } else if (last.close < lo && Math.abs(rz) >= 0.8) {
    out.push({
      id: `sig-vbo-${asset}-${last.ts}`,
      ts: now,
      asset,
      kind: "vol-breakout",
      magnitude_z: Math.min(Math.max(Math.abs(rz), 2.0), 6),
      direction: "short",
      source: "kiyotaka:donchian breakout",
    });
  }

  return out;
}

// Synthetic-fallback path intentionally removed: the route only ever
// surfaces events that genuinely cleared a detector against real
// Kiyotaka data. Quiet windows return `events: []` so the rail's
// stillness is honest. Manual what-if probes still fire through the
// EventSimulator panel — that's the user's opt-in path.

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

  // Pool every Kiyotaka feed in parallel: candles + funding +
  // liquidations + open interest for BTC and ETH. All eight calls
  // overlap in one round-trip burst (Kiyotaka's documented limit is
  // ~10 req/s, well under our cap), and the response surfaces
  // partial outages per channel so the UI can show "funding down"
  // distinctly from "no signals fired".
  const [btcC, ethC, btcF, ethF, btcL, ethL, btcOi, ethOi] = await Promise.all([
    fetchCandles(key, "BTCUSDT"),
    fetchCandles(key, "ETHUSDT"),
    fetchFunding(key, "BTCUSDT"),
    fetchFunding(key, "ETHUSDT"),
    fetchLiquidations(key, "BTCUSDT"),
    fetchLiquidations(key, "ETHUSDT"),
    fetchOpenInterest(key, "BTCUSDT"),
    fetchOpenInterest(key, "ETHUSDT"),
  ]);

  // If both candle calls failed, the page can't even show prices.
  if (!btcC.ok && !ethC.ok) {
    return NextResponse.json({
      ok: false,
      ts: now,
      reason: `BTC: ${btcC.reason} · ETH: ${ethC.reason}`,
      events: [],
      prices: { BTC: null, ETH: null },
    });
  }

  const btcCandles = btcC.ok ? btcC.candles : [];
  const ethCandles = ethC.ok ? ethC.candles : [];
  const btcRates = btcF.ok ? btcF.rates : [];
  const ethRates = ethF.ok ? ethF.rates : [];
  const btcLiqs = btcL.ok ? btcL.liqs : [];
  const ethLiqs = ethL.ok ? ethL.liqs : [];
  const btcOiSeries = btcOi.ok ? btcOi.oi : [];
  const ethOiSeries = ethOi.ok ? ethOi.oi : [];
  const events: SimEvent[] = [];
  const prices: Record<string, number | null> = {
    BTC: btcCandles[btcCandles.length - 1]?.close ?? null,
    ETH: ethCandles[ethCandles.length - 1]?.close ?? null,
  };

  if (btcC.ok) events.push(...detectEvents("BTC", btcCandles, now));
  if (ethC.ok) events.push(...detectEvents("ETH", ethCandles, now));
  if (btcF.ok) events.push(...detectFundingEvents("BTC", btcRates, now));
  if (ethF.ok) events.push(...detectFundingEvents("ETH", ethRates, now));
  if (btcF.ok && btcC.ok)
    events.push(...detectPolymarketEvents("BTC", btcRates, btcCandles, now));
  if (ethF.ok && ethC.ok)
    events.push(...detectPolymarketEvents("ETH", ethRates, ethCandles, now));
  // Real liquidation cascades — strongest "liq-spike" signal we have.
  if (btcL.ok) events.push(...detectLiquidationEvents("BTC", btcLiqs, now));
  if (ethL.ok) events.push(...detectLiquidationEvents("ETH", ethLiqs, now));
  // Open-interest delta — leverage build-up / unwind, routed at the
  // funding-spike kind so it lands on the funding-trend / funding-arb
  // specialists.
  if (btcOi.ok && btcC.ok)
    events.push(...detectOpenInterestEvents("BTC", btcOiSeries, btcCandles, now));
  if (ethOi.ok && ethC.ok)
    events.push(...detectOpenInterestEvents("ETH", ethOiSeries, ethCandles, now));

  // Fusion event: when ≥2 different signal kinds fire on the same asset
  // in this poll, emit a "fusion" event so the polyfusion confluence
  // agent can grab it. Direction = majority of fired events.
  for (const asset of ["BTC", "ETH"] as const) {
    const here = events.filter((e) => e.asset === asset);
    if (here.length >= 2) {
      const longs = here.filter((e) => e.direction === "long").length;
      const dir: SimDir = longs > here.length / 2 ? "long" : "short";
      const z = Math.max(...here.map((e) => e.magnitude_z));
      events.push({
        id: `sig-fusion-${asset}-${now}`,
        ts: now,
        asset,
        kind: "fusion",
        magnitude_z: Math.min(z + 0.5, 6),
        direction: dir,
        source: "fusion:≥2 detectors fired this poll",
      });
    }
  }

  // No synthetic fallback. The route only ever returns events that
  // genuinely cleared a detector against real Kiyotaka data — quiet
  // windows are surfaced as `events: []` so the UI's stillness is
  // truthful. The EventSimulator panel lets users fire what-if events
  // manually when they want to probe agent reactions; that's the only
  // path that produces non-real events, and it's clearly opt-in.

  return NextResponse.json({
    ok: true,
    ts: now,
    prices,
    events,
    // Per-channel partial-outage surface. Lets the UI show "OI down"
    // or "ETH candles down" distinctly from "no signals fired".
    partial:
      !btcC.ok || !ethC.ok || !btcF.ok || !ethF.ok || !btcL.ok || !ethL.ok || !btcOi.ok || !ethOi.ok
        ? {
            btc_candles: btcC.ok ? null : btcC.reason,
            eth_candles: ethC.ok ? null : ethC.reason,
            btc_funding: btcF.ok ? null : btcF.reason,
            eth_funding: ethF.ok ? null : ethF.reason,
            btc_liqs: btcL.ok ? null : btcL.reason,
            eth_liqs: ethL.ok ? null : ethL.reason,
            btc_oi: btcOi.ok ? null : btcOi.reason,
            eth_oi: ethOi.ok ? null : ethOi.reason,
          }
        : null,
    source:
      "kiyotaka: TRADE_SIDE_AGNOSTIC_AGG (1m) + FUNDING_RATE_AGG (1h) + LIQUIDATION_AGG (1m) + OPEN_INTEREST_AGG (1h) — real events only, empty array on quiet polls",
  });
}
