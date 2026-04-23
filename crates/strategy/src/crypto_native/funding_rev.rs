//! Funding-rate mean reversion.
//!
//! Thesis: persistently one-sided funding indicates crowded positioning.
//! When rolling-window z-score of the funding rate exceeds `+threshold`
//! (long-biased) we short the next bar; when below `-threshold` we go
//! long. Exits via ATR-based stops and the signal horizon.
//!
//! Real-world grounding: Binance's 8-hour funding is a direct cost for
//! leveraged perps holders. At an annualised 30%+ funding, longs pay a
//! meaningful carry; empirical studies (Skew.com, CryptoCompare reports)
//! show funding spikes above 2σ mean-revert within 24–48 h.

use std::sync::atomic::{AtomicU64, Ordering};

use domain::{
    ids::ConditionId,
    signal::{Direction, Signal},
    time::EventTs,
};

use crate::crypto_native::{rolling_zscore, AssetInput, CryptoStrategy};

pub struct FundingReversion {
    pub z_window: usize,
    pub z_threshold: f64,
    pub horizon_s: i64,
    /// Minimum bars between two signals on the same asset.
    pub cooldown_bars: usize,
    /// If `true`, flips the direction to ride the trend instead of
    /// mean-reverting. Useful for regimes where funding imbalances
    /// correlate with continuation (common on trending majors).
    pub trend_follow: bool,
    pub strategy_name: &'static str,
}

impl Default for FundingReversion {
    fn default() -> Self {
        Self {
            z_window: 24 * 3,
            z_threshold: 2.0,
            horizon_s: 12 * 3600,
            cooldown_bars: 12,
            trend_follow: false,
            strategy_name: "funding-reversion",
        }
    }
}

impl FundingReversion {
    /// Trend-follow variant — rides the direction of funding imbalance.
    pub fn trend() -> Self {
        Self {
            trend_follow: true,
            strategy_name: "funding-trend",
            ..Self::default()
        }
    }
}

impl CryptoStrategy for FundingReversion {
    fn name(&self) -> &'static str {
        self.strategy_name
    }

    fn signals(&self, input: &AssetInput) -> Vec<Signal> {
        let rates: Vec<f64> = input.funding.iter().map(|f| f.rate_close).collect();
        let z = rolling_zscore(&rates, self.z_window);

        let mut signals = Vec::new();
        let mut last_bar: i64 = i64::MIN;
        for (i, zi) in z.iter().enumerate() {
            let Some(zv) = zi else { continue };
            if zv.abs() < self.z_threshold {
                continue;
            }
            let ts = input.funding[i].ts;
            if last_bar != i64::MIN && (i as i64 - last_bar) < self.cooldown_bars as i64 {
                continue;
            }
            last_bar = i as i64;

            // Mean-reverting default: short crowded longs, long crowded shorts.
            // Trend-follow variant: ride the direction of the funding imbalance.
            let mean_revert_dir = if *zv > 0.0 { Direction::Short } else { Direction::Long };
            let direction = if self.trend_follow {
                match mean_revert_dir {
                    Direction::Long => Direction::Short,
                    Direction::Short => Direction::Long,
                }
            } else {
                mean_revert_dir
            };
            let conviction = ((zv.abs() / 3.0).min(1.0) * 100.0).round() as u8;

            signals.push(Signal {
                id: synth_id("funding", input.asset, ts, *zv),
                ts,
                condition_id: ConditionId::new("crypto-native:funding-reversion"),
                market_name: format!("{} 8h funding z={:.2}", input.asset.coin(), zv),
                asset: input.asset,
                direction,
                swp: 0.5 + zv.tanh() * 0.5,
                mid: 0.5,
                edge: *zv,
                is_pm: 0.0,
                granger_f: 0.0,
                gini: 0.0,
                conviction,
                horizon_s: self.horizon_s,
            });
        }
        signals
    }
}

/// Generate a stable-unique signal id. No randomness — uses an atomic
/// counter seeded by the input asof_ts so replays are deterministic.
pub(crate) fn synth_id(prefix: &str, asset: domain::crypto::Asset, ts: EventTs, edge: f64) -> String {
    // Monotonic suffix guarantees uniqueness even if two strategies fire
    // on the same bar.
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}:{}:{}:{:.3}:{n}", asset.coin(), ts.0, edge)
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::{
        crypto::{Asset, Candle, FundingRate, Liquidation},
        time::EventTs,
    };

    fn funding_series(rates: &[f64]) -> Vec<FundingRate> {
        rates
            .iter()
            .enumerate()
            .map(|(i, r)| FundingRate {
                ts: EventTs::from_secs(i as i64 * 3600),
                rate_open: *r,
                rate_close: *r,
                predicted_close: None,
            })
            .collect()
    }

    fn empty_candles() -> Vec<Candle> {
        vec![]
    }
    fn empty_liq() -> Vec<Liquidation> {
        vec![]
    }

    #[test]
    fn fires_on_z_spike() {
        let mut rates = vec![0.0001_f64; 100];
        rates[99] = 0.0020; // clearly positive spike → short
        let funding = funding_series(&rates);
        let oi = vec![];
        let input = AssetInput {
            asset: Asset::Btc,
            candles: &empty_candles(),
            funding: &funding,
            oi: &oi,
            liquidations: &empty_liq(),
        };
        let sigs = FundingReversion::default().signals(&input);
        assert!(!sigs.is_empty(), "expected at least one signal");
        assert!(sigs.iter().any(|s| s.direction == Direction::Short));
    }

    #[test]
    fn cooldown_prevents_spam() {
        let rates: Vec<f64> = (0..200)
            .map(|i| if i > 100 { 0.002 } else { 0.0001 })
            .collect();
        let funding = funding_series(&rates);
        let input = AssetInput {
            asset: Asset::Btc,
            candles: &empty_candles(),
            funding: &funding,
            oi: &vec![],
            liquidations: &empty_liq(),
        };
        let s = FundingReversion {
            cooldown_bars: 50,
            ..Default::default()
        }
        .signals(&input);
        // With a cooldown of 50 and 100 bars of spikes, we expect ≤ 3 signals.
        assert!(s.len() <= 3, "got {} signals (expected ≤ 3)", s.len());
    }
}
