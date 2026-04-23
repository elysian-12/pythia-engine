//! Risk metrics.

use domain::signal::Trade;
use paper_trader::TraderConfig;
use reports::backtest_report::RiskMetrics;

/// Compute the full set of risk metrics from a vector of closed trades.
pub fn compute_metrics(trades: &[Trade], _cfg: &TraderConfig) -> RiskMetrics {
    let mut m = RiskMetrics {
        n_trades: trades.len(),
        ..Default::default()
    };
    if trades.is_empty() {
        return m;
    }

    let pnls: Vec<f64> = trades.iter().filter_map(|t| t.pnl_usd).collect();
    let rs: Vec<f64> = trades.iter().filter_map(|t| t.r_multiple).collect();

    let wins: Vec<f64> = pnls.iter().copied().filter(|p| *p > 0.0).collect();
    let losses: Vec<f64> = pnls.iter().copied().filter(|p| *p < 0.0).collect();

    m.win_rate = wins.len() as f64 / pnls.len().max(1) as f64;
    m.total_pnl_usd = pnls.iter().sum();

    let gross_win: f64 = wins.iter().sum();
    let gross_loss: f64 = losses.iter().map(|l| l.abs()).sum();
    m.profit_factor = if gross_loss > 0.0 { gross_win / gross_loss } else { f64::INFINITY };

    let n = pnls.len() as f64;
    let mean = m.total_pnl_usd / n.max(1.0);
    let var: f64 = pnls.iter().map(|p| (p - mean).powi(2)).sum::<f64>() / n.max(1.0);
    let sd = var.sqrt().max(1e-12);
    // Annualization omitted — expected signals are intraday-to-daily horizon,
    // so Sharpe here is per-trade. Multiply by √(trades/year) for annualized.
    m.sharpe = mean / sd;

    let down_var: f64 = pnls
        .iter()
        .map(|p| if *p < 0.0 { (p - mean).powi(2) } else { 0.0 })
        .sum::<f64>()
        / n.max(1.0);
    let down_sd = down_var.sqrt().max(1e-12);
    m.sortino = mean / down_sd;

    // Max drawdown measured against an initial capital baseline and capped
    // at 1.0 (100%). Losing more than 100% of capital is a stop — we
    // floor equity at zero for the drawdown calculation. Raw total PnL
    // still reflects the underlying dollar loss.
    let initial_capital = 10_000.0_f64;
    let mut peak = initial_capital;
    let mut max_dd = 0.0_f64;
    let mut eq = initial_capital;
    for p in &pnls {
        eq += p;
        if eq > peak {
            peak = eq;
        }
        let effective_eq = eq.max(0.0);
        let dd = ((peak - effective_eq) / peak.max(1.0)).min(1.0);
        if dd > max_dd {
            max_dd = dd;
        }
    }
    m.max_drawdown = max_dd;
    m.calmar = if max_dd > 0.0 {
        (m.total_pnl_usd / initial_capital) / max_dd
    } else {
        f64::INFINITY
    };

    if !rs.is_empty() {
        m.avg_r = rs.iter().sum::<f64>() / rs.len() as f64;
        let mut sorted = rs.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        m.median_r = sorted[sorted.len() / 2];
        m.positive_r = rs.iter().filter(|r| **r > 0.0).count();
        m.negative_r = rs.iter().filter(|r| **r < 0.0).count();
    }
    m.expectancy_r = m.avg_r;

    let holds: Vec<f64> = trades
        .iter()
        .filter_map(|t| t.exit_ts.map(|e| (e.0 - t.entry_ts.0) as f64))
        .collect();
    if !holds.is_empty() {
        m.mean_hold_s = holds.iter().sum::<f64>() / holds.len() as f64;
    }

    m
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::{
        crypto::Asset,
        signal::{CloseReason, Direction, Trade},
        time::EventTs,
    };

    fn trade(pnl: f64, r: f64) -> Trade {
        Trade {
            signal_id: "s".into(),
            asset: Asset::Btc,
            direction: Direction::Long,
            entry_ts: EventTs::from_secs(0),
            entry_price: 100.0,
            exit_ts: Some(EventTs::from_secs(3600)),
            exit_price: Some(101.0),
            fees: 1.0,
            funding_paid: 0.0,
            slippage: 0.5,
            close_reason: Some(CloseReason::TakeProfit),
            r_multiple: Some(r),
            pnl_usd: Some(pnl),
        }
    }

    #[test]
    fn empty_trades_zero_metrics() {
        let m = compute_metrics(&[], &TraderConfig::default());
        assert_eq!(m.n_trades, 0);
    }

    #[test]
    fn win_rate_correct() {
        let ts = vec![trade(100.0, 1.0), trade(-50.0, -0.5), trade(200.0, 2.0)];
        let m = compute_metrics(&ts, &TraderConfig::default());
        assert_eq!(m.n_trades, 3);
        assert!((m.win_rate - 2.0 / 3.0).abs() < 1e-9);
        assert!((m.total_pnl_usd - 250.0).abs() < 1e-9);
        // profit_factor = 300 / 50 = 6
        assert!((m.profit_factor - 6.0).abs() < 1e-9);
    }

    #[test]
    fn max_dd_detected() {
        // Initial capital = 10_000. After [+100, +100, -150, +50]:
        //   10_000, 10_100, 10_200, 10_050, 10_100
        // Peak = 10_200 at step 2, trough after = 10_050 (step 3).
        // Drawdown = (10_200 - 10_050) / 10_200 ≈ 0.01470588.
        let ts = vec![
            trade(100.0, 1.0),
            trade(100.0, 1.0),
            trade(-150.0, -1.5),
            trade(50.0, 0.5),
        ];
        let m = compute_metrics(&ts, &TraderConfig::default());
        assert!((m.max_drawdown - (150.0 / 10_200.0)).abs() < 1e-9);
    }
}
