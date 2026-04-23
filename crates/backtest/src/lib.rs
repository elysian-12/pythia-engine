//! Backtest runner.
//!
//! A pure, deterministic walk-forward simulator. Given a time-ordered pipeline
//! of `MarketState` snapshots and forward candle/funding data, it:
//!
//! 1. Calls `signal_engine::evaluate` at each snapshot.
//! 2. When a signal fires, opens a paper trade via `paper_trader::simulate`.
//! 3. Enforces a single-open-position-per-asset rule (no overlap).
//! 4. Accumulates closed trades.
//! 5. Computes risk metrics (Sharpe, Sortino, profit factor, max DD, Calmar,
//!    expectancy, R-multiples).
//!
//! Output: a `reports::BacktestReport`.

#![deny(unused_must_use)]

pub mod metrics;
pub mod synthetic;

use domain::{
    crypto::{Asset, Candle, FundingRate},
    signal::{Signal, Trade},
    time::EventTs,
};
use paper_trader::{atr, simulate, TraderConfig};
use reports::BacktestReport;
use signal_engine::{evaluate_with_reason, MarketState, SignalConfig};
use std::collections::HashMap;

pub use metrics::compute_metrics;

/// Forward-data cache keyed by asset.
#[derive(Clone, Debug, Default)]
pub struct ForwardData {
    pub candles: HashMap<Asset, Vec<Candle>>,
    pub funding: HashMap<Asset, Vec<FundingRate>>,
}

/// One backtest run.
pub fn run(
    name: &str,
    states: &[MarketState],
    forward: &ForwardData,
    cfg: &SignalConfig,
    trader: &TraderConfig,
) -> BacktestReport {
    let mut trades: Vec<Trade> = Vec::new();
    let mut last_exit: HashMap<Asset, EventTs> = HashMap::new();

    // States must be ordered by asof ascending.
    for st in states {
        if let Some((asset, _)) = st.asset_mapping {
            if let Some(prev_exit) = last_exit.get(&asset) {
                if st.asof.0 < prev_exit.0 {
                    continue; // asset is still in an open trade, skip
                }
            }
        }
        let signal = match evaluate_with_reason(st, cfg) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let asset = signal.asset;
        let Some(candles_all) = forward.candles.get(&asset) else {
            continue;
        };
        let Some(funding_all) = forward.funding.get(&asset) else {
            continue;
        };

        // ATR from candles up to signal.ts
        let pre: Vec<&Candle> = candles_all.iter().filter(|c| c.ts.0 <= signal.ts.0).collect();
        let pre_owned: Vec<Candle> = pre.into_iter().cloned().collect();
        let Some(entry_atr) = atr(&pre_owned, trader.atr_window) else {
            continue;
        };

        // Forward window: candles + funding from signal.ts onward.
        let fwd_candles: Vec<Candle> = candles_all
            .iter()
            .filter(|c| c.ts.0 >= signal.ts.0 && c.ts.0 <= signal.ts.0 + signal.horizon_s)
            .cloned()
            .collect();
        if fwd_candles.is_empty() {
            continue;
        }
        let fwd_funding: Vec<FundingRate> = funding_all
            .iter()
            .filter(|f| f.ts.0 >= signal.ts.0 && f.ts.0 <= signal.ts.0 + signal.horizon_s)
            .cloned()
            .collect();

        if let Some(trade) = simulate(&signal, &fwd_candles, &fwd_funding, entry_atr, trader) {
            if let Some(exit_ts) = trade.exit_ts {
                last_exit.insert(asset, exit_ts);
            }
            trades.push(trade);
        }
    }

    let main = compute_metrics(&trades, trader);
    let equity_curve = equity_curve(&trades);
    let r_histogram = r_histogram(&trades);

    let (start_ts, end_ts) = states
        .first()
        .zip(states.last())
        .map(|(a, b)| (a.asof.0, b.asof.0))
        .unwrap_or((0, 0));

    BacktestReport {
        name: name.into(),
        start_ts,
        end_ts,
        config_hash: cfg_hash(cfg, trader),
        main,
        ablations: Vec::new(),
        equity_curve,
        r_histogram,
    }
}

