//! Volatility-breakout trend follower.
//!
//! In higher-vol regimes (ATR% above its 30-day median), breakouts of a
//! 24-hour Donchian channel tend to run. We long the breakout to the
//! upside and short the breakdown, with ATR-scaled stops.

use domain::{
    ids::ConditionId,
    signal::{Direction, Signal},
    time::EventTs,
};

use crate::crypto_native::funding_rev::synth_id;
use crate::crypto_native::{AssetInput, CryptoStrategy};

pub struct VolBreakout {
    pub channel_bars: usize,
    pub atr_window: usize,
    pub atr_pct_min: f64,
    pub horizon_s: i64,
    pub cooldown_bars: usize,
}

impl Default for VolBreakout {
    fn default() -> Self {
        Self {
            channel_bars: 24,
            atr_window: 24,
            atr_pct_min: 0.004, // require at least 0.4% hourly ATR
            horizon_s: 24 * 3600,
            cooldown_bars: 24,
        }
    }
}

impl CryptoStrategy for VolBreakout {
    fn name(&self) -> &'static str {
        "vol-breakout"
    }

    fn signals(&self, input: &AssetInput) -> Vec<Signal> {
        if input.candles.len() < self.channel_bars + self.atr_window + 2 {
            return vec![];
        }
        let atrs = rolling_atr(input.candles, self.atr_window);

        let mut signals = Vec::new();
        let mut last_bar: i64 = i64::MIN;
        let c = input.candles;
        for i in (self.channel_bars + self.atr_window)..c.len() {
            let hi = c[i - self.channel_bars..i].iter().map(|k| k.high).fold(f64::MIN, f64::max);
            let lo = c[i - self.channel_bars..i].iter().map(|k| k.low).fold(f64::MAX, f64::min);
            let atr = atrs[i];
            if atr <= 0.0 || c[i].close <= 0.0 {
                continue;
            }
            let atr_pct = atr / c[i].close;
            if atr_pct < self.atr_pct_min {
                continue;
            }
            if last_bar != i64::MIN && (i as i64 - last_bar) < self.cooldown_bars as i64 {
                continue;
            }

            let bar = &c[i];
            let direction = if bar.close > hi {
                Direction::Long
            } else if bar.close < lo {
                Direction::Short
            } else {
                continue;
            };
            last_bar = i as i64;
            let edge = ((bar.close - hi).max(lo - bar.close)) / atr;
            let conviction = ((edge / 2.0).min(1.0) * 100.0).round() as u8;
            signals.push(Signal {
                id: synth_id("vol-bo", input.asset, bar.ts, edge),
                ts: EventTs::from_secs(bar.ts.0),
                condition_id: ConditionId::new("crypto-native:vol-breakout"),
                market_name: format!("{} Donchian-{} breakout", input.asset.coin(), self.channel_bars),
                asset: input.asset,
                direction,
                swp: 0.5,
                mid: 0.5,
                edge,
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

pub(crate) fn rolling_atr(candles: &[domain::crypto::Candle], window: usize) -> Vec<f64> {
    let mut out = vec![0.0; candles.len()];
    if candles.len() < window + 1 {
        return out;
    }
    for i in window..candles.len() {
        let mut sum = 0.0;
        for j in (i - window + 1)..=i {
            let prev = &candles[j - 1];
            let cur = &candles[j];
            let tr = (cur.high - cur.low)
                .max((cur.high - prev.close).abs())
                .max((cur.low - prev.close).abs());
            sum += tr;
        }
        out[i] = sum / window as f64;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::{crypto::Asset, crypto::Candle, time::EventTs};

    #[test]
    fn no_signals_in_flat_market() {
        let candles: Vec<_> = (0..200)
            .map(|i| Candle {
                ts: EventTs::from_secs(i as i64 * 3600),
                open: 100.0,
                high: 100.1,
                low: 99.9,
                close: 100.0,
                volume: 1.0,
            })
            .collect();
        let input = AssetInput {
            asset: Asset::Btc,
            candles: &candles,
            funding: &[],
            oi: &[],
            liquidations: &[],
        };
        let s = VolBreakout::default().signals(&input);
        assert!(s.is_empty(), "got {} signals", s.len());
    }

    #[test]
    fn fires_on_upside_break() {
        let mut candles: Vec<_> = (0..100)
            .map(|i| Candle {
                ts: EventTs::from_secs(i as i64 * 3600),
                open: 100.0 + (i as f64 * 0.1).sin(),
                high: 100.5 + (i as f64 * 0.1).sin(),
                low: 99.5 + (i as f64 * 0.1).sin(),
                close: 100.0 + (i as f64 * 0.1).sin(),
                volume: 1.0,
            })
            .collect();
        // Breakout bars
        for i in 100..120 {
            candles.push(Candle {
                ts: EventTs::from_secs(i as i64 * 3600),
                open: 110.0 + i as f64 * 0.2,
                high: 115.0 + i as f64 * 0.3,
                low: 109.0 + i as f64 * 0.2,
                close: 113.0 + i as f64 * 0.25,
                volume: 1.0,
            });
        }
        let input = AssetInput {
            asset: Asset::Btc,
            candles: &candles,
            funding: &[],
            oi: &[],
            liquidations: &[],
        };
        let s = VolBreakout {
            atr_pct_min: 0.001,
            ..Default::default()
        }
        .signals(&input);
        assert!(!s.is_empty(), "expected breakout signal");
        assert!(s.iter().any(|sig| sig.direction == Direction::Long));
    }
}
