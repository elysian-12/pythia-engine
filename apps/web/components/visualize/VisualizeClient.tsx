"use client";

import { useEffect, useMemo, useState } from "react";
import {
  loadEquity,
  loadSummary,
  loadTrades,
  type EquityPoint,
  type Summary,
  type TradePoint,
} from "@/lib/vis-data";
import { TradeReplay } from "./TradeReplay";
import { TradeSettingsPanel } from "@/components/landing/TradeSettingsPanel";

type UserCfg = { equity_usd: number; risk_fraction: number };

const REFERENCE_EQUITY = 1000; // the bundled backtest starts here
const REFERENCE_RISK = 0.01;   // and risks 1% per trade

/** Rescale the bundled trade ledger to the visitor's chosen capital +
 *  risk-fraction. The R-multiple is the ground truth (it's risk-units,
 *  not dollars), so we recompute pnl as `r × (user_equity × user_risk)`
 *  trade-by-trade and re-walk the equity curve from the user's starting
 *  capital. The result is a faithful simulation of "what would I have
 *  made running this exact strategy at *my* size?". */
function rescaleToUser(
  trades: TradePoint[],
  user: UserCfg,
): { equity: EquityPoint[]; trades: TradePoint[] } {
  if (trades.length === 0) return { equity: [], trades: [] };
  const dollarsPerR = user.equity_usd * user.risk_fraction;
  let bal = user.equity_usd;
  const out: EquityPoint[] = [
    { ts: trades[0].ts, equity: bal },
  ];
  const scaled: TradePoint[] = trades.map((t) => {
    const pnl = t.r * dollarsPerR;
    bal += pnl;
    out.push({ ts: t.ts, equity: bal });
    return { ...t, pnl };
  });
  return { equity: out, trades: scaled };
}

