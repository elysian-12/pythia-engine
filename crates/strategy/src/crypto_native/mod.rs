//! Crypto-native strategy suite.
//!
//! These strategies use only crypto derivatives data (candles / funding /
//! open interest / liquidations) — no Polymarket input. They let us
//! measure real PnL on the 365d historical dataset and provide a baseline
//! the PM-enhanced strategies must beat.
//!
//! Each strategy implements [`CryptoStrategy::signals`]: given an asset's
//! full history, return an ordered `Vec<Signal>`. The paper-trader then
//! simulates them deterministically and risk metrics fall out of
//! `backtest::metrics::compute_metrics`.
//!
//! All strategies are pure functions with no I/O. They share a common
//! `Conviction → R-multiple stop/target profile` so an ensemble can
//! combine them by summing signed conviction.

pub mod baselines;
pub mod ensemble;
pub mod funding_rev;
pub mod liq_fade;
pub mod liq_variants;
pub mod oi_div;
pub mod vol_bo;

#[allow(clippy::needless_range_loop)]
mod _ranges {}

use domain::{
    crypto::{Asset, Candle, FundingRate, Liquidation, OpenInterest},
    signal::Signal,
};

/// A crypto-only strategy. The primary output is a chronological signal
/// stream; implementations must not leak future information.
pub trait CryptoStrategy {
    fn name(&self) -> &'static str;
    fn signals(&self, input: &AssetInput) -> Vec<Signal>;
}

#[derive(Debug, Clone)]
pub struct AssetInput<'a> {
    pub asset: Asset,
    pub candles: &'a [Candle],
    pub funding: &'a [FundingRate],
    pub oi: &'a [OpenInterest],
    pub liquidations: &'a [Liquidation],
}

/// Rolling-window mean/std for a series — single-pass prefix-sum, O(n).
pub(crate) fn rolling_zscore(series: &[f64], window: usize) -> Vec<Option<f64>> {
    let mut out = vec![None; series.len()];
    if window < 2 || series.len() < window {
        return out;
    }
    let mut sum = 0.0_f64;
    let mut sqsum = 0.0_f64;
    for i in 0..window {
        sum += series[i];
        sqsum += series[i] * series[i];
    }
    for i in window..series.len() {
        let n = window as f64;
        let mean = sum / n;
        let var = (sqsum / n - mean * mean).max(0.0);
        let sd = var.sqrt().max(1e-12);
        out[i] = Some((series[i] - mean) / sd);
        sum += series[i] - series[i - window];
        sqsum += series[i] * series[i] - series[i - window] * series[i - window];
    }
    out
}

/// Percent change of a series over `window` bars.
pub(crate) fn pct_change(series: &[f64], window: usize) -> Vec<Option<f64>> {
    let mut out = vec![None; series.len()];
    for i in window..series.len() {
        let prev = series[i - window];
        if prev.abs() > 1e-12 {
            out[i] = Some((series[i] - prev) / prev);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rolling_zscore_constant_series_is_zero() {
        let v: Vec<f64> = vec![5.0; 50];
        let z = rolling_zscore(&v, 10);
        for i in 10..50 {
            let zi = z[i].unwrap();
            assert!(zi.abs() < 1e-6, "z[{i}]={zi}");
        }
    }

    #[test]
    fn rolling_zscore_last_spike_is_large() {
        let mut v: Vec<f64> = (0..50).map(|i| (i as f64).sin() * 0.1).collect();
        v[49] = 5.0;
        let z = rolling_zscore(&v, 20);
        let last = z[49].unwrap();
        assert!(last > 3.0, "spike z={last}");
    }

    #[test]
    fn pct_change_monotonic() {
        let v = vec![100.0, 102.0, 104.04];
        let p = pct_change(&v, 1);
        assert!((p[1].unwrap() - 0.02).abs() < 1e-9);
        assert!((p[2].unwrap() - 0.02).abs() < 1e-9);
    }
}
