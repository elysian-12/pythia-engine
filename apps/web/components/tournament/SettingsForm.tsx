"use client";

import { useEffect, useState } from "react";

export type SwarmConfig = {
  risk_fraction: number;
  position_cap_mult: number;
  kelly_enabled: boolean;
  uncertainty_filter: number;
  // Portfolio meta-agent — exit + aggregation rules.
  max_open_positions: number;
  min_conviction: number;
  time_stop_hours: number;
  trail_after_r: number;
  swarm_flip_conviction: number;
  min_hold_minutes: number;
  max_session_dd_pct: number;
  correlation_size_factor: number;
  updated_at: number;
};

const DEFAULT_CONFIG: SwarmConfig = {
  risk_fraction: 0.005,
  position_cap_mult: 3,
  kelly_enabled: false,
  uncertainty_filter: 0.4,
  max_open_positions: 8,
  min_conviction: 0.30,
  time_stop_hours: 12,
  trail_after_r: 1.5,
  swarm_flip_conviction: 0.60,
  min_hold_minutes: 30,
  max_session_dd_pct: 0.05,
  correlation_size_factor: 0.5,
  updated_at: 0,
};

const LS_KEY = "pythia-swarm-config";

export function SettingsForm() {
  const [cfg, setCfg] = useState<SwarmConfig>(DEFAULT_CONFIG);
  const [saved, setSaved] = useState<"idle" | "saving" | "ok" | "err">("idle");
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    // Prefer server persisted config; fall back to localStorage.
    (async () => {
      try {
        const res = await fetch("/api/config", { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as SwarmConfig;
          setCfg(data);
          return;
        }
      } catch {
        // ignore
      }
      const ls = typeof window !== "undefined" ? localStorage.getItem(LS_KEY) : null;
      if (ls) {
        try {
          setCfg(JSON.parse(ls) as SwarmConfig);
        } catch {
          // ignore
        }
      }
    })();
  }, []);

  const onChange = <K extends keyof SwarmConfig>(k: K, v: SwarmConfig[K]) => {
    setCfg((p) => ({ ...p, [k]: v }));
    setSaved("idle");
  };

  const save = async () => {
    setSaved("saving");
    setWarning(null);
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SwarmConfig & { persisted?: boolean; warning?: string };
      setCfg(data);
      localStorage.setItem(LS_KEY, JSON.stringify(data));
      // Tell same-tab listeners (TournamentClient) the risk knob changed —
      // `storage` events do NOT fire in the originating tab, so we use a
      // CustomEvent to bridge the gap.
      window.dispatchEvent(
        new CustomEvent("pythia-config-updated", { detail: data }),
      );
      if (data.persisted === false) {
        setWarning("Saved to browser only — server is read-only (Vercel).");
      }
      setSaved("ok");
      setTimeout(() => setSaved("idle"), 2000);
    } catch (e) {
      setWarning((e as Error).message);
      setSaved("err");
    }
  };

  return (
    <div className="panel p-5">
      <div className="text-xs uppercase tracking-[0.3em] text-mist mb-4">
        Your trade settings
      </div>

      <div className="space-y-4">
        {/* Risk per trade */}
        <Slider
          label="Risk per trade"
          sublabel="% of equity sacrificed if stop hits (ATR-scaled sizing)"
          value={cfg.risk_fraction}
          min={0.001}
          max={0.02}
          step={0.0005}
          fmt={(v) => `${(v * 100).toFixed(2)} %`}
          onChange={(v) => onChange("risk_fraction", v)}
        />

        {/* Position cap */}
        <Slider
          label="Position cap"
          sublabel="max notional as × of equity (leverage upper bound)"
          value={cfg.position_cap_mult}
          min={1}
          max={10}
          step={0.5}
          fmt={(v) => `${v.toFixed(1)}×`}
          onChange={(v) => onChange("position_cap_mult", v)}
        />

        {/* Uncertainty filter */}
        <Slider
          label="Uncertainty filter"
          sublabel="skip trade when top-K disagreement exceeds this (PolySwarm §III.D)"
          value={cfg.uncertainty_filter}
          min={0}
          max={1}
          step={0.05}
          fmt={(v) => `${(v * 100).toFixed(0)} %`}
          onChange={(v) => onChange("uncertainty_filter", v)}
        />

        {/* Kelly toggle */}
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="mt-1 accent-cyan"
            checked={cfg.kelly_enabled}
            onChange={(e) => onChange("kelly_enabled", e.target.checked)}
          />
          <div>
            <div className="text-sm text-slate-200">Quarter-Kelly sizing</div>
            <div className="text-[0.7rem] text-mist mt-0.5">
              f = 0.25 × [p·b − (1−p)] / b · overrides risk-fraction sizing when on.
            </div>
          </div>
        </label>

        {/* Portfolio meta-agent — exit + aggregation rules. The router
            decides which specialist to follow on entry; these knobs
            decide when to flatten and how much exposure to carry. */}
        <div className="pt-3 border-t border-edge/40">
          <div className="text-[0.6rem] uppercase tracking-[0.3em] text-purple-300 mb-3">
            Exit rules · meta-agent
          </div>

          <Slider
            label="Max open positions"
            sublabel="hard cap on simultaneous paper positions across BTC + ETH"
            value={cfg.max_open_positions}
            min={1}
            max={16}
            step={1}
            fmt={(v) => `${v.toFixed(0)}`}
            onChange={(v) => onChange("max_open_positions", v)}
          />

          <Slider
            label="Min conviction to enter"
            sublabel="skip new entries below this ensemble conviction"
            value={cfg.min_conviction}
            min={0}
            max={1}
            step={0.05}
            fmt={(v) => `${(v * 100).toFixed(0)} %`}
            onChange={(v) => onChange("min_conviction", v)}
          />

          <Slider
            label="Time stop"
            sublabel="force-exit positions older than this — 0 disables"
            value={cfg.time_stop_hours}
            min={0}
            max={48}
            step={1}
            fmt={(v) => (v === 0 ? "off" : `${v.toFixed(0)} h`)}
            onChange={(v) => onChange("time_stop_hours", v)}
          />

          <Slider
            label="Trail after"
            sublabel="lock breakeven once unrealized R clears this — 0 disables"
            value={cfg.trail_after_r}
            min={0}
            max={3}
            step={0.25}
            fmt={(v) => (v === 0 ? "off" : `${v.toFixed(2)} R`)}
            onChange={(v) => onChange("trail_after_r", v)}
          />

          <Slider
            label="Swarm-flip exit"
            sublabel="close when fresh ensemble votes opposite at ≥ this conviction"
            value={cfg.swarm_flip_conviction}
            min={0}
            max={1}
            step={0.05}
            fmt={(v) => (v >= 1 ? "off" : `${(v * 100).toFixed(0)} %`)}
            onChange={(v) => onChange("swarm_flip_conviction", v)}
          />

          <Slider
            label="Min hold (swarm-flip)"
            sublabel="positions younger than this can't be cut by swarm-flip — stops + reverse still fire"
            value={cfg.min_hold_minutes}
            min={0}
            max={120}
            step={5}
            fmt={(v) => (v === 0 ? "off" : `${v.toFixed(0)} min`)}
            onChange={(v) => onChange("min_hold_minutes", v)}
          />

          <Slider
            label="Session DD circuit-breaker"
            sublabel="halt new entries when realised session PnL drops below −X% of equity"
            value={cfg.max_session_dd_pct}
            min={0}
            max={0.2}
            step={0.01}
            fmt={(v) => (v >= 1 ? "off" : `${(v * 100).toFixed(1)} %`)}
            onChange={(v) => onChange("max_session_dd_pct", v)}
          />

          <Slider
            label="Correlation size cut"
            sublabel="multiply 2nd asset's notional by this when 1st is open (BTC/ETH ~0.7 corr)"
            value={cfg.correlation_size_factor}
            min={0.25}
            max={1}
            step={0.05}
            fmt={(v) => (v >= 1 ? "off" : `${(v * 100).toFixed(0)} %`)}
            onChange={(v) => onChange("correlation_size_factor", v)}
          />
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between">
        <button
          onClick={save}
          disabled={saved === "saving"}
          className="chip chip-cyan px-4 py-1.5 hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {saved === "saving"
            ? "Saving…"
            : saved === "ok"
              ? "Saved"
              : saved === "err"
                ? "Retry"
                : "Save"}
        </button>
        <span className="text-[0.65rem] text-mist num">
          {cfg.updated_at
            ? `updated ${new Date(cfg.updated_at * 1000).toLocaleTimeString()}`
            : "—"}
        </span>
      </div>

      {warning ? (
        <p className="mt-2 text-[0.7rem] text-amber">{warning}</p>
      ) : null}
    </div>
  );
}

function Slider({
  label,
  sublabel,
  value,
  min,
  max,
  step,
  fmt,
  onChange,
}: {
  label: string;
  sublabel: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex justify-between items-baseline">
        <span className="text-sm text-slate-200">{label}</span>
        <span className="text-sm num text-cyan">{fmt(value)}</span>
      </div>
      <div className="text-[0.65rem] text-mist mt-0.5">{sublabel}</div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full mt-2 accent-cyan"
      />
    </div>
  );
}
