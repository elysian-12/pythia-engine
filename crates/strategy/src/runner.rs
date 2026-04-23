//! Ablation runner.
//!
//! For each variant, replay the same data through `backtest::run`, collect
//! per-trade returns, and score on DSR, Sharpe, profit factor, PnL.
//! Produces a ranked comparison report.

use backtest::{run, ForwardData};
use evaluation::{
    block_bootstrap_sharpe, deflated_sharpe_ratio, probabilistic_sharpe_ratio,
    probability_of_backtest_overfitting, LatencyCollector, LatencyReport,
};
use reports::BacktestReport;
use serde::{Deserialize, Serialize};
use signal_engine::MarketState;
use std::fmt::Write as _;
use std::time::Instant;

use crate::registry::StrategyVariant;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AblationRow {
    pub name: String,
    pub backtest: BacktestReport,
    pub psr_vs_zero: f64,
    pub dsr_after_selection: f64,
    pub sharpe_ci_lo: f64,
    pub sharpe_ci_hi: f64,
    pub sharpe_ci_median: f64,
    pub score: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AblationReport {
    pub rows: Vec<AblationRow>,
    pub winner: Option<String>,
    pub pbo: f64,
    pub n_strategies: usize,
    pub runtime: LatencyReport,
}

const MIN_TRADES_FOR_RANKING: usize = 10;

pub fn run_ablation(
    states: &[MarketState],
    forward: &ForwardData,
    variants: &[StrategyVariant],
) -> AblationReport {
    let latency = LatencyCollector::new();
    let wall_start = Instant::now();

    let mut rows: Vec<AblationRow> = Vec::with_capacity(variants.len());
    let mut returns_matrix: Vec<Vec<f64>> = Vec::with_capacity(variants.len());

    for v in variants {
        let _span = latency.span(format!("backtest:{}", v.name));
        let bt = run(&v.name, states, forward, &v.signal, &v.trader);
        let per_trade_r = trade_returns(&bt);
        returns_matrix.push(per_trade_r.clone());

        let psr = probabilistic_sharpe_ratio(&per_trade_r, 0.0);
        let ci = block_bootstrap_sharpe(&per_trade_r, 500, 4.0, 0.95, 42);

        rows.push(AblationRow {
            name: v.name.clone(),
            backtest: bt,
            psr_vs_zero: psr.psr,
            dsr_after_selection: 0.0, // filled below
            sharpe_ci_lo: ci.lo,
            sharpe_ci_hi: ci.hi,
            sharpe_ci_median: ci.median,
            score: 0.0, // filled below
        });
    }

    // Deflated Sharpe with selection correction.
    let sharpes: Vec<f64> = rows.iter().map(|r| r.backtest.main.sharpe).collect();
    for row in &mut rows {
        let per_trade = trade_returns(&row.backtest);
        let dsr = deflated_sharpe_ratio(&per_trade, &sharpes).psr;
        row.dsr_after_selection = dsr;
        let sign = row.backtest.main.expectancy_r.signum();
        let penalty = if row.backtest.main.n_trades < MIN_TRADES_FOR_RANKING {
            0.0
        } else {
            1.0
        };
        row.score = dsr * sign * penalty;
    }

    // Rank by score descending.
    rows.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let winner = rows
        .iter()
        .find(|r| r.backtest.main.n_trades >= MIN_TRADES_FOR_RANKING)
        .map(|r| r.name.clone());

    // PBO across strategies — only computed if every strategy has >= S*chunk rows.
    let pbo = if returns_matrix
        .iter()
        .all(|r| r.len() >= 16)
    {
        // Normalise to equal length.
        let min_len = returns_matrix.iter().map(|r| r.len()).min().unwrap_or(0);
        let trimmed: Vec<Vec<f64>> = returns_matrix
            .iter()
            .map(|r| r.iter().take(min_len).copied().collect())
            .collect();
        probability_of_backtest_overfitting(&trimmed, 8).pbo
    } else {
        0.5
    };

    let wall_ns = wall_start.elapsed().as_nanos() as u64;
    let runtime = latency.report(wall_ns);

    AblationReport {
        rows,
        winner,
        pbo,
        n_strategies: variants.len(),
        runtime,
    }
}

fn trade_returns(bt: &BacktestReport) -> Vec<f64> {
    bt.equity_curve
        .windows(2)
        .map(|w| (w[1].1 - w[0].1) / 10_000.0)
        .collect()
}

#[allow(dead_code)]
fn format_pct(x: f64) -> String {
    format!("{:.2}%", x * 100.0)
}

impl AblationReport {
    pub fn render_markdown(&self) -> String {
        let mut s = String::from("# Ablation report\n\n");
        let _ = writeln!(
            s,
            "- Strategies: **{}**",
            self.n_strategies
        );
        if let Some(w) = &self.winner {
            let _ = writeln!(s, "- Winner: **`{}`**", w);
        }
        let _ = writeln!(s, "- PBO (Prob. backtest overfitting): **{:.2}**", self.pbo);
        let _ = writeln!(
            s,
            "- Wall-clock: {:.2} ms",
            (self.runtime.wall_clock_ns as f64) / 1e6
        );
        let _ = writeln!(s, "\n## Ranking\n");
        let _ = writeln!(
            s,
            "| # | Strategy | Trades | PnL | Sharpe | PF | MaxDD | PSR | DSR | Sharpe 95% CI | Score |"
        );
        let _ = writeln!(s, "|---|---|---|---|---|---|---|---|---|---|---|");
        for (i, r) in self.rows.iter().enumerate() {
            let _ = writeln!(
                s,
                "| {} | `{}` | {} | {:+.0} | {:.2} | {:.2} | {:.1}% | {:.2} | {:.2} | [{:.2}, {:.2}] | {:+.3} |",
                i + 1,
                r.name,
                r.backtest.main.n_trades,
                r.backtest.main.total_pnl_usd,
                r.backtest.main.sharpe,
                r.backtest.main.profit_factor,
                r.backtest.main.max_drawdown * 100.0,
                r.psr_vs_zero,
                r.dsr_after_selection,
                r.sharpe_ci_lo,
                r.sharpe_ci_hi,
                r.score
            );
        }
        let _ = writeln!(s, "\n## Runtime by phase\n");
        let _ = writeln!(s, "| Phase | N | Total | Mean | P50 | P95 | P99 | Max |");
        let _ = writeln!(s, "|---|---|---|---|---|---|---|---|");
        for p in &self.runtime.phases {
            let _ = writeln!(
                s,
                "| {} | {} | {:.3}ms | {:.1}µs | {:.1}µs | {:.1}µs | {:.1}µs | {:.1}µs |",
                p.phase,
                p.count,
                (p.total_ns as f64) / 1e6,
                (p.mean_ns as f64) / 1e3,
                (p.p50_ns as f64) / 1e3,
                (p.p95_ns as f64) / 1e3,
                (p.p99_ns as f64) / 1e3,
                (p.max_ns as f64) / 1e3,
            );
        }
        s
    }
}
