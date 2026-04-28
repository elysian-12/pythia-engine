"use client";

import { useEffect, useMemo, useState } from "react";
import {
  fetchSwarm,
  agentFamily,
  FAMILY_COLORS,
  FAMILY_LABEL,
  type AgentStats,
  type SwarmSnapshot,
} from "@/lib/swarm";

// /performance — quant audit of the *deployed* swarm. Distinct from
// /tournament (live decision loop) and the landing page (marketing
// pitch). Answers the questions a quant asks before trusting the
// system: is the headline number statistically real, which families
// are pulling weight, is the trade distribution healthy, has the
// champion actually been evolving across generations?

export function PerformanceClient() {
  const [snap, setSnap] = useState<SwarmSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await fetchSwarm();
        if (!alive) return;
        setSnap(s);
        setErr(null);
      } catch (e) {
        if (!alive) return;
        setErr((e as Error).message);
      }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!snap) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-mist text-sm">
        {err ?? "Loading swarm snapshot…"}
      </div>
    );
  }

  // Performance page = quant audit, optimised to fit one viewport on
  // a typical laptop (1280-1920px). Header is a single compact strip;
  // the four analytic sections sit in a 12-col grid with 7/5 and 5/7
  // splits so cards stay readable rather than stretched on wide
  // monitors. Mobile collapses to single col via grid-cols-1.
  return (
    <div className="max-w-[110rem] mx-auto space-y-3 sm:space-y-4">
      <Header snap={snap} />
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 sm:gap-4 items-stretch">
        <div className="lg:col-span-7">
          <CertBlock snap={snap} />
        </div>
        <div className="lg:col-span-5">
          <FamilyRollup agents={snap.agents} />
        </div>
        <div className="lg:col-span-5">
          <TopAgentsScatter agents={snap.agents} />
        </div>
        <div className="lg:col-span-7">
          <RDistribution agents={snap.agents} />
        </div>
      </div>
      <FamilyPlaybook agents={snap.agents} />
      <ProvenanceFooter snap={snap} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function Header({ snap }: { snap: SwarmSnapshot }) {
  const ch = snap.champion;
  const totalTrades = snap.agents.reduce(
    (a, x) => a + x.wins + x.losses,
    0,
  );
  return (
    <section className="panel p-3 sm:p-4 h-full flex flex-col">
      <div className="flex items-baseline gap-3 flex-wrap mb-1.5">
        <span className="chip chip-cyan text-[0.6rem]">
          deployed snapshot
        </span>
        <span className="text-[0.65rem] tracking-[0.4em] text-purple-300 uppercase">
          gen {snap.generation ?? 0} · {snap.agents.length} agents
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="text-lg sm:text-2xl font-semibold tracking-tight text-slate-100">
          {ch ? ch.agent_id : "—"}
        </h2>
        {ch ? (
          <div className="flex items-baseline gap-3 sm:gap-4 flex-wrap text-xs num">
            <InlineMetric
              label="Σ R"
              value={`${ch.total_r >= 0 ? "+" : ""}${ch.total_r.toFixed(2)}`}
              tone={ch.total_r >= 0 ? "pos" : "neg"}
            />
            <InlineMetric
              label="WR"
              value={`${(ch.win_rate * 100).toFixed(1)}%`}
              tone="neutral"
            />
            <InlineMetric
              label="Trades"
              value={(ch.wins + ch.losses).toLocaleString()}
              tone="neutral"
            />
            <InlineMetric
              label="E[R]"
              value={`${(ch.expectancy_r ?? 0) >= 0 ? "+" : ""}${(ch.expectancy_r ?? 0).toFixed(3)}`}
              tone={(ch.expectancy_r ?? 0) >= 0 ? "pos" : "neg"}
            />
            <InlineMetric
              label="Sharpe"
              value={ch.rolling_sharpe.toFixed(2)}
              tone={
                ch.rolling_sharpe >= 0.5
                  ? "pos"
                  : ch.rolling_sharpe >= 0
                    ? "amber"
                    : "neg"
              }
            />
          </div>
        ) : null}
      </div>
      <p className="mt-2 text-[0.7rem] text-mist max-w-3xl">
        Champion as of the bundled snapshot. The numbers above are
        what the deployed system has actually traded across {totalTrades.toLocaleString()}{" "}
        decisions, not a hypothetical backtest. Read{" "}
        <span className="text-cyan font-mono">/tournament</span> for live
        decisions; this page is the statistical audit.
      </p>
    </section>
  );
}

function InlineMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "pos" | "neg" | "neutral" | "amber";
}) {
  const color =
    tone === "pos"
      ? "text-green"
      : tone === "neg"
        ? "text-red"
        : tone === "amber"
          ? "text-amber"
          : "text-slate-100";
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-[0.65rem] uppercase tracking-wider text-mist">
        {label}
      </span>
      <span className={`text-base font-semibold ${color}`}>{value}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------

function CertBlock({ snap }: { snap: SwarmSnapshot }) {
  const cert = snap.champion_certification;
  if (!cert) {
    // No formal cert block yet. Reframe as "Track record" — the
    // champion's sample size + raw Sharpe + Σ R are all real and
    // meaningful right now; PSR / DSR / PBO just need a richer
    // R-history before block-bootstrap can give a confident answer.
    // Visual centerpiece is a progress bar toward the 60-trade
    // threshold so the user sees this is accumulating rather than
    // stuck.
    const champ = snap.champion;
    const trades = champ ? champ.wins + champ.losses : 0;
    const CERT_THRESHOLD = 60;
    const pct = Math.min(100, (trades / CERT_THRESHOLD) * 100);
    return (
      <section className="panel p-3 sm:p-4 h-full flex flex-col">
        <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
          <div className="text-xs uppercase tracking-[0.3em] text-mist">
            Track record
          </div>
          <div className="text-[0.6rem] text-mist">
            Cert activates after ~{CERT_THRESHOLD} trades
          </div>
        </div>

        {champ ? (
          <>
            {/* Progress bar — concrete signal of how close the
                champion is to a meaningful PSR/DSR. */}
            <div className="mt-4 mb-5">
              <div className="flex items-baseline justify-between mb-1.5 text-[0.7rem]">
                <span className="text-mist uppercase tracking-[0.2em]">
                  Sample size
                </span>
                <span className="num text-slate-100">
                  {trades}
                  <span className="text-mist"> / {CERT_THRESHOLD}</span>
                </span>
              </div>
              <div
                className="h-1.5 bg-edge/40 rounded-full overflow-hidden"
                role="progressbar"
                aria-valuenow={trades}
                aria-valuemin={0}
                aria-valuemax={CERT_THRESHOLD}
              >
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${pct}%`,
                    background:
                      pct >= 100
                        ? "#22c55e"
                        : "linear-gradient(90deg, #06b6d4, #f59e0b)",
                  }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm num">
              <CertCard
                label="Closed trades"
                value={trades.toString()}
                tone={
                  trades >= CERT_THRESHOLD
                    ? "pos"
                    : trades >= 20
                      ? "amber"
                      : "neutral"
                }
                help={`Bootstrap-based PSR/DSR/PBO need ~${CERT_THRESHOLD}+ trades to be meaningful. Below 20 and they're statistically noisy.`}
              />
              <CertCard
                label="Σ R"
                value={`${champ.total_r >= 0 ? "+" : ""}${champ.total_r.toFixed(2)}`}
                tone={champ.total_r >= 0 ? "pos" : "neg"}
                help="Cumulative R-multiple — total profit measured in units of risk."
              />
              <CertCard
                label="Sharpe (raw)"
                value={champ.rolling_sharpe.toFixed(2)}
                tone={
                  champ.rolling_sharpe > 0.5
                    ? "pos"
                    : champ.rolling_sharpe > 0
                      ? "amber"
                      : "neg"
                }
                help="Rolling Sharpe of per-trade R. Becomes a certified PSR/DSR once the trade history supports a block-bootstrap CI."
              />
              <CertCard
                label="E[R] / trade"
                value={`${(champ.expectancy_r ?? 0) >= 0 ? "+" : ""}${(champ.expectancy_r ?? 0).toFixed(3)}`}
                tone={(champ.expectancy_r ?? 0) >= 0 ? "pos" : "neg"}
                help="Expectancy — average R-multiple per trade. > 0 means each trade is positive in expectation."
              />
              <CertCard
                label="Profit factor"
                value={
                  champ.profit_factor != null && Number.isFinite(champ.profit_factor)
                    ? champ.profit_factor.toFixed(2)
                    : "—"
                }
                tone={
                  (champ.profit_factor ?? 0) >= 1.5
                    ? "pos"
                    : (champ.profit_factor ?? 0) >= 1
                      ? "amber"
                      : "neg"
                }
                help="Gross win R / gross loss R. ≥ 1.5 is the systematic-strategy bar."
              />
              <CertCard
                label="Max drawdown"
                value={
                  champ.max_drawdown_r != null
                    ? `-${champ.max_drawdown_r.toFixed(2)}R`
                    : "—"
                }
                tone={
                  champ.max_drawdown_r != null && champ.max_drawdown_r < 5
                    ? "pos"
                    : champ.max_drawdown_r != null && champ.max_drawdown_r < 10
                      ? "amber"
                      : "neg"
                }
                help="Largest peak-to-trough drop in cumulative R. Measures how deep the system went underwater before recovering."
              />
            </div>
          </>
        ) : (
          <p className="text-xs text-mist leading-relaxed">
            No champion in this snapshot yet — once the swarm logs its
            first generation, the track record starts accumulating.
          </p>
        )}
      </section>
    );
  }
  const psrTone = cert.psr >= 0.95 ? "pos" : cert.psr >= 0.5 ? "amber" : "neg";
  const dsrTone = cert.dsr >= 0.95 ? "pos" : cert.dsr >= 0.5 ? "amber" : "neg";
  const pboTone =
    cert.pbo == null
      ? "neutral"
      : cert.pbo < 0.3
        ? "pos"
        : cert.pbo < 0.5
          ? "amber"
          : "neg";
  const ciCleared =
    cert.sharpe_ci_lo != null && cert.sharpe_ci_lo > 0;
  return (
    <section className="panel p-3 sm:p-4 h-full flex flex-col">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div className="text-xs uppercase tracking-[0.3em] text-mist">
          Statistical certification
        </div>
        <div className="text-[0.6rem] text-mist">
          Bailey &amp; López de Prado — is the edge real?
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm num">
        <CertCard
          label="PSR"
          value={cert.psr.toFixed(3)}
          tone={psrTone}
          help={`Probabilistic Sharpe Ratio — probability the *true* Sharpe is positive given sample size, skew, kurtosis. > 0.95 is the conventional "edge is real" threshold.`}
        />
        <CertCard
          label="DSR"
          value={cert.dsr.toFixed(3)}
          tone={dsrTone}
          help="Deflated Sharpe Ratio — PSR after correcting for multi-testing bias across the swarm. > 0.95 means the champion's edge survives picking the best of N agents."
        />
        <CertCard
          label="PBO"
          value={cert.pbo != null ? cert.pbo.toFixed(2) : "—"}
          tone={pboTone}
          help="Probability of Backtest Overfitting. Lower is better; < 0.5 = winning config generalises out-of-sample more than half the time."
        />
        <CertCard
          label="Sharpe 95% CI"
          value={
            cert.sharpe_ci_lo != null && cert.sharpe_ci_hi != null
              ? `${cert.sharpe_ci_lo.toFixed(2)} – ${cert.sharpe_ci_hi.toFixed(2)}`
              : "—"
          }
          tone={ciCleared ? "pos" : "amber"}
          help="Block-bootstrap (block size 7) on the champion's R-history. Lower bound > 0 = edge is robust to resampling."
        />
      </div>
      <div className="mt-3 text-[0.65rem] text-mist max-w-3xl">
        {ciCleared ? (
          <>
            ✓ Lower CI cleared zero — the Sharpe doesn't depend on a
            handful of lucky trades.
          </>
        ) : (
          <>
            Lower CI hasn't cleared zero yet. Either the trade sample
            is still small, or the edge isn't robust to resampling.
            Wait for more trades or treat the headline Sharpe with
            caution.
          </>
        )}{" "}
        {cert.skew != null && cert.kurtosis != null
          ? `Distribution: skew ${cert.skew.toFixed(2)}, kurtosis ${cert.kurtosis.toFixed(2)} (Gaussian = 0/0; negative skew + high kurt = fat-left-tail risk).`
          : null}
      </div>
    </section>
  );
}

function CertCard({ label, value, tone, help }: { label: string; value: string; tone: "pos" | "neg" | "neutral" | "amber"; help: string }) {
  const color = tone === "pos" ? "text-green" : tone === "neg" ? "text-red" : tone === "amber" ? "text-amber" : "text-slate-100";
  return (
    <div
      className="rounded-sm border border-edge/60 bg-black/30 px-3 py-2 cursor-help"
      title={help}
    >
      <div className="text-[0.6rem] uppercase tracking-wider text-mist">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold ${color}`}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function FamilyRollup({ agents }: { agents: AgentStats[] }) {
  const fams = useMemo(() => {
    const m = new Map<string, { count: number; trades: number; r: number; sharpeWeighted: number }>();
    for (const a of agents) {
      const f = agentFamily(a.agent_id);
      const cur = m.get(f) ?? { count: 0, trades: 0, r: 0, sharpeWeighted: 0 };
      cur.count++;
      cur.trades += a.wins + a.losses;
      cur.r += a.total_r;
      cur.sharpeWeighted += a.rolling_sharpe * (a.wins + a.losses);
      m.set(f, cur);
    }
    const entries = Array.from(m.entries()).map(([k, v]) => ({
      family: k,
      count: v.count,
      trades: v.trades,
      r: v.r,
      avgSharpe: v.trades > 0 ? v.sharpeWeighted / v.trades : 0,
    }));
    entries.sort((a, b) => b.r - a.r);
    return entries;
  }, [agents]);
  const maxR = Math.max(1, ...fams.map((f) => Math.abs(f.r)));
  return (
    <section className="panel p-3 sm:p-4 h-full flex flex-col">
      <div className="text-xs uppercase tracking-[0.3em] text-mist mb-1">
        Per-family contribution
      </div>
      <p className="text-[0.65rem] text-mist mb-4 max-w-2xl">
        Σ R rolled up by rule family. Multi-family profitability is the
        signal that evolution is genuinely surfacing edge, not just
        crowding into one strategy. A monoculture would show vol-breakout
        with everyone else flat.
      </p>
      <div className="space-y-2">
        {fams.map((f) => {
          const color = (FAMILY_COLORS as Record<string, string>)[f.family] ?? "#94a3b8";
          const widthPct = Math.max(2, (Math.abs(f.r) / maxR) * 100);
          const bgColor = f.r >= 0 ? color : "#f87171";
          return (
            <div key={f.family} className="grid grid-cols-12 gap-3 items-center text-xs num">
              <div className="col-span-3 font-mono text-slate-200 flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} />
                {f.family}
              </div>
              <div className="col-span-1 text-right text-mist">{f.count}</div>
              <div className="col-span-2 text-right text-mist">{f.trades.toLocaleString()}</div>
              <div className="col-span-1 text-right text-mist">{f.avgSharpe.toFixed(2)}</div>
              <div className="col-span-3 relative h-3 bg-black/30 rounded-sm overflow-hidden">
                <div
                  className="absolute top-0 left-0 h-full rounded-sm"
                  style={{ width: `${widthPct}%`, background: bgColor, boxShadow: `0 0 8px ${bgColor}` }}
                />
              </div>
              <div className={`col-span-2 text-right ${f.r >= 0 ? "text-green" : "text-red"}`}>
                {f.r >= 0 ? "+" : ""}{f.r.toFixed(2)}
              </div>
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-12 gap-3 text-[0.6rem] text-mist uppercase tracking-wider mt-2 pt-2 border-t border-edge/40">
        <div className="col-span-3">family</div>
        <div className="col-span-1 text-right">seats</div>
        <div className="col-span-2 text-right">trades</div>
        <div className="col-span-1 text-right">avg Sharpe</div>
        <div className="col-span-3"></div>
        <div className="col-span-2 text-right">Σ R</div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function TopAgentsScatter({ agents }: { agents: AgentStats[] }) {
  // Plot Win-rate (x) × Sharpe (y), bubble sized by trade count.
  // The classic quant scatter — "where do my agents live in
  // skill-vs-luck space?" Outliers in the top-right quadrant are the
  // genuine survivors; bottom-left is dead weight.
  const eligible = agents
    .filter((a) => a.wins + a.losses >= 10)
    .sort((a, b) => b.total_r - a.total_r)
    .slice(0, 24);
  if (eligible.length === 0) {
    return null;
  }
  const maxTrades = Math.max(...eligible.map((a) => a.wins + a.losses));
  return (
    <section className="panel p-3 sm:p-4 h-full flex flex-col">
      <div className="text-xs uppercase tracking-[0.3em] text-mist mb-1">
        Top 24 agents · skill scatter
      </div>
      <p className="text-[0.65rem] text-mist mb-4 max-w-2xl">
        Each bubble is one agent. Horizontal = win rate; vertical =
        Sharpe; size = trade count. Healthy populations cluster top-right
        (high WR, high Sharpe, large bubble). Bottom-left = unprofitable.
      </p>
      <div className="relative h-[280px] sm:h-[340px] border border-edge/40 rounded-sm bg-black/20">
        {/* Axes guide lines */}
        <div className="absolute inset-x-0 top-1/2 border-t border-edge/30 border-dashed" />
        <div className="absolute inset-y-0 left-1/2 border-l border-edge/30 border-dashed" />
        {/* Labels */}
        <div className="absolute bottom-1 left-1 text-[0.55rem] text-mist">0.30 WR</div>
        <div className="absolute bottom-1 right-1 text-[0.55rem] text-mist">0.80 WR</div>
        <div className="absolute top-1 left-1 text-[0.55rem] text-mist">Sharpe 1.2</div>
        <div className="absolute bottom-1 left-1/2 translate-x-2 text-[0.55rem] text-mist">0.55 WR</div>
        {/* Bubbles */}
        {eligible.map((a) => {
          const wr = a.win_rate;
          const sh = a.rolling_sharpe;
          const x = ((wr - 0.30) / 0.50) * 100; // 30% .. 80%
          const y = 100 - ((sh + 0.4) / 1.6) * 100; // -0.4 .. 1.2 → top to bottom
          const size = 8 + ((a.wins + a.losses) / maxTrades) * 28;
          const fam = agentFamily(a.agent_id);
          const color = (FAMILY_COLORS as Record<string, string>)[fam] ?? "#94a3b8";
          return (
            <div
              key={a.agent_id}
              className="absolute rounded-full cursor-help"
              style={{
                left: `calc(${Math.min(95, Math.max(2, x))}% - ${size / 2}px)`,
                top: `calc(${Math.min(95, Math.max(2, y))}% - ${size / 2}px)`,
                width: size,
                height: size,
                background: color,
                opacity: 0.65,
                boxShadow: `0 0 8px ${color}`,
              }}
              title={`${a.agent_id}\nWR ${(wr * 100).toFixed(1)}% · Sharpe ${sh.toFixed(2)} · trades ${a.wins + a.losses} · Σ R ${a.total_r.toFixed(2)}`}
            />
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function RDistribution({ agents }: { agents: AgentStats[] }) {
  // The R-multiple distribution shape is the single most diagnostic
  // chart for systematic strategies. Healthy expectancy = right-skewed
  // (occasional big wins, many small losses). Negative-skew + fat
  // left tail = blow-up risk masked by a string of small wins.
  // Without per-trade r_history in the snapshot we approximate with
  // the gross_win_r / gross_loss_r split on each agent.
  const rows = agents
    .filter((a) => a.wins + a.losses >= 10)
    .sort((a, b) => b.total_r - a.total_r)
    .slice(0, 12);
  if (rows.length === 0) return null;
  return (
    <section className="panel p-3 sm:p-4 h-full flex flex-col">
      <div className="text-xs uppercase tracking-[0.3em] text-mist mb-1">
        Win/loss R balance · top 12
      </div>
      <p className="text-[0.65rem] text-mist mb-4 max-w-2xl">
        Each row: green = Σ winning R, red = Σ losing R. A healthy agent
        shows green ≫ red even when win rate is below 50% (asymmetric
        payoff). Profit-factor ≥ 1.5 is the systematic-strategy bar.
      </p>
      <div className="space-y-1.5 text-[0.7rem] num">
        {rows.map((a) => {
          const win = a.gross_win_r ?? 0;
          const loss = Math.abs(a.gross_loss_r ?? 0);
          const total = win + loss;
          const winPct = total > 0 ? (win / total) * 100 : 50;
          const pf = a.profit_factor ?? 0;
          const pfTone = pf >= 1.5 ? "text-green" : pf >= 1 ? "text-amber" : "text-red";
          return (
            <div key={a.agent_id} className="grid grid-cols-12 gap-2 items-center">
              <div className="col-span-4 font-mono text-slate-200 truncate">{a.agent_id.replace(/^gen\d+-mut\d+-/, "")}</div>
              <div className="col-span-6 flex items-center h-3 rounded-sm overflow-hidden bg-edge/30">
                <div
                  className="h-full bg-green/70"
                  style={{ width: `${winPct}%` }}
                />
                <div
                  className="h-full bg-red/70"
                  style={{ width: `${100 - winPct}%` }}
                />
              </div>
              <div className={`col-span-1 text-right ${pfTone}`}>
                {Number.isFinite(pf) ? pf.toFixed(2) : "—"}
              </div>
              <div className="col-span-1 text-right text-mist">
                {a.total_r >= 0 ? "+" : ""}{a.total_r.toFixed(1)}
              </div>
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-12 gap-2 text-[0.6rem] text-mist uppercase tracking-wider mt-2 pt-2 border-t border-edge/40">
        <div className="col-span-4">agent</div>
        <div className="col-span-6">win R · loss R</div>
        <div className="col-span-1 text-right">PF</div>
        <div className="col-span-1 text-right">Σ R</div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

// Plain-English description of what each rule family is hunting.
// Pairs with FAMILY_LABEL (the short tagline) and FAMILY_COLORS in
// lib/swarm.ts. Updated when the swarm gets new families.
const FAMILY_DESCRIPTION: Record<string, string> = {
  "liq-trend":
    "Forced-liquidation cascades push price hard in the flow direction. liq-trend rides the cascade — long when shorts get wiped, short when longs do — and scales out as momentum fades.",
  "liq-fade":
    "Once a cascade exhausts its forced sellers, price overshoots fair value. liq-fade fades the spike: short the panic top, long the panic flush. Mean-reversion against forced flow.",
  "vol-breakout":
    "Donchian-channel breakouts of the recent N-bar high or low signal a genuine regime shift. vol-breakout enters on the close beyond the channel and rides the new volatility regime.",
  "funding-trend":
    "Persistent positive funding means longs are paying shorts to stay in — overcrowded long positioning that often mean-reverts. funding-trend rides the prevailing funding sign on perps.",
  "funding-arb":
    "Fades extreme funding prints. Spike to +0.05% per 8 h? Step the other side and harvest the convergence as funding decays back toward zero.",
  polyedge:
    "Polymarket prediction-market prices often lead spot by 60–300 s on event-bound contracts. polyedge reads the SWP-mid gap and trades the directional implication on perps before spot catches up.",
  polyfusion:
    "The strictest, lowest-frequency setup. Requires a liquidation cascade, a funding extreme, and a Polymarket lead all aligned before firing. Highest conviction, fewest entries.",
  llm: "LLM personas reasoning in plain English — five distinct dispositions (cautious risk manager, momentum chaser, contrarian fader, degen scalper, macro ranger). Their disagreements feed the ensemble vote.",
  other: "Catch-all for any agents not yet classified into a named family.",
};

const FAMILY_ORDER = [
  "liq-trend",
  "liq-fade",
  "vol-breakout",
  "funding-trend",
  "funding-arb",
  "polyedge",
  "polyfusion",
  "llm",
] as const;

function FamilyPlaybook({ agents }: { agents: AgentStats[] }) {
  const stats = useMemo(() => {
    const m = new Map<
      string,
      { count: number; trades: number; r: number; sharpeNum: number }
    >();
    for (const a of agents) {
      const f = agentFamily(a.agent_id);
      const cur = m.get(f) ?? { count: 0, trades: 0, r: 0, sharpeNum: 0 };
      const t = a.wins + a.losses;
      cur.count += 1;
      cur.trades += t;
      cur.r += a.total_r;
      cur.sharpeNum += a.rolling_sharpe * t;
      m.set(f, cur);
    }
    const out: Record<
      string,
      { count: number; trades: number; r: number; sharpe: number }
    > = {};
    for (const [k, v] of m) {
      out[k] = {
        count: v.count,
        trades: v.trades,
        r: v.r,
        sharpe: v.trades > 0 ? v.sharpeNum / v.trades : 0,
      };
    }
    return out;
  }, [agents]);

  return (
    <section className="panel p-3 sm:p-4 w-full">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div className="text-xs uppercase tracking-[0.3em] text-mist">
          Agent family playbook
        </div>
        <div className="text-[0.6rem] text-mist">
          What each rule family is hunting · live counts from the snapshot
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {FAMILY_ORDER.map((f) => {
          const hex = (FAMILY_COLORS as Record<string, string>)[f] ?? "#94a3b8";
          const label = FAMILY_LABEL[f];
          const desc = FAMILY_DESCRIPTION[f] ?? "";
          const s = stats[f];
          const rTone =
            !s
              ? "text-mist"
              : s.r > 0
                ? "text-green"
                : s.r < 0
                  ? "text-red"
                  : "text-mist";
          return (
            <div
              key={f}
              className="rounded-sm border border-edge/60 bg-black/20 p-3 flex flex-col gap-2"
            >
              <div className="flex items-baseline gap-2">
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ background: hex, boxShadow: `0 0 6px ${hex}` }}
                />
                <span className="font-mono uppercase tracking-widest text-[0.65rem] text-slate-100">
                  {f}
                </span>
                <span className="text-[0.55rem] text-mist num ml-auto">
                  {s ? `${s.count} agents` : "—"}
                </span>
              </div>
              <div className="text-[0.6rem] uppercase tracking-wider text-amber/80 leading-snug">
                {label}
              </div>
              <p className="text-[0.7rem] text-slate-300 leading-relaxed flex-1">
                {desc}
              </p>
              <div className="grid grid-cols-3 gap-2 text-[0.6rem] num pt-1.5 border-t border-edge/40">
                <span>
                  <span className="text-mist">Σ R</span>{" "}
                  <span className={rTone}>
                    {s
                      ? `${s.r >= 0 ? "+" : ""}${s.r.toFixed(0)}`
                      : "—"}
                  </span>
                </span>
                <span>
                  <span className="text-mist">trades</span>{" "}
                  <span className="text-slate-200">
                    {s ? s.trades.toLocaleString() : "—"}
                  </span>
                </span>
                <span>
                  <span className="text-mist">Sharpe</span>{" "}
                  <span className="text-slate-200">
                    {s && s.trades > 0 ? s.sharpe.toFixed(2) : "—"}
                  </span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function ProvenanceFooter({ snap }: { snap: SwarmSnapshot }) {
  const dt = snap.generated_at
    ? new Date(snap.generated_at * 1000).toISOString().replace("T", " ").slice(0, 19)
    : "—";
  return (
    <section className="text-[0.65rem] text-mist py-4 px-2 flex flex-wrap items-center gap-x-4 gap-y-1">
      <span>source: <span className="font-mono">{snap.source ?? "?"}</span></span>
      <span>generated: <span className="num">{dt} UTC</span></span>
      <span>regime: <span className="font-mono">{snap.regime?.label ?? "—"}</span></span>
      <span className="grow" />
      <span>
        Live decisions →{" "}
        <a className="text-cyan hover:underline" href="/tournament">/tournament</a>
      </span>
    </section>
  );
}
