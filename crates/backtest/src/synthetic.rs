//! Synthetic data generator for end-to-end backtest proof-of-concept.
//!
//! Creates a scenario where PM demonstrably leads crypto by 2 bars. Used as
//! the "ground truth" harness test: the strategy should produce positive
//! expectancy when the lead-lag relationship exists.

use domain::{
    crypto::{Asset, Candle, FundingRate},
    ids::ConditionId,
    time::EventTs,
};
use signal_engine::MarketState;
use std::collections::HashMap;

#[derive(Debug)]
pub struct Scenario {
    pub states: Vec<MarketState>,
    pub candles: Vec<Candle>,
    pub funding: Vec<FundingRate>,
    pub asset: Asset,
}

/// Generate a scenario with clean PM-leads-crypto structure.
///
/// `n_states`: number of snapshot timestamps (each 1h).
/// `seed`: deterministic RNG.
pub fn generate(n_states: usize, seed: u64, asset: Asset) -> Scenario {
    let total = n_states + 300;
    let mut s = seed;
    let mut rnd = || {
        s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        // (s >> 32) gives a 32-bit chunk; map to [-0.5, 0.5).
        let u = (s >> 32) as u32;
        (f64::from(u) / f64::from(u32::MAX)) - 0.5
    };
    // PM series: shocks large enough to drive crypto meaningfully.
    let mut pm = vec![0.5; total];
    for t in 1..total {
        pm[t] = (pm[t - 1] + 0.08 * rnd()).clamp(0.05, 0.95);
    }
    // Crypto log-price follows 2-bar-lagged PM changes + own noise.
    // Noise is relatively large so that info_share must extract PM's signal.
    let mut log_px = vec![(100.0f64).ln(); total];
    for t in 3..total {
        log_px[t] = log_px[t - 1] + 1.5 * (pm[t - 2] - pm[t - 3]) + 0.01 * rnd();
    }
    let prices: Vec<f64> = log_px.iter().map(|l| l.exp()).collect();

    // Candles: OHLC from consecutive prices.
    let mut candles = Vec::with_capacity(total);
    for t in 0..total {
        let o = if t == 0 { prices[0] } else { prices[t - 1] };
        let c = prices[t];
        let h = o.max(c) * (1.0 + 0.001);
        let l = o.min(c) * (1.0 - 0.001);
        candles.push(Candle {
            ts: EventTs::from_secs((t as i64) * 3600),
            open: o,
            high: h,
            low: l,
            close: c,
            volume: 100.0,
        });
    }
    let funding: Vec<FundingRate> = (0..total)
        .map(|t| FundingRate {
            ts: EventTs::from_secs((t as i64) * 3600),
            rate_open: 0.0001,
            rate_close: 0.0001,
            predicted_close: None,
        })
        .collect();

    // Build market states at the last n_states timestamps with SWP = pm + noisy edge.
    // Edge is injected as SWP *leading* the "true" future pm — so when swp > mid,
    // pm will rise over the next few bars, and crypto will rise 2 bars after that.
    let mut states = Vec::with_capacity(n_states);
    for k in 0..n_states {
        let t = 300 + k;
        let asof_ts = (t as i64) * 3600;
        let edge = if k % 25 == 5 { 0.06 } else if k % 25 == 15 { -0.06 } else { 0.0 };
        let swp = (pm[t] + edge).clamp(0.02, 0.98);
        let mid = pm[t];
        // Use changes in pm and log-returns in crypto: both stationary, so
        // the OLS regressions underpinning info-share/Granger are well-behaved.
        let pm_src = &pm[t.saturating_sub(121)..t];
        let cx_src = &log_px[t.saturating_sub(121)..t];
        let pm_window: Vec<f64> =
            pm_src.windows(2).map(|w| w[1] - w[0]).collect();
        let cx_window: Vec<f64> =
            cx_src.windows(2).map(|w| w[1] - w[0]).collect();
        // crypto_response = recent log-returns scaled
        let start = t.saturating_sub(40);
        let resp: Vec<f64> = (start + 1..t)
            .map(|i| log_px[i] - log_px[i - 1])
            .collect();

        states.push(MarketState {
            condition_id: ConditionId::new("0xsynth"),
            market_name: "Synthetic scenario".into(),
            asof: EventTs::from_secs(asof_ts),
            swp: Some(swp),
            mid: Some(mid),
            pm_series: pm_window,
            crypto_series: cx_window,
            crypto_response: resp,
            gini: 0.6,
            asset_mapping: Some((asset, 1)),
            horizon_s: Some(6 * 3600),
        });
    }

    Scenario {
        states,
        candles,
        funding,
        asset,
    }
}