/// Run a pre-computed signal stream through the paper-trader with a
/// no-overlap-per-asset rule. Used by crypto-native strategies that
/// emit signals without going through `signal_engine::evaluate`.
pub fn run_signal_stream(
    name: &str,
    signals: &[Signal],
    forward: &ForwardData,
    trader: &TraderConfig,
) -> BacktestReport {
    let mut ordered: Vec<&Signal> = signals.iter().collect();
    ordered.sort_by_key(|s| s.ts.0);

    let mut trades: Vec<Trade> = Vec::new();
    let mut last_exit: HashMap<Asset, EventTs> = HashMap::new();

    for sig in ordered {
        if let Some(prev_exit) = last_exit.get(&sig.asset) {
            if sig.ts.0 < prev_exit.0 {
                continue;
            }
        }
        let Some(candles_all) = forward.candles.get(&sig.asset) else {
            continue;
        };
        let Some(funding_all) = forward.funding.get(&sig.asset) else {
            continue;
        };
        let pre_owned: Vec<Candle> = candles_all
            .iter()
            .filter(|c| c.ts.0 <= sig.ts.0)
            .cloned()
            .collect();
        let Some(entry_atr) = atr(&pre_owned, trader.atr_window) else {
            continue;
        };
        let fwd_candles: Vec<Candle> = candles_all
            .iter()
            .filter(|c| c.ts.0 >= sig.ts.0 && c.ts.0 <= sig.ts.0 + sig.horizon_s)
            .cloned()
            .collect();
        if fwd_candles.is_empty() {
            continue;
        }
        let fwd_funding: Vec<FundingRate> = funding_all
            .iter()
            .filter(|f| f.ts.0 >= sig.ts.0 && f.ts.0 <= sig.ts.0 + sig.horizon_s)
            .cloned()
            .collect();

        if let Some(trade) = simulate(sig, &fwd_candles, &fwd_funding, entry_atr, trader) {
            if let Some(exit_ts) = trade.exit_ts {
                last_exit.insert(sig.asset, exit_ts);
            }
            trades.push(trade);
        }
    }

    let main = compute_metrics(&trades, trader);
    let equity = equity_curve(&trades);
    let r_hist = r_histogram(&trades);
    let (start_ts, end_ts) = signals
        .first()
        .zip(signals.last())
        .map(|(a, b)| (a.ts.0, b.ts.0))
        .unwrap_or((0, 0));

    BacktestReport {
        name: name.into(),
        start_ts,
        end_ts,
        config_hash: trader_hash(trader),
        main,
        ablations: Vec::new(),
        equity_curve: equity,
        r_histogram: r_hist,
    }
}

fn trader_hash(trader: &TraderConfig) -> String {
    let s = serde_json::to_string(trader).unwrap_or_default();
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn equity_curve(trades: &[Trade]) -> Vec<(i64, f64)> {
    let mut curve = Vec::with_capacity(trades.len() + 1);
    let mut equity = 0.0;
    if let Some(first) = trades.first().and_then(|t| t.entry_ts.0.into()) {
        curve.push((first, 0.0));
    }
    for t in trades {
        if let (Some(pnl), Some(exit)) = (t.pnl_usd, t.exit_ts) {
            equity += pnl;
            curve.push((exit.0, equity));
        }
    }
    curve
}

fn r_histogram(trades: &[Trade]) -> Vec<(f64, usize)> {
    let buckets: Vec<f64> =
        (-5..=5).map(|i| (i as f64) * 0.5).collect();
    let mut counts = vec![0usize; buckets.len()];
    for t in trades {
        if let Some(r) = t.r_multiple {
            let idx = ((r + 2.5) / 0.5).round().clamp(0.0, (buckets.len() - 1) as f64) as usize;
            counts[idx] += 1;
        }
    }
    buckets.into_iter().zip(counts).collect()
}

fn cfg_hash(cfg: &SignalConfig, trader: &TraderConfig) -> String {
    let s = serde_json::to_string(&(cfg, trader)).unwrap_or_default();
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}
