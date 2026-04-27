"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  agentFamily,
  FAMILY_COLORS,
  fetchSwarm,
  type SwarmSnapshot,
} from "@/lib/swarm";
import { loadEquity, type EquityPoint } from "@/lib/vis-data";
import { AutoReplay } from "./AutoReplay";
import { TradeSettingsPanel } from "./TradeSettingsPanel";
import { PythiaLogo } from "@/components/brand/PythiaLogo";

type Marks = { BTC: number | null; ETH: number | null };

const STARTING_EQUITY = 1000;

function fmtUsd(v: number, dp = 0): string {
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`;
}

function fmtPct(v: number, dp = 1): string {
  return `${(v >= 0 ? "+" : "")}${v.toFixed(dp)}%`;
}

function MarkTicker({ marks }: { marks: Marks }) {
  return (
    <div className="flex items-center gap-3 text-[0.7rem]">
      <TickerCell label="BTC" px={marks.BTC} />
      <TickerCell label="ETH" px={marks.ETH} />
    </div>
  );
}

function TickerCell({ label, px }: { label: string; px: number | null }) {
  return (
    <div className="flex items-center gap-1.5 num">
      <span className="text-mist text-[0.65rem]">{label}</span>
      <span className="text-slate-100">
        {px != null
          ? `$${px.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
          : "—"}
      </span>
    </div>
  );
}

