//! Liquidation-cascade fade.
//!
//! A large sell-side liquidation cluster (shorts forced to buy back) is
//! often the last leg of a move — once the forced-buyer supply is
//! exhausted, price tends to fade. We short after outsized sell-liq
//! spikes and long after outsized buy-liq spikes.
//!
//! Method: per-hour liquidation *net* volume = `buy_usd - sell_usd`.
//! Z-score this on a 48-hour rolling window. When |z| > threshold, fire.
//! Direction is **opposite** to the sign of the spike.

use domain::{
    crypto::LiqSide,
    ids::ConditionId,
    signal::{Direction, Signal},
    time::EventTs,
};

use crate::crypto_native::funding_rev::synth_id;
use crate::crypto_native::{rolling_zscore, AssetInput, CryptoStrategy};

pub struct LiquidationFade {
    pub z_window: usize,
    pub z_threshold: f64,
    pub horizon_s: i64,
    pub cooldown_bars: usize,
    pub trend_follow: bool,
    pub strategy_name: &'static str,
}

impl Default for LiquidationFade {
    fn default() -> Self {
        Self {
            z_window: 48,
            z_threshold: 2.5,
            horizon_s: 4 * 3600,
            cooldown_bars: 6,
            trend_follow: false,
            strategy_name: "liq-fade",
        }
    }
}

impl LiquidationFade {
    pub fn trend() -> Self {
        Self {
            trend_follow: true,
            strategy_name: "liq-trend",
            ..Self::default()
        }
    }
}

impl CryptoStrategy for LiquidationFade {
    fn name(&self) -> &'static str {
        self.strategy_name
    }

    fn signals(&self, input: &AssetInput) -> Vec<Signal> {
        if input.liquidations.is_empty() {
            return vec![];
        }
        // Build an hourly-bucketed net-liquidation series.
        use std::collections::BTreeMap;
        let mut bucket: BTreeMap<i64, f64> = BTreeMap::new();
        for l in input.liquidations {
            let sign = if matches!(l.side, LiqSide::Buy) { 1.0 } else { -1.0 };
            *bucket.entry(l.ts.0).or_insert(0.0) += sign * l.volume_usd;
        }
        let series: Vec<(i64, f64)> = bucket.into_iter().collect();
        let values: Vec<f64> = series.iter().map(|(_, v)| *v).collect();
        let z = rolling_zscore(&values, self.z_window);

        let mut signals = Vec::new();
        let mut last_bar: i64 = i64::MIN;
        for (i, zi) in z.iter().enumerate() {
            let Some(zv) = zi else { continue };
            if zv.abs() < self.z_threshold {
                continue;
            }
            if last_bar != i64::MIN && (i as i64 - last_bar) < self.cooldown_bars as i64 {
                continue;
            }
            last_bar = i as i64;

            // Fade (default) vs trend-follow (common in squeezes).
            let fade_dir = if *zv > 0.0 { Direction::Short } else { Direction::Long };
            let direction = if self.trend_follow {
                match fade_dir {
                    Direction::Long => Direction::Short,
                    Direction::Short => Direction::Long,
                }
            } else {
                fade_dir
            };
            let conviction = ((zv.abs() / 4.0).min(1.0) * 100.0).round() as u8;
            let ts = EventTs::from_secs(series[i].0);
            signals.push(Signal {
                id: synth_id("liq-fade", input.asset, ts, *zv),
                ts,
                condition_id: ConditionId::new("crypto-native:liq-fade"),
                market_name: format!("{} net-liq z={:.2}", input.asset.coin(), zv),
                asset: input.asset,
                direction,
                swp: 0.5 - zv.tanh() * 0.5,
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
        crypto::{Asset, Candle, FundingRate, LiqSide, Liquidation, OpenInterest},
        time::EventTs,
    };

    #[test]
    fn fires_on_buy_liq_spike() {
        // Baseline: small sell-side liqs. Then one massive buy-side spike.
        let mut liqs = Vec::new();
        for i in 0..100 {
            liqs.push(Liquidation {
                ts: EventTs::from_secs(i as i64 * 3600),
                side: LiqSide::Sell,
                volume_usd: 10_000.0,
            });
        }
        // Massive buy-side spike at the end
        liqs.push(Liquidation {
            ts: EventTs::from_secs(100 * 3600),
            side: LiqSide::Buy,
            volume_usd: 5_000_000.0,
        });
        let input = AssetInput {
            asset: Asset::Eth,
            candles: &[],
            funding: &[],
            oi: &[],
            liquidations: &liqs,
        };
        let sigs = LiquidationFade::default().signals(&input);
        assert!(!sigs.is_empty(), "expected at least one signal");
        assert!(sigs.iter().any(|s| s.direction == Direction::Short));
    }

    #[test]
    fn quiet_market_no_signals() {
        let liqs: Vec<_> = (0..200)
            .map(|i| Liquidation {
                ts: EventTs::from_secs(i as i64 * 3600),
                side: if i % 2 == 0 { LiqSide::Buy } else { LiqSide::Sell },
                volume_usd: 10_000.0,
            })
            .collect();
        let input = AssetInput {
            asset: Asset::Btc,
            candles: &[],
            funding: &[],
            oi: &[],
            liquidations: &liqs,
        };
        assert!(LiquidationFade::default().signals(&input).is_empty());
    }
}