/// Wrap the candles/funding into `ForwardData` keyed by asset.
pub fn to_forward_data(scn: &Scenario) -> crate::ForwardData {
    let mut candles = HashMap::new();
    candles.insert(scn.asset, scn.candles.clone());
    let mut funding = HashMap::new();
    funding.insert(scn.asset, scn.funding.clone());
    crate::ForwardData { candles, funding }
}

/// Mixed-quality scenario: half the snapshots come from a genuinely
/// PM-leads-crypto regime, half come from a decoupled regime where crypto
/// is independently driven by noise. A good signal engine should filter
/// out the decoupled half via the econometric gate.
pub fn generate_mixed(n_states: usize, seed: u64, asset: Asset) -> Scenario {
    let total = n_states + 300;
    let mut s = seed;
    let mut rnd = || {
        s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let u = (s >> 32) as u32;
        (f64::from(u) / f64::from(u32::MAX)) - 0.5
    };

    // PM walk
    let mut pm = vec![0.5; total];
    for t in 1..total {
        pm[t] = (pm[t - 1] + 0.08 * rnd()).clamp(0.05, 0.95);
    }

    // Crypto log-price: PM-linked in odd windows, independent noise in even.
    let mut log_px = vec![(100.0_f64).ln(); total];
    let regime_window = 50;
    for t in 3..total {
        let in_coupled_regime = (t / regime_window) % 2 == 0;
        log_px[t] = if in_coupled_regime {
            log_px[t - 1] + 1.5 * (pm[t - 2] - pm[t - 3]) + 0.01 * rnd()
        } else {
            log_px[t - 1] + 0.04 * rnd()
        };
    }
    let prices: Vec<f64> = log_px.iter().map(|l| l.exp()).collect();

    let mut candles = Vec::with_capacity(total);
    for t in 0..total {
        let o = if t == 0 { prices[0] } else { prices[t - 1] };
        let c = prices[t];
        candles.push(Candle {
            ts: EventTs::from_secs((t as i64) * 3600),
            open: o,
            high: o.max(c) * (1.0 + 0.001),
            low: o.min(c) * (1.0 - 0.001),
            close: c,
            volume: 100.0,
        });
    }
    let funding: Vec<FundingRate> = (0..total)
        .map(|t| FundingRate {
            ts: EventTs::from_secs((t as i64) * 3600),
            rate_open: 0.0001,
            rate_close: 0.0001,
            predicted_close: None,
        })
        .collect();

    let mut states = Vec::with_capacity(n_states);
    for k in 0..n_states {
        let t = 300 + k;
        let asof_ts = (t as i64) * 3600;
        let edge = if k % 25 == 5 { 0.06 } else if k % 25 == 15 { -0.06 } else { 0.0 };
        let swp = (pm[t] + edge).clamp(0.02, 0.98);
        let mid = pm[t];

        let pm_src = &pm[t.saturating_sub(121)..t];
        let cx_src = &log_px[t.saturating_sub(121)..t];
        let pm_window: Vec<f64> = pm_src.windows(2).map(|w| w[1] - w[0]).collect();
        let cx_window: Vec<f64> = cx_src.windows(2).map(|w| w[1] - w[0]).collect();
        let start = t.saturating_sub(40);
        let resp: Vec<f64> = (start + 1..t)
            .map(|i| log_px[i] - log_px[i - 1])
            .collect();

        states.push(MarketState {
            condition_id: ConditionId::new("0xmixed"),
            market_name: "Mixed-quality scenario".into(),
            asof: EventTs::from_secs(asof_ts),
            swp: Some(swp),
            mid: Some(mid),
            pm_series: pm_window,
            crypto_series: cx_window,
            crypto_response: resp,
            gini: 0.6,
            asset_mapping: Some((asset, 1)),
            horizon_s: Some(6 * 3600),
        });
    }

    Scenario {
        states,
        candles,
        funding,
        asset,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scenario_builds() {
        let scn = generate(100, 1, Asset::Btc);
        assert_eq!(scn.states.len(), 100);
        assert!(scn.candles.len() > 100);
        assert!(scn.funding.len() == scn.candles.len());
    }

    #[test]
    fn mixed_scenario_builds() {
        let scn = generate_mixed(200, 2, Asset::Btc);
        assert_eq!(scn.states.len(), 200);
    }
}