export function VisualizeClient() {
  const [equity, setEquity] = useState<EquityPoint[]>([]);
  const [trades, setTrades] = useState<TradePoint[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [userCfg, setUserCfg] = useState<UserCfg>({
    equity_usd: REFERENCE_EQUITY,
    risk_fraction: REFERENCE_RISK,
  });

  useEffect(() => {
    Promise.all([loadEquity(), loadTrades(), loadSummary()])
      .then(([e, t, s]) => {
        setEquity(e);
        setTrades(t);
        setSummary(s);
      })
      .catch((err) => setErr((err as Error).message));
  }, []);

  // Pull the user's settings on mount + whenever they change. The landing
  // SettingsForm broadcasts `pythia-config-updated`; we also listen for
  // cross-tab `storage` events for completeness.
  useEffect(() => {
    const apply = (cfg: Partial<UserCfg>) => {
      setUserCfg((prev) => ({
        equity_usd:
          typeof cfg.equity_usd === "number" && cfg.equity_usd > 0
            ? cfg.equity_usd
            : prev.equity_usd,
        risk_fraction:
          typeof cfg.risk_fraction === "number" && cfg.risk_fraction > 0
            ? cfg.risk_fraction
            : prev.risk_fraction,
      }));
    };
    (async () => {
      try {
        const r = await fetch("/api/config", { cache: "no-store" });
        if (r.ok) apply((await r.json()) as Partial<UserCfg>);
      } catch {
        /* ignore */
      }
      try {
        const ls = localStorage.getItem("pythia-swarm-config");
        if (ls) apply(JSON.parse(ls) as Partial<UserCfg>);
      } catch {
        /* ignore */
      }
    })();
    const onCustom = (e: Event) => {
      apply((e as CustomEvent<Partial<UserCfg>>).detail ?? {});
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== "pythia-swarm-config" || !e.newValue) return;
      try {
        apply(JSON.parse(e.newValue) as Partial<UserCfg>);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pythia-config-updated", onCustom);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("pythia-config-updated", onCustom);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // Rescale the bundled ledger trade-by-trade to the user's size. Memoised
  // so we don't recompute on every render.
  const scaled = useMemo(() => {
    if (trades.length === 0) return { equity, trades };
    return rescaleToUser(trades, userCfg);
  }, [trades, equity, userCfg]);

  if (err) {
    return (
      <div className="panel p-8 text-center">
        <div className="text-[0.65rem] tracking-[0.4em] text-amber uppercase">
          Dataset failed to load
        </div>
        <p className="mt-2 text-mist text-sm">
          {err}. Re-run <code className="num text-cyan">cargo run -p strategy --bin export_vis</code>
          {" "}to regenerate{" "}
          <code className="num text-cyan">apps/web/public/data/*.json</code>.
        </p>
      </div>
    );
  }

  if (!summary || equity.length === 0 || trades.length === 0) {
    return (
      <div className="panel p-8 text-center">
        <div className="text-[0.65rem] tracking-[0.4em] text-cyan uppercase">
          Loading replay…
        </div>
        <p className="mt-2 text-mist text-sm">
          Reading 365 days of equity and trade data.
        </p>
      </div>
    );
  }

  // User-scaled headline numbers — what THEIR portfolio would have done.
  const userFinal =
    scaled.equity.length > 0
      ? scaled.equity[scaled.equity.length - 1].equity
      : userCfg.equity_usd;
  const userPnl = userFinal - userCfg.equity_usd;
  const userRoi = (userPnl / userCfg.equity_usd) * 100;
  const isCustom =
    Math.abs(userCfg.equity_usd - REFERENCE_EQUITY) > 1 ||
    Math.abs(userCfg.risk_fraction - REFERENCE_RISK) > 1e-6;

  return (
    <div className="space-y-6">
      {/* Hero summary */}
      <section className="panel p-6 md:p-8 relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 opacity-50"
          style={{
            background:
              "radial-gradient(circle at 90% 20%, rgba(34,211,238,0.10), transparent 55%)",
          }}
        />
        <div className="relative">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 chip chip-amber text-[0.6rem]">
                <span className="w-1 h-1 rounded-full bg-amber-300" />
                Replay
              </span>
              <span className="text-[0.6rem] tracking-[0.4em] text-purple-300 uppercase">
                Pythia · 365-day backtest · your size
              </span>
            </div>
            <span
              className={`chip ${
                isCustom ? "chip-royal" : "chip-mist"
              } text-[0.6rem]`}
            >
              ${userCfg.equity_usd.toLocaleString()} @ {(userCfg.risk_fraction * 100).toFixed(2)}%
              {isCustom ? " · your config" : " · default"}
            </span>
          </div>
          <h2 className="mt-2 text-3xl md:text-4xl font-semibold text-slate-100 leading-tight">
            <span className="num">${userCfg.equity_usd.toLocaleString()}</span>
            <span className="mx-2 text-mist">→</span>
            <span className={`num ${userPnl >= 0 ? "text-cyan" : "text-red"}`}>
              ${userFinal.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
            <span
              className={`ml-3 text-base num ${
                userRoi >= 0 ? "text-mist" : "text-red"
              }`}
            >
              {userRoi >= 0 ? "+" : ""}
              {userRoi.toFixed(0)}%
            </span>
          </h2>
          <p className="mt-2 text-sm text-mist max-w-2xl">
            {summary.strategy} on Kiyotaka BTC + ETH perp data. R-multiples
            from the bundled 365-day replay rescaled to your equity and
            risk-fraction — adjust them on{" "}
            <a href="/" className="text-cyan hover:underline">
              the home page
            </a>{" "}
            and this view updates instantly. The strategy stats below
            (win-rate, Sharpe, max DD) are size-invariant and stay constant.
          </p>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-5">
            <Metric
              label="Win rate"
              value={`${(summary.win_rate * 100).toFixed(1)}%`}
              tone="pos"
            />
            <Metric label="Sharpe / trade" value={summary.sharpe.toFixed(2)} tone="cyan" />
            <Metric label="Sortino" value={summary.sortino.toFixed(2)} tone="cyan" />
            <Metric
              label="Profit factor"
              value={summary.profit_factor.toFixed(2)}
              tone="pos"
            />
            <Metric
              label="Max DD"
              value={`${(summary.max_drawdown * 100).toFixed(1)}%`}
              tone="neutral"
            />
          </div>
        </div>
      </section>

      {/* Trade replay — the centrepiece, sized to the user */}
      <TradeReplay
        equity={scaled.equity.length > 0 ? scaled.equity : equity}
        trades={scaled.trades.length > 0 ? scaled.trades : trades}
      />

      {/* Settings live just under the replay so users connect cause →
          effect: change a knob, the curve above redraws. */}
      <TradeSettingsPanel />


      {/* Rule families — replaces the old single-strategy pseudocode card.
          Lists the seven rule families currently in the swarm and the
          event kind each family specialises in. The router on
          /tournament uses this same table to pick a per-event-kind
          specialist; visitors who want to inspect specific agent stats
          should head there. */}
      <section className="panel p-5 md:p-6">
        <div className="text-[0.6rem] tracking-[0.4em] uppercase">
          <span className="text-amber-300">Rule families</span>
          <span className="text-mist/60 mx-2">·</span>
          <span className="text-purple-300">what each agent watches</span>
        </div>
        <h3 className="text-xl font-semibold text-slate-100 mt-1">
          Seven specialists, one swarm
        </h3>
        <p className="mt-1 text-xs text-mist max-w-2xl">
          Each row is one rule family. Multiple agents per family run with
          different parameters, mutate every N events via log-space
          Gaussian + same-family crossover, and feed the scoreboard. The
          router on{" "}
          <a className="text-cyan hover:underline" href="/tournament">
            /tournament
          </a>{" "}
          picks the specialist whose family best matches an incoming
          event.
        </p>

        <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-3 text-[0.75rem]">
          {[
            {
              name: "liq-trend",
              dot: "#34d399",
              kind: "liq-spike",
              rule: "ride a forced-liquidation cascade in the cascade direction (|z| > 2.5σ on hourly net liq).",
            },
            {
              name: "liq-fade",
              dot: "#f87171",
              kind: "liq-spike",
              rule: "fade the same cascade — thesis: forced flow exhausts and reverts.",
            },
            {
              name: "vol-breakout",
              dot: "#fbbf24",
              kind: "vol-breakout",
              rule: "Donchian-24 break + ATR% in band → enter in breakout direction.",
            },
            {
              name: "funding-trend",
              dot: "#60a5fa",
              kind: "funding-spike",
              rule: "ride extreme funding tilt (z > 2σ) until sentiment flips.",
            },
            {
              name: "funding-arb",
              dot: "#c084fc",
              kind: "funding-spike",
              rule: "fade the same tilt — thesis: tilts overshoot, mean-revert.",
            },
            {
              name: "polyedge",
              dot: "#f472b6",
              kind: "polymarket-lead",
              rule: "Polymarket SWP lags spot in calm regimes; leads in directional ones. Trade the gap when it leads.",
            },
            {
              name: "polyfusion",
              dot: "#fde68a",
              kind: "fusion",
              rule: "fire only when ≥2 of {liq, funding, vol, polymarket} align — confluence agent.",
            },
          ].map((f) => (
            <div
              key={f.name}
              className="rounded-sm border border-edge/60 bg-black/30 p-3"
            >
              <div className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ background: f.dot, boxShadow: `0 0 6px ${f.dot}` }}
                />
                <span className="font-mono text-slate-100">{f.name}</span>
                <span className="text-[0.55rem] uppercase tracking-widest text-mist ml-auto">
                  → {f.kind}
                </span>
              </div>
              <p className="mt-1.5 text-xs text-slate-300 leading-relaxed">
                {f.rule}
              </p>
            </div>
          ))}
        </div>

        <p className="mt-4 text-[0.7rem] text-mist">
          Plus 5 LLM personas (degen-scalper, momentum-chaser,
          contrarian-fader, cautious-risk-manager, macro-ranger) that
          take the same event stream and reason narratively. They pass
          the self-backtest gate on the same per-trade R as everyone else
          — PnL is the only judge.
        </p>
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "pos" | "neg" | "cyan" | "neutral";
}) {
  const c =
    tone === "pos"
      ? "text-green"
      : tone === "neg"
        ? "text-red"
        : tone === "cyan"
          ? "text-cyan"
          : "text-slate-100";
  return (
    <div className="rounded-sm border border-edge/60 bg-black/30 px-3 py-2.5 num">
      <div className="text-[0.55rem] uppercase tracking-widest text-mist">
        {label}
      </div>
      <div className={`mt-0.5 text-xl font-semibold ${c}`}>{value}</div>
    </div>
  );
}
