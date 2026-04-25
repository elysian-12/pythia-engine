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

type Status = "idle" | "running" | "error";

type Props = {
  onFire: (ev: SimEvent) => void;
  onPrices?: (p: { BTC: number | null; ETH: number | null }) => void;
  onStatus?: (running: boolean) => void;
};

const INTERVALS = [15, 30, 60, 120, 300] as const;
type IntervalSec = (typeof INTERVALS)[number];

export function AutoPilot({ onFire, onPrices, onStatus }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [intervalSec, setIntervalSec] = useState<IntervalSec>(30);
  const [lastPollTs, setLastPollTs] = useState<number | null>(null);
  const [lastSignalTs, setLastSignalTs] = useState<number | null>(null);
  const [eventCount, setEventCount] = useState(0);
  const [pollCount, setPollCount] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
        setErr(data.reason ?? "detector error");
        setStatus("error");
        return;
      }
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
      setErr((e as Error).message);
      setStatus("error");
    }
  }, []);

  const start = useCallback(() => {
    if (timerRef.current) return;
    setStatus("running");
    onStatusRef.current?.(true);
    void poll();
    timerRef.current = setInterval(() => {
      void poll();
    }, intervalSec * 1000);
  }, [intervalSec, poll]);

  const stop = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setStatus("idle");
    onStatusRef.current?.(false);
  }, []);

  // Re-arm interval when the pacing slider changes mid-run. Note: deps
  // intentionally exclude `poll` (it's stable now via refs). On unmount,
  // the cleanup tears down the timer.
  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        void poll();
      }, intervalSec * 1000);
    }
    const t = timerRef.current;
    return () => {
      if (t) clearInterval(t);
    };
  }, [intervalSec, poll]);

  const running = status === "running";
  const dotColor =
    status === "running"
      ? "bg-green animate-pulse"
      : status === "error"
        ? "bg-red"
        : "bg-mist";

  return (
    <div className="panel p-5 relative overflow-hidden">
      {/* top-right glow when running */}
      {running ? (
        <div
          className="pointer-events-none absolute -top-10 -right-10 w-40 h-40 rounded-full opacity-20 blur-3xl"
          style={{ background: "#22d3ee" }}
        />
      ) : null}

      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${dotColor}`} />
          <div className="text-xs uppercase tracking-[0.3em] text-mist">
            Autopilot
          </div>
        </div>
        <span className="text-[0.65rem] text-mist num">
          {running ? "Detecting…" : status === "error" ? "Error" : "Stopped"}
        </span>
      </div>

      <p className="text-[0.7rem] text-mist mb-4 leading-relaxed">
        Polls <span className="font-mono text-cyan">api.kiyotaka.ai</span>{" "}
        for BTC + ETH candles, z-scores the latest return and volume, emits
        events when <span className="font-mono">|z| ≥ 2</span>. Each event
        is fed into the swarm → champion → paper trade loop below.
      </p>

      <div className="grid grid-cols-2 gap-2 mb-4 text-[0.7rem] num">
        <Stat label="Polls" value={pollCount.toString()} />
        <Stat label="Events detected" value={eventCount.toString()} />
        <Stat
          label="Last poll"
          value={lastPollTs ? fmtAgo(lastPollTs) : "—"}
        />
        <Stat
          label="Last signal"
          value={lastSignalTs ? fmtAgo(lastSignalTs) : "—"}
        />
      </div>

      <label className="text-[0.7rem] text-mist block mb-1">
        Poll interval
      </label>
      <div className="flex gap-1 mb-4">
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
            {i < 60 ? `${i}s` : `${i / 60}m`}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        {!running ? (
          <button
            onClick={start}
            className="flex-1 chip chip-cyan py-2 text-sm hover:opacity-90"
          >
            Start autopilot
          </button>
        ) : (
          <button
            onClick={stop}
            className="flex-1 chip chip-red py-2 text-sm hover:opacity-90"
          >
            Stop
          </button>
        )}
        <button
          onClick={() => void poll()}
          className="chip chip-mist py-2 px-3 text-sm hover:opacity-90"
          title="Poll once now"
        >
          Poll now
        </button>
      </div>

      {err ? (
        <p className="mt-3 text-[0.7rem] text-red">⚠ {err}</p>
      ) : null}
    </div>
  );
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
