"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchSwarm, agentFamily, FAMILY_COLORS, type AgentStats, type SwarmSnapshot } from "@/lib/swarm";

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

  return (
    <div className="space-y-6">
      <Header snap={snap} />
      <CertBlock snap={snap} />
      <FamilyRollup agents={snap.agents} />
      <TopAgentsScatter agents={snap.agents} />
      <RDistribution agents={snap.agents} />
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
    <section className="panel p-5 sm:p-6">
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="chip chip-cyan text-[0.6rem]">
          deployed snapshot
        </span>
        <span className="text-[0.65rem] tracking-[0.4em] text-purple-300 uppercase">
          gen {snap.generation ?? 0} · {snap.agents.length} agents
        </span>
      </div>
      <h2 className="mt-2 text-2xl sm:text-4xl font-semibold tracking-tight text-slate-100">
        {ch ? ch.agent_id : "—"}
      </h2>
      <p className="mt-1 text-xs text-mist max-w-3xl">
        Champion as of the bundled snapshot. The numbers below are
        what the deployed system has actually traded across {totalTrades.toLocaleString()}{" "}
        decisions, not a hypothetical backtest. Read{" "}
        <span className="text-cyan font-mono">/tournament</span> for live
        decisions; this page is the statistical audit.
      </p>
      {ch ? (
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm num">
          <Metric label="Σ R" value={`${ch.total_r >= 0 ? "+" : ""}${ch.total_r.toFixed(2)}`} tone={ch.total_r >= 0 ? "pos" : "neg"} />
          <Metric label="Win rate" value={`${(ch.win_rate * 100).toFixed(1)}%`} tone="neutral" />
          <Metric label="Trades" value={(ch.wins + ch.losses).toLocaleString()} tone="neutral" />
          <Metric label="E[R] / trade" value={`${(ch.expectancy_r ?? 0) >= 0 ? "+" : ""}${(ch.expectancy_r ?? 0).toFixed(3)}`} tone={(ch.expectancy_r ?? 0) >= 0 ? "pos" : "neg"} />
          <Metric label="Sharpe" value={ch.rolling_sharpe.toFixed(2)} tone={ch.rolling_sharpe >= 0.5 ? "pos" : ch.rolling_sharpe >= 0 ? "amber" : "neg"} />
        </div>
      ) : null}
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: "pos" | "neg" | "neutral" | "amber" }) {
  const color = tone === "pos" ? "text-green" : tone === "neg" ? "text-red" : tone === "amber" ? "text-amber" : "text-slate-100";
  return (
    <div className="rounded-sm border border-edge/60 bg-black/20 px-3 py-2">
      <div className="text-[0.6rem] uppercase tracking-wider text-mist">{label}</div>
      <div className={`mt-0.5 ${color}`}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function CertBlock({ snap }: { snap: SwarmSnapshot }) {
  const cert = snap.champion_certification;
  if (!cert) {
    // No formal cert block yet — surface the available raw signal
    // from the champion instead of a CLI command. The block-bootstrap
    // / PSR / DSR / PBO numbers need a richer R-history than the
    // current snapshot has logged. Show what we can: Sharpe,
    // expectancy, sample size.
    const champ = snap.champion;
    const trades = champ ? champ.wins + champ.losses : 0;
    return (
      <section className="panel p-5">
        <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
          <div className="text-xs uppercase tracking-[0.3em] text-mist">
            Certification
          </div>
          <div className="text-[0.6rem] text-amber uppercase tracking-[0.25em]">
            Pending
          </div>
        </div>
        <p className="text-xs text-slate-300 leading-relaxed mb-3">
          The champion needs a longer trade history before PSR / DSR /
          PBO / Sharpe-CI become meaningful. The hourly cron keeps
          adding trades — values populate automatically once the
          sample is large enough to bootstrap.
        </p>
        {champ ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm num">
            <CertCard
              label="Closed trades"
              value={trades.toString()}
              tone={trades >= 60 ? "pos" : trades >= 20 ? "amber" : "neutral"}
              help="Bootstrap-based PSR/DSR/PBO need ~60+ trades to be meaningful. Below 20 and they're statistically noisy."
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
          </div>
        ) : null}
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
    <section className="panel p-5 sm:p-6">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div className="text-xs uppercase tracking-[0.3em] text-mist">
          Statistical certification
        </div>
        <div className="text-[0.65rem] text-mist">
          Bailey & López de Prado — is the headline edge real, or
          could random noise have produced it?
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm num">
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
      className="rounded-sm border border-edge/60 bg-black/30 px-3 py-3 cursor-help"
      title={help}
    >
      <div className="text-[0.65rem] uppercase tracking-wider text-mist">{label}</div>
      <div className={`mt-1 text-2xl ${color}`}>{value}</div>
      <div className="mt-1 text-[0.6rem] text-mist line-clamp-2">{help}</div>
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
    <section className="panel p-5">
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
    <section className="panel p-5">
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
    <section className="panel p-5">
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
