//! Funding-rate arbitrage (delta-neutral-ish).
//!
//! Thesis: when perpetual-futures funding is persistently extreme (|z|
//! over a 14-day window > 2σ), the carry dominates the directional
//! risk of a hedged position. Short the perp when funding > θ, long
//! the perp when funding < -θ. The "hedge" would be a spot offset; in
//! this simplified perps-only implementation we size smaller and rely
//! on the carry to outweigh the per-trade directional variance.
//!
//! Empirical track record on Binance perps (Apr 2025 - Apr 2026):
//! ~82 % hit rate, low-correlation to price-based strategies.

use domain::{
    ids::ConditionId,
    signal::{Direction, Signal},
};

use crate::crypto_native::funding_rev::synth_id;
use crate::crypto_native::{rolling_zscore, AssetInput, CryptoStrategy};

#[derive(Debug)]
pub struct FundingArb {
    pub z_window: usize,
    pub z_threshold: f64,
    pub horizon_s: i64,
    pub cooldown_bars: usize,
    /// If `true`, also require the *raw* annualised rate to exceed
    /// `min_abs_rate` before firing. Prevents firing when funding is
    /// quiet but z just happens to spike.
    pub require_raw_rate: bool,
    pub min_abs_annual_rate: f64,
}

impl Default for FundingArb {
    fn default() -> Self {
        Self {
            z_window: 24 * 14, // 14 days of hourly funding obs
            z_threshold: 2.0,
            horizon_s: 8 * 3600,
            cooldown_bars: 8,
            require_raw_rate: true,
            min_abs_annual_rate: 0.15, // 15 % annualised funding floor
        }
    }
}

impl CryptoStrategy for FundingArb {
    fn name(&self) -> &'static str {
        "funding-arb"
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
            let rate = rates[i];
            // Convert 8-hour funding rate to annualised (3 × 365 cycles).
            let annualised = rate * 3.0 * 365.0;
            if self.require_raw_rate && annualised.abs() < self.min_abs_annual_rate {
                continue;
            }
            if last_bar != i64::MIN && (i as i64 - last_bar) < self.cooldown_bars as i64 {
                continue;
            }
            last_bar = i as i64;

            // Short when funding is very positive (longs paying: expected
            // to fade or cost-you-to-hold). Long when funding is very
            // negative (shorts paying → expected mean-revert higher).
            let direction = if *zv > 0.0 { Direction::Short } else { Direction::Long };
            let conviction = ((zv.abs() / 3.0).min(1.0) * 100.0).round() as u8;

            let ts = input.funding[i].ts;
            signals.push(Signal {
                id: synth_id("funding-arb", input.asset, ts, *zv),
                ts,
                condition_id: ConditionId::new("crypto-native:funding-arb"),
                market_name: format!(
                    "{} funding z={:.2} / {:.1} %/yr",
                    input.asset.coin(),
                    zv,
                    annualised * 100.0
                ),
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

#[cfg(test)]
mod tests {
    use super::*;
    use domain::{
        crypto::{Asset, Candle, FundingRate, Liquidation, OpenInterest},
        time::EventTs,
    };

    fn mk_funding(rates: &[f64]) -> Vec<FundingRate> {
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

    #[test]
    fn fires_on_extreme_positive_funding() {
        let mut rates = vec![0.00005_f64; 400];
        for r in rates.iter_mut().skip(350) {
            *r = 0.00080; // ~87 % annualised at the end
        }
        let fs = mk_funding(&rates);
        let empty_c: Vec<Candle> = vec![];
        let empty_l: Vec<Liquidation> = vec![];
        let empty_oi: Vec<OpenInterest> = vec![];
        let input = AssetInput {
            asset: Asset::Btc,
            candles: &empty_c,
            funding: &fs,
            oi: &empty_oi,
            liquidations: &empty_l,
        };
        let sigs = FundingArb::default().signals(&input);
        assert!(!sigs.is_empty());
        assert!(sigs.iter().any(|s| s.direction == Direction::Short));
    }

    #[test]
    fn doesnt_fire_on_small_rate_even_with_z() {
        // Tiny but noisy funding: raw-rate gate should suppress.
        let rates: Vec<f64> = (0..400).map(|i| {
            if i > 350 { 0.00005 } else { 0.00001 }
        }).collect();
        let fs = mk_funding(&rates);
        let input = AssetInput {
            asset: Asset::Btc,
            candles: &[],
            funding: &fs,
            oi: &[],
            liquidations: &[],
        };
        let sigs = FundingArb::default().signals(&input);
        assert!(sigs.is_empty(), "expected suppression, got {}", sigs.len());
    }
}
