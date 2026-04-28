"use client";

import { useEffect, useState } from "react";

type Health = {
  ok: boolean;
  status?: number;
  latency_ms?: number;
  sample?: { symbol: string; exchange: string; close: number | null; candle_ts: number | null };
  reason?: string;
  ts: number;
};

export function KiyotakaBadge() {
  const [h, setH] = useState<Health | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/kiyotaka", { cache: "no-store" });
        const d = (await r.json()) as Health;
        if (alive) setH(d);
      } catch {
        // ignore
      }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!h) {
    return (
      <span className="inline-flex items-center gap-2 text-[0.65rem] text-mist">
        <span className="w-1.5 h-1.5 rounded-full bg-mist" />
        Kiyotaka: probing
      </span>
    );
  }
  const dot = h.ok ? "bg-green animate-pulse" : "bg-red";
  // Drop the inline $price — BTC + ETH live in their own chip in
  // the page header so both assets are visible side-by-side.
  const label = h.ok
    ? `Kiyotaka live  ·  ${h.latency_ms}ms`
    : `Kiyotaka: ${h.reason ?? "down"}`;
  return (
    <span
      className="inline-flex items-center gap-2 text-[0.65rem]"
      title={
        h.ok
          ? `GET /v1/points · ${h.sample?.symbol} @ ${h.sample?.exchange} · candle ${h.sample?.candle_ts}`
          : h.reason
      }
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      <span className={h.ok ? "text-green" : "text-red"}>{label}</span>
    </span>
  );
}
