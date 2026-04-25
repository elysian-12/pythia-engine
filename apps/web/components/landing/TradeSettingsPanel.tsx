"use client";

import { useEffect, useState } from "react";

export type LandingConfig = {
  risk_fraction: number;
  equity_usd: number;
  position_cap_mult: number;
  kelly_enabled: boolean;
  mode: "paper" | "live";
  wallet_address: string;
  updated_at: number;
};

const LS_KEY = "pythia-swarm-config";

const DEFAULTS: LandingConfig = {
  risk_fraction: 0.005,
  equity_usd: 1000,
  position_cap_mult: 3,
  kelly_enabled: false,
  mode: "paper",
  wallet_address: "",
  updated_at: 0,
};

const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

export function TradeSettingsPanel() {
  const [cfg, setCfg] = useState<LandingConfig>(DEFAULTS);
  const [saved, setSaved] = useState<"idle" | "saving" | "ok">("idle");
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/config", { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as Partial<LandingConfig>;
          setCfg((prev) => ({ ...prev, ...data }));
          return;
        }
      } catch {
        // ignore
      }
      const ls = typeof window !== "undefined" ? localStorage.getItem(LS_KEY) : null;
      if (ls) {
        try {
          setCfg((prev) => ({ ...prev, ...(JSON.parse(ls) as Partial<LandingConfig>) }));
        } catch {
          // ignore
        }
      }
    })();
  }, []);

  const set = <K extends keyof LandingConfig>(k: K, v: LandingConfig[K]) => {
    setCfg((prev) => ({ ...prev, [k]: v }));
    setSaved("idle");
  };

  const walletValid =
    cfg.wallet_address.length === 0 || EVM_ADDR_RE.test(cfg.wallet_address);

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
      const data = (await res.json()) as LandingConfig & {
        persisted?: boolean;
        warning?: string;
      };
      setCfg(data);
      localStorage.setItem(LS_KEY, JSON.stringify(data));
      window.dispatchEvent(
        new CustomEvent("pythia-config-updated", { detail: data }),
      );
      if (data.persisted === false) {
        setWarning("Saved locally — server is read-only on Vercel.");
      }
      setSaved("ok");
      setTimeout(() => setSaved("idle"), 1800);
    } catch (e) {
      setWarning((e as Error).message);
      setSaved("idle");
    }
  };

  // Risk-of-ruin in dollars, for the visual at the top.
  const riskUsd = cfg.equity_usd * cfg.risk_fraction;

  return (
    <section className="panel p-5 md:p-6">
      <div className="flex items-start justify-between flex-wrap gap-2 mb-4">
        <div>
          <div className="text-[0.6rem] tracking-[0.4em] text-cyan uppercase">
            Trade settings
          </div>
          <h3 className="text-xl font-semibold text-slate-100 mt-1">
            Configure once · the swarm sizes for you
          </h3>
          <p className="text-xs text-mist mt-1.5 max-w-xl">
            These knobs drive the paper ledger and the auto-replay above.
            When you flip to <span className="text-cyan">live preview</span>, plug
            in a wallet — execution wiring lands in the next pass.
          </p>
        </div>
        <ModeToggle mode={cfg.mode} onChange={(m) => set("mode", m)} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Equity */}
        <NumberField
          label="Equity to deploy"
          sublabel="paper money for the simulated ledger; size your real account separately when live"
          value={cfg.equity_usd}
          min={100}
          max={1_000_000}
          step={50}
          prefix="$"
          onChange={(v) => set("equity_usd", v)}
        />

        {/* Risk */}
        <Slider
          label="Risk per trade"
          sublabel={`${(cfg.risk_fraction * 100).toFixed(2)}% of equity at the stop · ≈ $${riskUsd.toFixed(0)} per trade`}
          value={cfg.risk_fraction}
          min={0.001}
          max={0.02}
          step={0.0005}
          fmt={(v) => `${(v * 100).toFixed(2)}%`}
          onChange={(v) => set("risk_fraction", v)}
        />

        {/* Cap */}
        <Slider
          label="Leverage cap"
          sublabel="upper bound on notional / equity"
          value={cfg.position_cap_mult}
          min={1}
          max={10}
          step={0.5}
          fmt={(v) => `${v.toFixed(1)}×`}
          onChange={(v) => set("position_cap_mult", v)}
        />

        {/* Kelly */}
        <label className="flex items-start gap-3 cursor-pointer rounded-sm border border-edge/60 bg-black/20 px-3 py-3">
          <input
            type="checkbox"
            className="mt-1 accent-cyan"
            checked={cfg.kelly_enabled}
            onChange={(e) => set("kelly_enabled", e.target.checked)}
          />
          <div>
            <div className="text-sm text-slate-200">Quarter-Kelly sizing</div>
            <div className="text-[0.65rem] text-mist mt-0.5">
              f = 0.25 × [p·b − (1−p)] / b · overrides risk-fraction when on.
              From PolySwarm §III.E.
            </div>
          </div>
        </label>
      </div>

      {/* Live mode reveals wallet input */}
      {cfg.mode === "live" ? (
        <div className="mt-5 rounded-sm border border-amber/30 bg-amber/5 p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="text-[0.6rem] uppercase tracking-widest text-amber">
                Live preview
              </div>
              <p className="text-xs text-mist mt-1 max-w-xl">
                Real-money execution is gated behind a manual review step — no
                EIP-712 signer wired here yet. Add your Hyperliquid address to
                preview where copy-trades would route. We never store keys.
              </p>
            </div>
            <span className="chip chip-mist">disconnected</span>
          </div>
          <div className="mt-3">
            <input
              value={cfg.wallet_address}
              onChange={(e) => set("wallet_address", e.target.value.trim())}
              placeholder="0x… your EVM wallet (Hyperliquid uses Ethereum-style addresses)"
              className={`w-full font-mono text-sm bg-black/40 border rounded-sm px-3 py-2 outline-none transition-colors ${
                walletValid
                  ? "border-edge/60 focus:border-cyan/60"
                  : "border-red/60 focus:border-red"
              }`}
              maxLength={42}
            />
            {!walletValid ? (
              <div className="text-[0.65rem] text-red mt-1">
                Looks malformed — expecting 42 chars starting with 0x.
              </div>
            ) : null}
            <div className="text-[0.65rem] text-mist mt-1">
              Find yours at app.hyperliquid.xyz → Subaccount → Trader Address.
              Read-only here; nothing leaves your browser yet.
            </div>
          </div>
        </div>
      ) : null}

      <div className="mt-5 flex items-center justify-between flex-wrap gap-2">
        <button
          onClick={save}
          disabled={saved === "saving" || !walletValid}
          className="chip chip-cyan px-4 py-1.5 hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          {saved === "saving" ? "Saving…" : saved === "ok" ? "Saved" : "Save settings"}
        </button>
        <div className="text-[0.65rem] text-mist num">
          mode <span className="text-slate-200">{cfg.mode}</span>
          {cfg.updated_at
            ? ` · updated ${new Date(cfg.updated_at * 1000).toLocaleTimeString()}`
            : ""}
        </div>
      </div>

      {warning ? (
        <p className="mt-2 text-[0.7rem] text-amber">{warning}</p>
      ) : null}
    </section>
  );
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: "paper" | "live";
  onChange: (m: "paper" | "live") => void;
}) {
  return (
    <div className="inline-flex rounded-sm border border-edge/60 bg-black/30 p-0.5 text-[0.7rem]">
      {(["paper", "live"] as const).map((m) => {
        const active = mode === m;
        return (
          <button
            key={m}
            onClick={() => onChange(m)}
            className={`px-3 py-1 rounded-sm uppercase tracking-widest transition-colors ${
              active
                ? m === "live"
                  ? "bg-amber/15 text-amber"
                  : "bg-cyan/15 text-cyan"
                : "text-mist hover:text-slate-200"
            }`}
          >
            {m === "live" ? "Live preview" : "Paper"}
          </button>
        );
      })}
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
    <div className="rounded-sm border border-edge/60 bg-black/20 px-3 py-3">
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

function NumberField({
  label,
  sublabel,
  value,
  min,
  max,
  step,
  prefix,
  onChange,
}: {
  label: string;
  sublabel: string;
  value: number;
  min: number;
  max: number;
  step: number;
  prefix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="rounded-sm border border-edge/60 bg-black/20 px-3 py-3">
      <div className="flex justify-between items-baseline">
        <span className="text-sm text-slate-200">{label}</span>
        <span className="text-[0.65rem] text-mist">
          ${min.toLocaleString()} – ${max.toLocaleString()}
        </span>
      </div>
      <div className="text-[0.65rem] text-mist mt-0.5">{sublabel}</div>
      <div className="mt-2 flex items-center gap-2">
        {prefix ? (
          <span className="text-mist text-sm num">{prefix}</span>
        ) : null}
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
          }}
          className="flex-1 bg-black/40 border border-edge/60 rounded-sm px-2 py-1.5 text-sm num text-slate-100 outline-none focus:border-cyan/60"
        />
      </div>
    </div>
  );
}
