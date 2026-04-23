//! Buy-and-hold benchmarks.
//!
//! For context, we compute what a single-shot long entry at the first
//! candle would have produced by the last candle — on the same $10k
//! notional used by every strategy. This is the "do nothing" baseline
//! every strategy must beat to justify its overhead.

use domain::crypto::{Asset, Candle};
use paper_trader::TraderConfig;
use reports::{backtest_report::RiskMetrics, BacktestReport};

pub fn buy_and_hold(name: &str, asset: Asset, candles: &[Candle], cfg: &TraderConfig) -> BacktestReport {
    if candles.len() < 2 {
        return BacktestReport::default();
    }
    let first = &candles[0];
    let last = &candles[candles.len() - 1];
    let qty = cfg.notional_usd / first.open.max(1e-9);
    let pnl = (last.close - first.open) * qty;
    let fees = (cfg.taker_fee_bps / 10_000.0) * cfg.notional_usd * 2.0;
    let slippage = (cfg.slippage_bps / 10_000.0) * cfg.notional_usd * 2.0;
    let net = pnl - fees - slippage;

    // Per-hour returns so metrics see a realistic distribution.
    let returns: Vec<f64> = candles
        .windows(2)
        .map(|w| (w[1].close - w[0].close) / w[0].close)
        .collect();

    let m = {
        let mut x = RiskMetrics::default();
        x.n_trades = 1;
        x.win_rate = if net > 0.0 { 1.0 } else { 0.0 };
        x.total_pnl_usd = net;
        x.avg_r = net / cfg.notional_usd;
        x.expectancy_r = x.avg_r;
        x.profit_factor = if net > 0.0 { f64::INFINITY } else { 0.0 };
        // Sharpe on per-hour returns (annualised for an hourly series with
        // 365×24 ≈ 8760 bars: multiply by sqrt(8760)).
        let n = returns.len().max(1) as f64;
        let mean = returns.iter().sum::<f64>() / n;
        let var = returns.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / n;
        let sd = var.sqrt().max(1e-18);
        x.sharpe = mean / sd * (8_760.0_f64).sqrt();
        // Max drawdown on the marked-to-market path
        let mut peak = 10_000.0_f64;
        let mut eq = 10_000.0_f64;
        let mut mdd = 0.0_f64;
        for r in &returns {
            eq *= 1.0 + r;
            peak = peak.max(eq);
            let dd = ((peak - eq) / peak).min(1.0);
            mdd = mdd.max(dd);
        }
        x.max_drawdown = mdd;
        x.calmar = if mdd > 0.0 { (net / 10_000.0) / mdd } else { f64::INFINITY };
        x.mean_hold_s = (candles.last().unwrap().ts.0 - first.ts.0) as f64;
        x
    };

    // Build a fake equity curve: starts at 0, ends at PnL.
    let equity_curve = candles
        .iter()
        .map(|c| {
            let r = (c.close - first.open) / first.open;
            (c.ts.0, r * cfg.notional_usd)
        })
        .collect();

    BacktestReport {
        name: format!("{name}/{}", asset.coin()),
        start_ts: first.ts.0,
        end_ts: last.ts.0,
        config_hash: "buy-and-hold".into(),
        main: m,
        ablations: vec![],
        equity_curve,
        r_histogram: vec![],
    }
}
