//! Paper trader — pure simulator.
//!
//! Takes a signal and a forward candle stream, simulates execution with
//! realistic slippage + taker fees + funding, applies ATR-based
//! stops/targets/time-stops, and returns a closed `Trade`.
//!
//! Deterministic: same inputs ⇒ identical output. Critical for replay tests
//! and for the backtest harness to be reproducible.

#![deny(unused_must_use)]

use domain::{
    crypto::{Candle, FundingRate},
    signal::{CloseReason, Direction, Signal, Trade},
    time::EventTs,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TraderConfig {
    /// Taker fee in basis points per side.
    pub taker_fee_bps: f64,
    /// Slippage constant in basis points per side.
    pub slippage_bps: f64,
    /// Notional size in USD. The paper trader doesn't use leverage — PnL is
    /// reported in USD on this notional.
    pub notional_usd: f64,
    /// Stop-loss multiple of ATR.
    pub stop_atr_mult: f64,
    /// Take-profit multiple of ATR.
    pub tp_atr_mult: f64,
    /// ATR window (candles).
    pub atr_window: usize,
    /// Funding applied per 8h period at mean rate of window.
    pub funding_window: usize,
}

impl Default for TraderConfig {
    fn default() -> Self {
        Self {
            taker_fee_bps: 5.0,
            slippage_bps: 3.0,
            notional_usd: 10_000.0,
            stop_atr_mult: 1.5,
            tp_atr_mult: 3.0,
            atr_window: 14,
            funding_window: 24,
        }
    }
}

/// Compute ATR over the last `window` candles (Wilder's).
pub fn atr(candles: &[Candle], window: usize) -> Option<f64> {
    if candles.len() < window + 1 {
        return None;
    }
    let start = candles.len() - window - 1;
    let mut trs = Vec::with_capacity(window);
    for i in (start + 1)..candles.len() {
        let prev = &candles[i - 1];
        let cur = &candles[i];
        let tr = (cur.high - cur.low)
            .max((cur.high - prev.close).abs())
            .max((cur.low - prev.close).abs());
        trs.push(tr);
    }
    if trs.is_empty() {
        return None;
    }
    Some(trs.iter().sum::<f64>() / trs.len() as f64)
}

/// Simulate the whole lifecycle of a signal → closed trade against forward data.
///
/// - `future_candles`: hourly candles starting at the bar **containing or after**
///   the signal's fire timestamp; entry is at bar-open of the first bar whose
///   open-time is ≥ `signal.ts`.
/// - `future_funding`: hourly funding-rate series aligned with candles.
/// - `entry_atr`: ATR computed from candles up to (but not including) entry bar.
pub fn simulate(
    signal: &Signal,
    future_candles: &[Candle],
    future_funding: &[FundingRate],
    entry_atr: f64,
    cfg: &TraderConfig,
) -> Option<Trade> {
    if future_candles.is_empty() {
        return None;
    }

    // Locate entry bar — first candle at or after signal.ts.
    let entry_idx = future_candles
        .iter()
        .position(|c| c.ts.0 >= signal.ts.0)?;
    let entry_bar = &future_candles[entry_idx];
    let fill_side = slippage_factor(signal.direction, cfg.slippage_bps);
    let entry_price = entry_bar.open * fill_side;

    let stop_dist = cfg.stop_atr_mult * entry_atr;
    let tp_dist = cfg.tp_atr_mult * entry_atr;
    let (stop, target) = match signal.direction {
        Direction::Long => (entry_price - stop_dist, entry_price + tp_dist),
        Direction::Short => (entry_price + stop_dist, entry_price - tp_dist),
    };
    let horizon_exit_ts = signal.ts.0 + signal.horizon_s;

    let mut exit_ts: Option<EventTs> = None;
    let mut exit_px: Option<f64> = None;
    let mut reason: Option<CloseReason> = None;

    for (i, c) in future_candles.iter().enumerate().skip(entry_idx) {
        if c.ts.0 > horizon_exit_ts {
            let prev = &future_candles[i.saturating_sub(1).max(entry_idx)];
            exit_ts = Some(EventTs::from_secs(horizon_exit_ts));
            exit_px = Some(prev.close);
            reason = Some(CloseReason::TimeStop);
            break;
        }
        let (hit_stop, hit_tp) = match signal.direction {
            Direction::Long => (c.low <= stop, c.high >= target),
            Direction::Short => (c.high >= stop, c.low <= target),
        };
        if hit_stop && hit_tp {
            // Pessimistic: assume stop hits first within-bar.
            exit_ts = Some(c.ts);
            exit_px = Some(stop);
            reason = Some(CloseReason::StopLoss);
            break;
        }
        if hit_stop {
            exit_ts = Some(c.ts);
            exit_px = Some(stop);
            reason = Some(CloseReason::StopLoss);
            break;
        }
        if hit_tp {
            exit_ts = Some(c.ts);
            exit_px = Some(target);
            reason = Some(CloseReason::TakeProfit);
            break;
        }
    }

    // If we never exited within the window, close on last bar.
    let (exit_ts, exit_px, reason) = match (exit_ts, exit_px, reason) {
        (Some(t), Some(p), Some(r)) => (t, p, r),
        _ => (
            future_candles.last()?.ts,
            future_candles.last()?.close,
            CloseReason::TimeStop,
        ),
    };

    let qty = cfg.notional_usd / entry_price.max(1e-9);
    let side_pnl = match signal.direction {
        Direction::Long => (exit_px - entry_price) * qty,
        Direction::Short => (entry_price - exit_px) * qty,
    };
    let fees = (cfg.taker_fee_bps / 10_000.0) * cfg.notional_usd * 2.0;
    let slippage = (cfg.slippage_bps / 10_000.0) * cfg.notional_usd * 2.0;
    let hours = ((exit_ts.0 - signal.ts.0).max(0) as f64) / 3600.0;
    let funding_cost = funding_pnl(signal.direction, future_funding, hours, cfg.notional_usd);
    let pnl = side_pnl - fees - funding_cost;
    let r_mult = if stop_dist > 0.0 {
        (pnl / (cfg.notional_usd * (stop_dist / entry_price.max(1e-9)))).abs()
            * pnl.signum()
    } else {
        0.0
    };

    Some(Trade {
        signal_id: signal.id.clone(),
        asset: signal.asset,
        direction: signal.direction,
        entry_ts: signal.ts,
        entry_price,
        exit_ts: Some(exit_ts),
        exit_price: Some(exit_px),
        fees,
        funding_paid: funding_cost,
        slippage,
        close_reason: Some(reason),
        r_multiple: Some(r_mult),
        pnl_usd: Some(pnl),
    })
}

fn slippage_factor(dir: Direction, bps: f64) -> f64 {
    let slip = bps / 10_000.0;
    match dir {
        Direction::Long => 1.0 + slip,
        Direction::Short => 1.0 - slip,
    }
}

/// Funding cost for the period — long pays when funding is positive, short receives.
fn funding_pnl(dir: Direction, funding: &[FundingRate], hours: f64, notional: f64) -> f64 {
    if funding.is_empty() {
        return 0.0;
    }
    let mean: f64 = funding.iter().map(|f| f.rate_close).sum::<f64>() / funding.len() as f64;
    let periods = hours / 8.0;
    let cost = notional * mean * periods;
    match dir {
        Direction::Long => cost,
        Direction::Short => -cost,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::{
        crypto::Asset,
        ids::ConditionId,
        signal::Direction,
    };

    fn mk_signal(dir: Direction, ts: i64, horizon_s: i64) -> Signal {
        Signal {
            id: "t".into(),
            ts: EventTs::from_secs(ts),
            condition_id: ConditionId::new("cond"),
            market_name: "m".into(),
            asset: Asset::Btc,
            direction: dir,
            swp: 0.6,
            mid: 0.5,
            edge: 0.1,
            is_pm: 0.3,
            granger_f: 5.0,
            gini: 0.6,
            conviction: 70,
            horizon_s,
        }
    }

    fn mk_candles(prices: &[(f64, f64, f64, f64)], t0: i64) -> Vec<Candle> {
        prices
            .iter()
            .enumerate()
            .map(|(i, &(o, h, l, c))| Candle {
                ts: EventTs::from_secs(t0 + (i as i64) * 3600),
                open: o,
                high: h,
                low: l,
                close: c,
                volume: 1.0,
            })
            .collect()
    }

    #[test]
    fn long_take_profit_closes() {
        // ATR=2, TP at 3×ATR=6 above entry. Entry≈100.03 (after slippage),
        // so TP target is ≈106.03. Second bar must make new high > 107 to hit.
        let t0 = 0;
        let candles = mk_candles(
            &[
                (100.0, 101.0, 99.5, 100.5),
                (100.5, 108.0, 100.0, 107.0),
            ],
            t0,
        );
        let s = mk_signal(Direction::Long, 0, 3 * 3600);
        let trade = simulate(
            &s,
            &candles,
            &[FundingRate {
                ts: EventTs::from_secs(0),
                rate_open: 0.0001,
                rate_close: 0.0001,
                predicted_close: None,
            }],
            2.0,
            &TraderConfig::default(),
        )
        .unwrap();
        assert_eq!(trade.close_reason, Some(CloseReason::TakeProfit));
        assert!(trade.pnl_usd.unwrap() > 0.0);
    }

    #[test]
    fn long_stop_loss_closes() {
        let candles = mk_candles(
            &[
                (100.0, 100.5, 99.8, 100.0),
                (100.0, 100.0, 95.0, 96.0), // stop hit
            ],
            0,
        );
        let s = mk_signal(Direction::Long, 0, 3 * 3600);
        let trade = simulate(
            &s,
            &candles,
            &[FundingRate {
                ts: EventTs::from_secs(0),
                rate_open: 0.0,
                rate_close: 0.0,
                predicted_close: None,
            }],
            2.0,
            &TraderConfig::default(),
        )
        .unwrap();
        assert_eq!(trade.close_reason, Some(CloseReason::StopLoss));
        assert!(trade.pnl_usd.unwrap() < 0.0);
    }

    #[test]
    fn time_stop_closes() {
        let mut candles = vec![];
        for _ in 0..20 {
            candles.push((100.0, 100.1, 99.9, 100.05));
        }
        let c = mk_candles(&candles, 0);
        let s = mk_signal(Direction::Long, 0, 3 * 3600);
        let trade = simulate(
            &s,
            &c,
            &[FundingRate {
                ts: EventTs::from_secs(0),
                rate_open: 0.0,
                rate_close: 0.0,
                predicted_close: None,
            }],
            2.0,
            &TraderConfig::default(),
        )
        .unwrap();
        assert_eq!(trade.close_reason, Some(CloseReason::TimeStop));
    }

    #[test]
    fn atr_computes() {
        let c = mk_candles(
            &[(100.0, 102.0, 98.0, 101.0); 30],
            0,
        );
        let a = atr(&c, 14).unwrap();
        assert!(a > 0.0);
    }

    #[test]
    fn determinism() {
        let candles = mk_candles(
            &[
                (100.0, 101.0, 99.5, 100.5),
                (100.5, 105.0, 100.0, 104.5),
            ],
            0,
        );
        let s = mk_signal(Direction::Long, 0, 3 * 3600);
        let f = vec![FundingRate {
            ts: EventTs::from_secs(0),
            rate_open: 0.0001,
            rate_close: 0.0001,
            predicted_close: None,
        }];
        let t1 = simulate(&s, &candles, &f, 2.0, &TraderConfig::default()).unwrap();
        let t2 = simulate(&s, &candles, &f, 2.0, &TraderConfig::default()).unwrap();
        assert_eq!(t1, t2);
    }
}