function MiniSpark({ points }: { points: EquityPoint[] }) {
  if (points.length < 2) return null;
  const w = 600;
  const h = 160;
  const xs = points.map((p) => p.ts);
  const ys = points.map((p) => p.equity);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xScale = (t: number) =>
    xMax === xMin ? 0 : ((t - xMin) / (xMax - xMin)) * w;
  const yScale = (v: number) =>
    yMax === yMin ? h : h - ((v - yMin) / (yMax - yMin)) * h;
  const d = points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${xScale(p.ts).toFixed(1)},${yScale(p.equity).toFixed(1)}`,
    )
    .join(" ");
  const last = points[points.length - 1].equity;
  const startV = points[0].equity;
  const up = last >= startV;
  const stroke = up ? "#34d399" : "#f87171";
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="w-full h-[160px] block"
    >
      <defs>
        <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="url(#equityFill)" />
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} />
    </svg>
  );
}

function PnlBars({ snap }: { snap: SwarmSnapshot }) {
  const top = useMemo(() => {
    return [...snap.agents]
      .sort((a, b) => b.total_r - a.total_r)
      .slice(0, 8);
  }, [snap.agents]);
  const max = Math.max(1, ...top.map((a) => Math.abs(a.total_r)));
  return (
    <div className="space-y-1.5">
      {top.map((a) => {
        const family = agentFamily(a.agent_id);
        const color = FAMILY_COLORS[family] ?? "#94a3b8";
        const pct = (Math.abs(a.total_r) / max) * 100;
        const pos = a.total_r >= 0;
        return (
          <div
            key={a.agent_id}
            className="grid grid-cols-[160px_1fr_64px] gap-2 items-center text-[0.7rem]"
          >
            <div className="font-mono text-slate-300 truncate" title={a.agent_id}>
              <span
                className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle"
                style={{ background: color, boxShadow: `0 0 6px ${color}` }}
              />
              {a.agent_id.replace(/^gen\d+-mut\d+-/, "")}
            </div>
            <div className="h-2 bg-edge/40 rounded-sm overflow-hidden">
              <div
                className="h-full"
                style={{
                  width: `${pct}%`,
                  background: pos ? "#34d39955" : "#f8717155",
                  borderRight: `2px solid ${pos ? "#34d399" : "#f87171"}`,
                }}
              />
            </div>
            <div
              className={`text-right num ${
                pos ? "text-green" : "text-red"
              }`}
            >
              {pos ? "+" : ""}
              {a.total_r.toFixed(1)}R
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function LandingDashboard() {
  const [snap, setSnap] = useState<SwarmSnapshot | null>(null);
  const [snapErr, setSnapErr] = useState<string | null>(null);
  const [marks, setMarks] = useState<Marks>({ BTC: null, ETH: null });
  const [equity, setEquity] = useState<EquityPoint[]>([]);

  useEffect(() => {
    let alive = true;
    fetchSwarm()
      .then((s) => alive && setSnap(s))
      .catch((e) => alive && setSnapErr((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/marks", { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as { marks: Marks };
        if (!alive) return;
        setMarks((prev) => ({
          BTC: d.marks.BTC ?? prev.BTC,
          ETH: d.marks.ETH ?? prev.ETH,
        }));
      } catch {
        /* ignore */
      }
    };
    load();
    const t = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    loadEquity()
      .then((e) => alive && setEquity(e))
      .catch(() => {
        /* fall back to no chart */
      });
    return () => {
      alive = false;
    };
  }, []);

  const finalEquity =
    equity.length > 0 ? equity[equity.length - 1].equity : STARTING_EQUITY;
  const pnl = finalEquity - STARTING_EQUITY;
  const roi = (pnl / STARTING_EQUITY) * 100;

  const champ = snap?.champion ?? null;
  const cert = snap?.champion_certification ?? null;
  const families = snap
    ? Array.from(new Set(snap.agents.map((a) => agentFamily(a.agent_id)))).filter(
        (f) => f !== "other",
      )
    : [];

  return (
    <div className="max-w-[110rem] mx-auto space-y-5 md:space-y-6">
      {/* HERO */}
      <section className="panel relative overflow-hidden p-4 md:p-6 ring-1 ring-royal/20">
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background:
              "radial-gradient(circle at 15% 20%, rgba(126,34,206,0.18), transparent 55%), radial-gradient(circle at 85% 80%, rgba(34,211,238,0.10), transparent 55%), radial-gradient(circle at 60% 100%, rgba(245,158,11,0.08), transparent 50%)",
          }}
        />
        {/* Top gilded rule */}
        <div
          className="pointer-events-none absolute top-0 left-0 right-0 h-px"
          style={{
            background:
              "linear-gradient(90deg, transparent, rgba(245,158,11,0.6), rgba(126,34,206,0.6), rgba(34,211,238,0.6), transparent)",
          }}
        />
        <div className="relative">
          {/* Hero is now a 12-col grid that fills the panel: title +
              description on the left (cols 1-7), then stats 2x2 +
              ticker + CTAs stacked on the right (cols 8-12). The
              equity chart stretches full-width below. No more empty
              right half on a wide monitor. */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-6 items-start">
            {/* LEFT — title block */}
            <div className="lg:col-span-7 flex items-start gap-5">
              <PythiaLogo size={72} className="hidden md:block mt-1 shrink-0" />
              <div className="min-w-0">
                <div className="flex items-center gap-3 text-[0.6rem] tracking-[0.4em] uppercase">
                  <span className="text-amber-300">Pythia</span>
                  <span className="text-mist/60">·</span>
                  <span className="text-purple-300">Oracle of the Swarm</span>
                </div>
                <h2 className="mt-2 text-3xl md:text-4xl font-semibold text-slate-100 leading-[1.05] tracking-tight">
                  25 agents.{" "}
                  <span
                    className="bg-gradient-to-r from-amber-300 via-purple-400 to-cyan bg-clip-text text-transparent"
                  >
                    One champion.
                  </span>
                  <br />
                  <span className="text-cyan">
                    Every Kiyotaka event becomes a trade.
                  </span>
                </h2>
                <p className="mt-2 text-xs md:text-sm text-mist leading-relaxed">
                  Liquidations, funding, hourly candles, volume, and Polymarket
                  leadership all stream from Kiyotaka into the swarm. Each
                  agent votes; the scoreboard picks the champion; the champion
                  drives a paper Hyperliquid position — sized by Kelly, gated
                  by regime, certified by Probabilistic &amp; Deflated Sharpe.
                </p>
              </div>
            </div>

            {/* RIGHT — ticker, CTAs, stats. Fills the right half of
                the hero so it doesn't read as one wide column with a
                bare wall on the right. */}
            <div className="lg:col-span-5 space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <MarkTicker marks={marks} />
                <div className="flex items-center gap-3">
                  <Link
                    href="/tournament"
                    className="inline-flex items-center gap-1.5 chip chip-cyan hover:opacity-80 transition-opacity"
                  >
                    Open tournament →
                  </Link>
                  <Link
                    href="/performance"
                    className="text-[0.65rem] text-mist tracking-widest uppercase hover:text-slate-200"
                  >
                    Audit →
                  </Link>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:gap-3">
            <Stat
              label="365-day backtest"
              value={fmtUsd(STARTING_EQUITY)}
              sub={`→ ${fmtUsd(finalEquity, 0)}`}
              tone="cyan"
            />
            <Stat
              label="PnL"
              value={fmtUsd(pnl, 0)}
              sub={fmtPct(roi, 1)}
              tone={pnl >= 0 ? "pos" : "neg"}
            />
            <Stat
              label="Champion Σ R"
              value={
                champ
                  ? `${champ.total_r >= 0 ? "+" : ""}${champ.total_r.toFixed(1)}`
                  : "—"
              }
              sub={
                champ
                  ? `${(champ.win_rate * 100).toFixed(0)}% on ${champ.wins + champ.losses} trades`
                  : ""
              }
              tone={champ && champ.total_r >= 0 ? "pos" : "neg"}
            />
            <Stat
              label="Profit factor"
              value={
                champ?.profit_factor != null && Number.isFinite(champ.profit_factor)
                  ? champ.profit_factor.toFixed(2)
                  : "—"
              }
              sub={
                cert
                  ? `PSR ${cert.psr.toFixed(2)} · DSR ${cert.dsr.toFixed(2)}`
                  : ""
              }
              tone="cyan"
            />
              </div>
            </div>
          </div>

          {/* Equity curve */}
          {equity.length > 1 ? (
            <div className="mt-4 rounded-sm border border-edge/60 bg-black/30 p-3">
              <div className="flex items-center justify-between text-[0.65rem] uppercase tracking-widest text-mist mb-1.5">
                <span>Equity curve · 365d</span>
                <span className="num">
                  {equity.length.toLocaleString()} bars
                </span>
              </div>
              <MiniSpark points={equity} />
            </div>
          ) : null}
        </div>
      </section>

      {/* TradeSettings ⇄ AutoReplay — side-by-side at 3/9 split on
          desktop so the small input widget hugs the left edge while
          the demo loop fills the rest of the row. Stacks on mobile. */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 lg:gap-4 items-start">
        <div className="lg:col-span-3">
          <TradeSettingsPanel />
        </div>
        <div className="lg:col-span-9">
          <AutoReplay snap={snap} />
        </div>
      </div>

      {/* Champion + agent leaderboard */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
        <div className="panel p-4 lg:col-span-1">
          <div className="text-[0.65rem] uppercase tracking-[0.3em] text-mist mb-2">
            Current champion
          </div>
          {champ ? (
            <>
              <div className="font-mono text-slate-100 text-sm break-all">
                {champ.agent_id}
              </div>
              <div className="text-[0.65rem] text-mist mt-1">
                Family ·{" "}
                <span
                  className="font-mono uppercase"
                  style={{ color: FAMILY_COLORS[agentFamily(champ.agent_id)] }}
                >
                  {agentFamily(champ.agent_id)}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 mt-4 text-[0.7rem] num">
                <MiniMetric
                  label="Sharpe"
                  value={champ.rolling_sharpe.toFixed(2)}
                  tone={champ.rolling_sharpe > 0.4 ? "pos" : "neutral"}
                />
                <MiniMetric
                  label="E[R]"
                  value={
                    champ.expectancy_r != null
                      ? (champ.expectancy_r >= 0 ? "+" : "") +
                        champ.expectancy_r.toFixed(2)
                      : "—"
                  }
                  tone={(champ.expectancy_r ?? 0) >= 0 ? "pos" : "neg"}
                />
                <MiniMetric
                  label="Max DD"
                  value={
                    champ.max_drawdown_r != null
                      ? `-${champ.max_drawdown_r.toFixed(1)}R`
                      : "—"
                  }
                  tone="neg"
                />
                <MiniMetric
                  label="PSR"
                  value={cert ? cert.psr.toFixed(2) : "—"}
                  tone={cert && cert.psr >= 0.95 ? "pos" : "neutral"}
                />
                <MiniMetric
                  label="DSR"
                  value={cert ? cert.dsr.toFixed(2) : "—"}
                  tone={cert && cert.dsr >= 0.95 ? "pos" : "neutral"}
                />
                <MiniMetric
                  label="Trials"
                  value={cert ? String(cert.n_trials) : "—"}
                  tone="neutral"
                />
              </div>
              <div className="mt-4 text-[0.65rem] text-mist">
                Generation{" "}
                <span className="num text-slate-200">
                  {snap?.generation ?? 0}
                </span>{" "}
                · {families.length} active families
              </div>
            </>
          ) : (
            <div className="text-[0.75rem] text-mist">
              {snapErr
                ? `Snapshot error — ${snapErr}`
                : "Loading the latest swarm snapshot…"}
            </div>
          )}
        </div>

        <div className="panel p-4 lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[0.65rem] uppercase tracking-[0.3em] text-mist">
              Top 8 by Σ R
            </div>
            <Link
              href="/tournament"
              className="text-[0.65rem] text-cyan hover:underline"
            >
              Full leaderboard →
            </Link>
          </div>
          {snap && snap.agents.length > 0 ? (
            <PnlBars snap={snap} />
          ) : (
            <div className="text-[0.75rem] text-mist">
              No agents in snapshot.
            </div>
          )}
        </div>
      </section>

      {/* What you can do */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4">
        <ActionCard
          title="Run the tournament"
          body="Fire signals manually or let autopilot pull live BTC/ETH events from Kiyotaka. Watch the swarm vote, the champion fire, and a paper Hyperliquid order open with stop + TP."
          cta="Open tournament →"
          href="/tournament"
          accent="cyan"
        />
        <ActionCard
          title="Read the architecture"
          body="Six-layer system: Kiyotaka events → 27-agent swarm with self-backtest gate → Sharpe-weighted ensemble → quarter-Kelly sizing → meta-agent exits → evolved every N events. PSR/DSR/PBO certified."
          cta="View SWARM.md →"
          href="https://github.com/elysian-12/pythia-engine/blob/main/SWARM.md"
          accent="green"
        />
        <ActionCard
          title="See the trader's guide"
          body="Capital tiers, position sizing, kill-switch layers, the meta-agent's seven exit rules, drawdown playbook. Operator handbook before you put real capital behind it."
          cta="View TRADING_GUIDE.md →"
          href="https://github.com/elysian-12/pythia-engine/blob/main/TRADING_GUIDE.md"
          accent="amber"
        />
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: "pos" | "neg" | "cyan" | "neutral";
}) {
  const valueColor =
    tone === "pos"
      ? "text-green"
      : tone === "neg"
        ? "text-red"
        : tone === "cyan"
          ? "text-slate-100"
          : "text-slate-100";
  return (
    <div className="rounded-md border border-edge/60 bg-black/30 px-3 py-2.5">
      <div className="text-[0.6rem] uppercase tracking-widest text-mist">
        {label}
      </div>
      <div className={`mt-1 text-xl font-semibold num ${valueColor}`}>
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-[0.65rem] text-mist num">{sub}</div> : null}
    </div>
  );
}

function MiniMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "pos" | "neg" | "neutral";
}) {
  const c =
    tone === "pos" ? "text-green" : tone === "neg" ? "text-red" : "text-slate-100";
  return (
    <div className="rounded-sm border border-edge/60 bg-black/20 px-2 py-1">
      <div className="text-[0.55rem] uppercase tracking-widest text-mist">
        {label}
      </div>
      <div className={`text-sm ${c}`}>{value}</div>
    </div>
  );
}

function ActionCard({
  title,
  body,
  cta,
  href,
  accent,
}: {
  title: string;
  body: string;
  cta: string;
  href: string;
  accent: "cyan" | "green" | "amber";
}) {
  const ring =
    accent === "cyan"
      ? "hover:ring-cyan/40"
      : accent === "green"
        ? "hover:ring-green/40"
        : "hover:ring-amber/40";
  const ctaColor =
    accent === "cyan"
      ? "text-cyan"
      : accent === "green"
        ? "text-green"
        : "text-amber";
  return (
    <Link
      href={href}
      className={`panel p-4 block ring-1 ring-transparent ${ring} transition-all hover:bg-black/30`}
    >
      <div className="text-sm font-semibold text-slate-100">{title}</div>
      <p className="mt-2 text-xs text-mist leading-relaxed">{body}</p>
      <div className={`mt-4 text-[0.7rem] uppercase tracking-widest ${ctaColor}`}>
        {cta}
      </div>
    </Link>
  );
}
