"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SimEvent } from "@/lib/simulate";

type SignalsResponse = {
  ok: boolean;
  ts: number;
  prices?: { BTC?: number | null; ETH?: number | null };
  events: SimEvent[];
  reason?: string;
  partial?: { btc: string | null; eth: string | null } | null;
};

type Status = "running" | "paused" | "error";

type Props = {
  onFire: (ev: SimEvent) => void;
  onPrices?: (p: { BTC: number | null; ETH: number | null }) => void;
  onStatus?: (running: boolean) => void;
};

// Live-feed cadence presets. Default lands on 10s so visitors see the
// rail pulse within seconds of opening the page. The route's eight
// parallel Kiyotaka fan-out calls per poll (candles+funding+liqs+OI ×
// BTC/ETH) sit at ~10s burst rate, well under Kiyotaka's documented
// 600 req/min cap. Bump up if quotas tighten.
const INTERVALS = [10, 15, 30, 60, 120, 300] as const;
type IntervalSec = (typeof INTERVALS)[number];
const DEFAULT_INTERVAL_SEC: IntervalSec = 10;

export function AutoPilot({ onFire, onPrices, onStatus }: Props) {
  // Live by default — no manual start. The cron is a self-managing
  // setInterval that wakes up every `intervalSec` seconds, calls
  // `/api/signals`, and dispatches new SimEvents downstream. Users can
  // tap Pause if they want to freeze the page (e.g. for a screenshot)
  // but the friction-free path is "open the page → swarm is already
  // working". The schedule UI was confusing visitors and the manual
  // Start button was effectively a "make this page actually do
  // something" prompt — neither is needed once the loop self-arms.
  const [status, setStatus] = useState<Status>("running");
  const [intervalSec, setIntervalSec] = useState<IntervalSec>(DEFAULT_INTERVAL_SEC);
  const [lastPollTs, setLastPollTs] = useState<number | null>(null);
  const [lastSignalTs, setLastSignalTs] = useState<number | null>(null);
  const [eventCount, setEventCount] = useState(0);
  const [pollCount, setPollCount] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const seenRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const errStreakRef = useRef(0);

  // Store the latest callbacks in refs so the polling timer can call them
  // without rebuilding the interval on every prop change. Without this, the
  // parent's `onFire` recreates whenever `marks` updates → poll() recreates
  // → the re-arm effect's cleanup runs, sets timerRef.current to null, and
  // the next effect body sees null and doesn't re-arm. The autopilot would
  // die silently the moment any upstream state moved.
  const onFireRef = useRef(onFire);
  const onPricesRef = useRef(onPrices);
  const onStatusRef = useRef(onStatus);
  useEffect(() => {
    onFireRef.current = onFire;
  }, [onFire]);
  useEffect(() => {
    onPricesRef.current = onPrices;
  }, [onPrices]);
  useEffect(() => {
    onStatusRef.current = onStatus;
  }, [onStatus]);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/signals", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SignalsResponse;
      setPollCount((c) => c + 1);
      setLastPollTs(data.ts);
      if (!data.ok) {
        errStreakRef.current += 1;
        setErr(data.reason ?? "detector error");
        setStatus("error");
        return;
      }
      errStreakRef.current = 0;
      // Partial outage on one asset is degraded but not broken — show
      // the warning, keep running on the asset that is still up.
      if (data.partial) {
        const parts: string[] = [];
        if (data.partial.btc) parts.push(`BTC ${data.partial.btc}`);
        if (data.partial.eth) parts.push(`ETH ${data.partial.eth}`);
        setErr(parts.length ? `partial: ${parts.join(", ")}` : null);
      } else {
        setErr(null);
      }
      setStatus("running");
      if (data.prices && onPricesRef.current) {
        onPricesRef.current({
          BTC: data.prices.BTC ?? null,
          ETH: data.prices.ETH ?? null,
        });
      }
      for (const ev of data.events) {
        if (seenRef.current.has(ev.id)) continue;
        seenRef.current.add(ev.id);
        setEventCount((c) => c + 1);
        setLastSignalTs(ev.ts);
        onFireRef.current(ev);
      }
      // Cap the seen-set so it doesn't grow unbounded across long sessions.
      if (seenRef.current.size > 500) {
        seenRef.current = new Set(Array.from(seenRef.current).slice(-200));
      }
    } catch (e) {
      errStreakRef.current += 1;
      setErr((e as Error).message);
      setStatus("error");
    }
  }, []);

  const armTimer = useCallback(
    (sec: number) => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        void poll();
      }, sec * 1000);
    },
    [poll],
  );

  const start = useCallback(() => {
    if (timerRef.current) return;
    setStatus("running");
    onStatusRef.current?.(true);
    void poll();
    armTimer(intervalSec);
  }, [intervalSec, poll, armTimer]);

  const stop = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setStatus("paused");
    onStatusRef.current?.(false);
  }, []);

  const togglePaused = useCallback(() => {
    if (timerRef.current) stop();
    else start();
  }, [start, stop]);

  // Auto-arm on mount — the live feed runs with zero user interaction.
  // Strict-mode-safe: the cleanup tears down whatever the second mount
  // started. A live page should be a live page.
  useEffect(() => {
    void poll();
    armTimer(intervalSec);
    onStatusRef.current?.(true);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
    // intentionally only on mount — the interval-change effect below
    // re-arms when `intervalSec` updates so we don't double-tick here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-arm interval when the pacing chip changes mid-run. Polls keep
  // flowing, just at the new cadence.
  useEffect(() => {
    if (timerRef.current) {
      armTimer(intervalSec);
    }
  }, [intervalSec, armTimer]);

  const running = status === "running";
  const dotColor =
    status === "running"
      ? "bg-green animate-pulse"
      : status === "error"
        ? "bg-red"
        : "bg-amber";

  const statusLabel =
    status === "running"
      ? `Live · polling every ${fmtInterval(intervalSec)}`
      : status === "error"
        ? `Reconnecting (${errStreakRef.current} fail${errStreakRef.current === 1 ? "" : "s"})`
        : "Paused";

  return (
    <div className="panel p-5 relative overflow-hidden">
      {/* Top-right glow when polling. Doubles as a "this page is live"
          visual cue — visitors see motion without needing to read the
          status text. */}
      {running ? (
        <div
          className="pointer-events-none absolute -top-10 -right-10 w-40 h-40 rounded-full opacity-20 blur-3xl"
          style={{ background: "#22d3ee" }}
        />
      ) : null}

      <div className="flex items-center justify-between mb-3 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
          <div className="text-xs uppercase tracking-[0.3em] text-mist truncate">
            Live feed
          </div>
        </div>
        <span
          className={`text-[0.65rem] num truncate ${
            status === "running"
              ? "text-green"
              : status === "error"
                ? "text-red"
                : "text-amber"
          }`}
        >
          {statusLabel}
        </span>
      </div>

      <p className="text-[0.7rem] text-mist mb-4 leading-relaxed">
        Auto-pulling{" "}
        <span className="font-mono text-cyan">api.kiyotaka.ai</span> for
        BTC + ETH candles + funding. The detector z-scores the latest
        bar, emits a SimEvent when <span className="font-mono">|z| ≥ 2</span>,
        and the swarm reacts on the rail above. Nothing to start —
        polling runs the moment this page loads.
      </p>

      <div className="grid grid-cols-2 gap-2 mb-4 text-[0.7rem] num">
        <Stat label="Polls" value={pollCount.toString()} />
        <Stat label="Events detected" value={eventCount.toString()} />
        <Stat
          label="Last poll"
          value={lastPollTs ? fmtAgo(lastPollTs) : "warming…"}
        />
        <Stat
          label="Last signal"
          value={lastSignalTs ? fmtAgo(lastSignalTs) : "—"}
        />
      </div>

      <div className="flex items-center gap-2 text-[0.7rem]">
        <button
          onClick={togglePaused}
          className={`chip py-1.5 px-3 hover:opacity-90 ${
            running ? "chip-mist" : "chip-cyan"
          }`}
          title={running ? "Pause the live feed (e.g. for a screenshot)" : "Resume live feed"}
        >
          {running ? "Pause" : "Resume"}
        </button>
        <button
          onClick={() => void poll()}
          className="chip chip-mist py-1.5 px-3 hover:opacity-90"
          title="Pull once right now"
        >
          Poll now
        </button>
        <span className="grow" />
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-[0.65rem] text-mist hover:text-slate-100 underline-offset-2 hover:underline"
          aria-expanded={showAdvanced}
        >
          {showAdvanced ? "hide cadence" : "cadence"}
        </button>
      </div>

      {showAdvanced ? (
        <div className="mt-3 pt-3 border-t border-edge/40">
          <div className="text-[0.6rem] uppercase tracking-[0.3em] text-mist mb-2">
            Poll interval
          </div>
          <div className="flex gap-1">
            {INTERVALS.map((i) => (
              <button
                key={i}
                onClick={() => setIntervalSec(i)}
                className={`px-2.5 py-1 text-[0.7rem] font-mono rounded-sm border transition-colors ${
                  intervalSec === i
                    ? "bg-cyan text-ink border-cyan"
                    : "border-edge text-slate-300 hover:bg-edge/60"
                }`}
              >
                {fmtInterval(i)}
              </button>
            ))}
          </div>
          <p className="text-[0.6rem] text-mist mt-2 leading-relaxed">
            10 s is the default — eight parallel Kiyotaka calls per
            poll (candles + funding + liquidations + open interest ×
            BTC/ETH) and the route emits an event the moment any
            detector clears its z-threshold. Quiet markets stay quiet
            on purpose: no synthetic events from the live feed.
          </p>
        </div>
      ) : null}

      {err ? (
        <p className="mt-3 text-[0.7rem] text-red">⚠ {err}</p>
      ) : null}
    </div>
  );
}

function fmtInterval(sec: number): string {
  return sec < 60 ? `${sec}s` : `${sec / 60}m`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-edge/60 bg-black/20 px-2 py-1.5">
      <div className="text-[0.6rem] uppercase tracking-wider text-mist">
        {label}
      </div>
      <div className="mt-0.5 text-sm text-slate-100">{value}</div>
    </div>
  );
}

function fmtAgo(ts: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}
