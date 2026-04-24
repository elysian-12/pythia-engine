import { NextResponse } from "next/server";

// Live health probe against api.kiyotaka.ai. Fetches the most recent BTC
// candle so the UI can confirm the data source is actually responding
// with real market numbers, not a stub. Key is read from
// KIYOTAKA_API_KEY env var (set in Vercel dashboard for prod).
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const key = process.env.KIYOTAKA_API_KEY;
  if (!key) {
    return NextResponse.json(
      {
        ok: false,
        reason: "KIYOTAKA_API_KEY not set in environment",
        ts: Math.floor(Date.now() / 1000),
      },
      { status: 200 },
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const from = now - 2 * 3600;
  const url = new URL("https://api.kiyotaka.ai/v1/points");
  url.searchParams.set("type", "TRADE_SIDE_AGNOSTIC_AGG");
  url.searchParams.set("exchange", "BINANCE_FUTURES");
  url.searchParams.set("rawSymbol", "BTCUSDT");
  url.searchParams.set("interval", "HOUR");
  url.searchParams.set("from", String(from));
  url.searchParams.set("period", "7200");

  const started = performance.now();
  try {
    const res = await fetch(url, {
      headers: { "X-Kiyotaka-Key": key },
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    const latency_ms = Math.round(performance.now() - started);
    const status = res.status;
    if (!res.ok) {
      return NextResponse.json({
        ok: false,
        status,
        latency_ms,
        reason: `HTTP ${status}`,
        ts: now,
      });
    }
    const data = (await res.json()) as {
      series?: Array<{
        id?: { rawSymbol?: string; exchange?: string };
        points?: Array<{ Point?: { close?: number; volume?: number; timestamp?: { s?: number } } }>;
      }>;
    };
    const series = data.series?.[0];
    const last = series?.points?.[series.points.length - 1]?.Point;
    return NextResponse.json({
      ok: true,
      status,
      latency_ms,
      ts: now,
      sample: {
        symbol: series?.id?.rawSymbol ?? "BTCUSDT",
        exchange: series?.id?.exchange ?? "BINANCE_FUTURES",
        close: last?.close ?? null,
        volume: last?.volume ?? null,
        candle_ts: last?.timestamp?.s ?? null,
      },
      source: "api.kiyotaka.ai/v1/points",
    });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      reason: (e as Error).message,
      latency_ms: Math.round(performance.now() - started),
      ts: now,
    });
  }
}
