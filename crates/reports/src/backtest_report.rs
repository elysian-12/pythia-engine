//! Backtest report: risk metrics + equity curve + ablation table.

use serde::{Deserialize, Serialize};
use std::fmt::Write as _;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RiskMetrics {
    pub n_trades: usize,
    pub win_rate: f64,
    pub profit_factor: f64,
    pub sharpe: f64,
    pub sortino: f64,
    pub max_drawdown: f64,
    pub calmar: f64,
    pub expectancy_r: f64,
    pub avg_r: f64,
    pub total_pnl_usd: f64,
    pub mean_hold_s: f64,
    pub median_r: f64,
    pub positive_r: usize,
    pub negative_r: usize,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Ablation {
    pub label: String,
    pub metrics: RiskMetrics,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BacktestReport {
    pub name: String,
    pub start_ts: i64,
    pub end_ts: i64,
    pub config_hash: String,
    pub main: RiskMetrics,
    pub ablations: Vec<Ablation>,
    pub equity_curve: Vec<(i64, f64)>,
    pub r_histogram: Vec<(f64, usize)>,
}

impl BacktestReport {
    pub fn render_markdown(&self) -> String {
        let mut s = String::new();
        let _ = writeln!(s, "# Backtest — {}\n", self.name);
        let _ = writeln!(
            s,
            "- Window: {} → {}",
            fmt_ts(self.start_ts),
            fmt_ts(self.end_ts)
        );
        let _ = writeln!(s, "- Config hash: `{}`", self.config_hash);
        let _ = writeln!(s, "\n## Metrics\n");
        let _ = writeln!(s, "| Metric | Value |");
        let _ = writeln!(s, "|---|---|");
        let _ = writeln!(s, "| Trades | {} |", self.main.n_trades);
        let _ = writeln!(s, "| Win rate | {:.2}% |", self.main.win_rate * 100.0);
        let _ = writeln!(s, "| Profit factor | {:.2} |", self.main.profit_factor);
        let _ = writeln!(s, "| Sharpe | {:.2} |", self.main.sharpe);
        let _ = writeln!(s, "| Sortino | {:.2} |", self.main.sortino);
        let _ = writeln!(s, "| Max drawdown | {:.2}% |", self.main.max_drawdown * 100.0);
        let _ = writeln!(s, "| Calmar | {:.2} |", self.main.calmar);
        let _ = writeln!(s, "| Expectancy (R) | {:.3} |", self.main.expectancy_r);
        let _ = writeln!(s, "| Avg R | {:.3} |", self.main.avg_r);
        let _ = writeln!(s, "| Median R | {:.3} |", self.main.median_r);
        let _ = writeln!(s, "| Total PnL USD | {:.2} |", self.main.total_pnl_usd);
        let _ = writeln!(s, "| Mean hold | {:.0}s |", self.main.mean_hold_s);

        if !self.ablations.is_empty() {
            let _ = writeln!(s, "\n## Ablations\n");
            let _ = writeln!(s, "| Variant | Trades | Win% | PF | Sharpe | MDD% | PnL |");
            let _ = writeln!(s, "|---|---|---|---|---|---|---|");
            for a in &self.ablations {
                let _ = writeln!(
                    s,
                    "| {} | {} | {:.1} | {:.2} | {:.2} | {:.1} | {:.0} |",
                    a.label,
                    a.metrics.n_trades,
                    a.metrics.win_rate * 100.0,
                    a.metrics.profit_factor,
                    a.metrics.sharpe,
                    a.metrics.max_drawdown * 100.0,
                    a.metrics.total_pnl_usd
                );
            }
        }

        if !self.equity_curve.is_empty() {
            let _ = writeln!(s, "\n## Equity curve (first/last)\n");
            let (first_t, first_e) = self.equity_curve.first().copied().unwrap_or((0, 0.0));
            let (last_t, last_e) = self.equity_curve.last().copied().unwrap_or((0, 0.0));
            let _ = writeln!(s, "- Start: {} → equity {:.2}", fmt_ts(first_t), first_e);
            let _ = writeln!(s, "- End:   {} → equity {:.2}", fmt_ts(last_t), last_e);
            let _ = writeln!(s, "- Points: {}", self.equity_curve.len());
        }

        s
    }
}

fn fmt_ts(s: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp(s, 0)
        .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| s.to_string())
}
