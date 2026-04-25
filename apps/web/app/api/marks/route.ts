import { NextResponse } from "next/server";

// Lightweight mark-price endpoint for the paper HL panel. Single Kiyotaka
// request returning the latest BTC + ETH close without the full 48h series
// the /api/signals route fetches. Polled every ~6s by the positions panel
// to keep unrealized PnL + stop/TP triggers current.
export const dynamic = "force-dynamic";
export const revalidate = 0;

async function lastClose(key: string, rawSymbol: string): Promise<number | null> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 2 * 3600;
  const url = new URL("https://api.kiyotaka.ai/v1/points");
  url.searchParams.set("type", "TRADE_SIDE_AGNOSTIC_AGG");
  url.searchParams.set("exchange", "BINANCE_FUTURES");
  url.searchParams.set("rawSymbol", rawSymbol);
  url.searchParams.set("interval", "HOUR");
  url.searchParams.set("from", String(from));
  url.searchParams.set("period", "7200");
  try {
    const res = await fetch(url, {
      headers: { "X-Kiyotaka-Key": key },
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      series?: Array<{ points?: Array<{ Point?: { close?: number } }> }>;
    };
    const pts = data.series?.[0]?.points ?? [];
    const last = pts[pts.length - 1]?.Point?.close;
    // Treat 0 / negative / non-finite as missing — empty in-progress hours
    // can return 0, and sizing math (notional = risk * px / stop) divides
    // by stop_dist which is proportional to price; a zero would NaN out.
    return typeof last === "number" && Number.isFinite(last) && last > 0
      ? last
      : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const key = process.env.KIYOTAKA_API_KEY;
  const ts = Math.floor(Date.now() / 1000);
  if (!key) {
    return NextResponse.json({ ok: false, ts, marks: { BTC: null, ETH: null } });
  }
  const [btc, eth] = await Promise.all([
    lastClose(key, "BTCUSDT"),
    lastClose(key, "ETHUSDT"),
  ]);
  return NextResponse.json({
    ok: btc != null && eth != null,
    ts,
    marks: { BTC: btc, ETH: eth },
  });
}
