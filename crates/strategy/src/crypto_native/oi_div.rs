//! Open-interest / price divergence.
//!
//! When open interest expands while price declines, leveraged shorts are
//! stacking — a crowded setup prone to squeeze. Conversely, OI expansion
//! with rising price flags a crowded long. We fade both.
//!
//! Signal rule (per bar *t*):
//!
//! * oi_pct = (OI[t] - OI[t - window]) / OI[t - window]
//! * px_pct = (close[t] - close[t - window]) / close[t - window]
//! * divergence = oi_pct * sign(px_pct)
//! * When oi_pct > +θ and px_pct < -θ   → **long** (short squeeze setup)
//! * When oi_pct > +θ and px_pct > +θ   → **short** (long-side euphoria)
//!
//! Conviction tracks |oi_pct| scaled to 100.

use domain::{
    ids::ConditionId,
    signal::{Direction, Signal},
};

use crate::crypto_native::{pct_change, AssetInput, CryptoStrategy};
use crate::crypto_native::funding_rev::synth_id;

pub struct OiDivergence {
    pub window_bars: usize,
    pub oi_threshold: f64,
    pub price_threshold: f64,
    pub horizon_s: i64,
    pub cooldown_bars: usize,
    pub trend_follow: bool,
    pub strategy_name: &'static str,
}

impl Default for OiDivergence {
    fn default() -> Self {
        Self {
            window_bars: 24,
            oi_threshold: 0.04,
            price_threshold: 0.02,
            horizon_s: 8 * 3600,
            cooldown_bars: 12,
            trend_follow: false,
            strategy_name: "oi-divergence",
        }
    }
}

impl OiDivergence {
    pub fn trend() -> Self {
        Self {
            trend_follow: true,
            strategy_name: "oi-trend",
            ..Self::default()
        }
    }
}

impl CryptoStrategy for OiDivergence {
    fn name(&self) -> &'static str {
        self.strategy_name
    }

    fn signals(&self, input: &AssetInput) -> Vec<Signal> {
        if input.oi.is_empty() || input.candles.is_empty() {
            return vec![];
        }
        let oi_series: Vec<f64> = input.oi.iter().map(|o| o.close).collect();
        let px_series: Vec<f64> = input.candles.iter().map(|c| c.close).collect();

        let oi_chg = pct_change(&oi_series, self.window_bars);
        let px_chg = pct_change(&px_series, self.window_bars);

        let mut signals = Vec::new();
        let mut last_bar: i64 = i64::MIN;
        let n = oi_chg.len().min(px_chg.len()).min(input.candles.len());
        for i in self.window_bars..n {
            let (Some(oi_p), Some(px_p)) = (oi_chg[i], px_chg[i]) else {
                continue;
            };
            if oi_p.abs() < self.oi_threshold || px_p.abs() < self.price_threshold {
                continue;
            }
            if last_bar != i64::MIN && (i as i64 - last_bar) < self.cooldown_bars as i64 {
                continue;
            }
            last_bar = i as i64;
            // Divergence fade: trade against the recent price direction when
            // OI is expanding.
            if oi_p <= 0.0 {
                continue; // only fade expansion, not unwind
            }
            let mean_revert_dir = if px_p > 0.0 { Direction::Short } else { Direction::Long };
            let direction = if self.trend_follow {
                match mean_revert_dir {
                    Direction::Long => Direction::Short,
                    Direction::Short => Direction::Long,
                }
            } else {
                mean_revert_dir
            };
            let conviction = ((oi_p / 0.1).min(1.0) * 100.0).round() as u8;
            let ts = input.candles[i].ts;
            signals.push(Signal {
                id: synth_id("oi-div", input.asset, ts, oi_p),
                ts,
                condition_id: ConditionId::new("crypto-native:oi-divergence"),
                market_name: format!(
                    "{} OI {:+.1}% / px {:+.1}% (24h)",
                    input.asset.coin(),
                    oi_p * 100.0,
                    px_p * 100.0
                ),
                asset: input.asset,
                direction,
                swp: 0.5 - px_p.signum() * oi_p,
                mid: 0.5,
                edge: oi_p.abs(),
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

    fn bars(n: usize, oi_start: f64, oi_pct: f64, px_start: f64, px_pct: f64) -> (Vec<Candle>, Vec<OpenInterest>) {
        let mut c = Vec::with_capacity(n);
        let mut o = Vec::with_capacity(n);
        for i in 0..n {
            let factor = 1.0 + (i as f64) * 0.001;
            c.push(Candle {
                ts: EventTs::from_secs(i as i64 * 3600),
                open: px_start * factor,
                high: px_start * factor * 1.002,
                low: px_start * factor * 0.998,
                close: px_start * factor,
                volume: 1.0,
            });
            o.push(OpenInterest {
                ts: EventTs::from_secs(i as i64 * 3600),
                close: oi_start * factor,
                high: oi_start * factor,
                low: oi_start * factor,
            });
            let _ = (oi_pct, px_pct);
        }
        (c, o)
    }

    #[test]
    fn fires_on_oi_expansion_rising_price() {
        // Price up + OI up → short
        let mut candles = Vec::new();
        let mut ois = Vec::new();
        for i in 0..50 {
            let t = i as i64 * 3600;
            let ratio = if i > 24 { 1.1 } else { 1.0 };
            candles.push(Candle {
                ts: EventTs::from_secs(t),
                open: 100.0 * ratio,
                high: 100.0 * ratio,
                low: 100.0 * ratio,
                close: 100.0 * ratio,
                volume: 1.0,
            });
            ois.push(OpenInterest {
                ts: EventTs::from_secs(t),
                close: 10_000.0 * ratio,
                high: 10_000.0 * ratio,
                low: 10_000.0 * ratio,
            });
        }
        let input = AssetInput {
            asset: Asset::Btc,
            candles: &candles,
            funding: &[],
            oi: &ois,
            liquidations: &[],
        };
        let signals = OiDivergence::default().signals(&input);
        assert!(!signals.is_empty());
        assert!(signals.iter().any(|s| s.direction == Direction::Short));
    }

    #[test]
    fn empty_inputs_no_signals() {
        let input = AssetInput {
            asset: Asset::Btc,
            candles: &[],
            funding: &[],
            oi: &[],
            liquidations: &[],
        };
        assert!(OiDivergence::default().signals(&input).is_empty());
    }
}
