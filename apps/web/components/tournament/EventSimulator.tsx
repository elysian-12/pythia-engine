"use client";

import { useState } from "react";
import type { SimAsset, SimDirection, SimEvent, SimEventKind } from "@/lib/simulate";

type Props = {
  onFire: (ev: SimEvent) => void;
  lastFired?: SimEvent | null;
  /** Optional class merged onto the panel root — used by the
   *  tournament left sidebar to tell the panel to fill remaining
   *  vertical space ("h-full flex flex-col") so the visible bottom
   *  edge aligns with the centre column. */
  className?: string;
};

const EVENT_KIND_META: Record<SimEventKind, { label: string; hint: string }> = {
  "liq-spike": {
    label: "Liquidation spike",
    hint: "Forced-order cascade. liq-trend agents ride it, liq-fade agents fight it.",
  },
  "funding-spike": {
    label: "Funding rate spike",
    hint: "Extreme funding tilt. funding-trend rides, funding-arb fades.",
  },
  "vol-breakout": {
    label: "Volatility breakout",
    hint: "Donchian-24 breakout. vol-breakout agents fire in breakout direction.",
  },
  "polymarket-lead": {
    label: "Polymarket leadership",
    hint: "SWP-vs-mid gap with Granger-passing lead. polyedge agent rides it.",
  },
  fusion: {
    label: "Confluence event",
    hint: "≥2 of {liq, funding, vol, polymarket} aligned. polyfusion agent fires.",
  },
};

export function EventSimulator({ onFire, lastFired, className }: Props) {
  const [asset, setAsset] = useState<SimAsset>("BTC");
  const [kind, setKind] = useState<SimEventKind>("liq-spike");
  const [direction, setDirection] = useState<SimDirection>("long");
  const [magnitude, setMagnitude] = useState(3.0);

  const fire = () => {
    const ev: SimEvent = {
      id: crypto.randomUUID(),
      ts: Math.floor(Date.now() / 1000),
      asset,
      kind,
      magnitude_z: magnitude,
      direction,
    };
    onFire(ev);
  };

  return (
    <div className={`panel p-5 ${className ?? ""}`}>
      <div className="text-xs uppercase tracking-[0.3em] text-mist mb-1">
        Event simulator
      </div>
      <p className="text-[0.7rem] text-mist mb-4">
        Input a synthetic market event. The swarm&apos;s reaction previews
        below — which agents fire, which direction, which would become the
        live trade if you&apos;re copy-trading.
      </p>

      <div className="space-y-4">
        <Row label="Asset">
          <Segmented
            value={asset}
            options={["BTC", "ETH"] as const}
            onChange={(v) => setAsset(v as SimAsset)}
          />
        </Row>

        <Row label="Event type">
          <select
            className="w-full bg-black/40 border border-edge rounded-sm px-2 py-1.5 text-sm num"
            value={kind}
            onChange={(e) => setKind(e.target.value as SimEventKind)}
          >
            {Object.entries(EVENT_KIND_META).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
          <p className="text-[0.65rem] text-mist mt-1">
            {EVENT_KIND_META[kind].hint}
          </p>
        </Row>

        <Row label="Raw direction">
          <Segmented
            value={direction}
            options={["long", "short"] as const}
            onChange={(v) => setDirection(v as SimDirection)}
          />
          <p className="text-[0.65rem] text-mist mt-1">
            Direction of the forcing flow (e.g. shorts getting wiped out
            → up-pressure → &quot;long&quot;).
          </p>
        </Row>

        <Row label={`Magnitude (|z|)  ·  ${magnitude.toFixed(2)}σ`}>
          <input
            type="range"
            min={0.5}
            max={6}
            step={0.1}
            value={magnitude}
            onChange={(e) => setMagnitude(Number(e.target.value))}
            className="w-full accent-cyan"
          />
          <div className="flex justify-between text-[0.6rem] text-mist num mt-1">
            <span>0.5σ (noise)</span>
            <span>2.5σ (trigger)</span>
            <span>6σ (cascade)</span>
          </div>
        </Row>
      </div>

      <button
        onClick={fire}
        className="mt-5 w-full chip chip-cyan py-2 text-sm hover:opacity-90 transition-opacity"
      >
        Fire event →
      </button>

      {lastFired ? (
        <div className="mt-3 text-[0.65rem] text-mist num">
          last: {lastFired.kind} · {lastFired.asset} · |z|=
          {lastFired.magnitude_z.toFixed(2)} · {lastFired.direction}
        </div>
      ) : null}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs text-slate-300 block mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-sm overflow-hidden border border-edge">
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={`px-3 py-1 text-xs font-mono uppercase tracking-wider transition-colors ${
            value === o
              ? "bg-cyan text-ink"
              : "bg-black/30 text-slate-300 hover:bg-edge/60"
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}
