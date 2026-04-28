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

type Props = {
  /** Live feed status from AutoPilot. When the feed is failing the
   *  badge degrades to amber even if the once-a-minute /api/kiyotaka
   *  probe is still green — otherwise the header shows "live" while
   *  the page-level live feed shows "Reconnecting", which is the
   *  exact contradiction visitors flagged. */
  feedStatus?: "running" | "paused" | "error" | null;
  feedFailStreak?: number;
  feedError?: string | null;
};

export function KiyotakaBadge({
  feedStatus,
  feedFailStreak = 0,
  feedError,
}: Props = {}) {
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

  // Reconcile the once-a-minute probe with the live feed's poll cadence.
  // If the feed is in error state we surface "degraded" rather than the
  // probe's stale "live" — the feed is the better real-time signal.
  const probeOk = h.ok;
  const feedOk = feedStatus !== "error";
  const live = probeOk && feedOk;
  const degraded = probeOk && !feedOk;

  let dot: string;
  let textColor: string;
  let label: string;
  let title: string | undefined;

  if (live) {
    dot = "bg-green animate-pulse";
    textColor = "text-green";
    label = `Kiyotaka live  ·  ${h.latency_ms}ms`;
    title = `GET /v1/points · ${h.sample?.symbol} @ ${h.sample?.exchange} · candle ${h.sample?.candle_ts}`;
  } else if (degraded) {
    dot = "bg-amber animate-pulse";
    textColor = "text-amber";
    const streak = feedFailStreak > 0 ? ` (${feedFailStreak} fail${feedFailStreak === 1 ? "" : "s"})` : "";
    label = `Kiyotaka degraded${streak}`;
    title = `Live feed failing: ${feedError ?? "unknown"} — probe still OK`;
  } else {
    dot = "bg-red";
    textColor = "text-red";
    label = `Kiyotaka: ${h.reason ?? "down"}`;
    title = h.reason;
  }

  return (
    <span className="inline-flex items-center gap-2 text-[0.65rem]" title={title}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      <span className={textColor}>{label}</span>
    </span>
  );
}
