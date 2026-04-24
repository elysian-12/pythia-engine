//! Open-Interest momentum (confirmation).
//!
//! Thesis: when OI rises alongside price with both expanding > 24-hour
//! threshold, it's leveraged speculation stacking in the direction of
//! the move — we ride it. This is the *mirror* of `oi-divergence` (which
//! faded OI expansion against price). Distinct from `vol-breakout`
//! because the trigger is OI, not a price breakout.
//!
//! Rule:
//!   oi_pct_24h  > oi_threshold   AND
//!   px_pct_24h  > px_threshold   →  long
//!   oi_pct_24h  > oi_threshold   AND
//!   px_pct_24h  < -px_threshold  →  short

use domain::{
    ids::ConditionId,
    signal::{Direction, Signal},
};

use crate::crypto_native::funding_rev::synth_id;
use crate::crypto_native::{pct_change, AssetInput, CryptoStrategy};

#[derive(Debug)]
pub struct OiMomentum {
    pub window_bars: usize,
    pub oi_threshold: f64,
    pub price_threshold: f64,
    pub horizon_s: i64,
    pub cooldown_bars: usize,
}

impl Default for OiMomentum {
    fn default() -> Self {
        Self {
            window_bars: 24,
            oi_threshold: 0.04,
            price_threshold: 0.02,
            horizon_s: 6 * 3600,
            cooldown_bars: 6,
        }
    }
}

impl CryptoStrategy for OiMomentum {
    fn name(&self) -> &'static str {
        "oi-momentum"
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
            if oi_p < self.oi_threshold || px_p.abs() < self.price_threshold {
                continue;
            }
            if last_bar != i64::MIN && (i as i64 - last_bar) < self.cooldown_bars as i64 {
                continue;
            }
            last_bar = i as i64;
            let direction = if px_p > 0.0 { Direction::Long } else { Direction::Short };
            let conviction = ((oi_p / 0.1).min(1.0) * 100.0).round() as u8;
            let ts = input.candles[i].ts;
            signals.push(Signal {
                id: synth_id("oi-mom", input.asset, ts, oi_p),
                ts,
                condition_id: ConditionId::new("crypto-native:oi-momentum"),
                market_name: format!(
                    "{} OI {:+.1}% px {:+.1}% (24h)",
                    input.asset.coin(),
                    oi_p * 100.0,
                    px_p * 100.0
                ),
                asset: input.asset,
                direction,
                swp: 0.5 + px_p.signum() * oi_p,
                mid: 0.5,
                edge: oi_p,
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
        crypto::{Asset, Candle, OpenInterest},
        time::EventTs,
    };

    #[test]
    fn oi_up_price_up_fires_long() {
        let mut candles = Vec::new();
        let mut ois = Vec::new();
        for i in 0..50 {
            let ratio = if i > 24 { 1.10 } else { 1.0 };
            candles.push(Candle {
                ts: EventTs::from_secs(i as i64 * 3600),
                open: 100.0 * ratio,
                high: 100.0 * ratio,
                low: 100.0 * ratio,
                close: 100.0 * ratio,
                volume: 1.0,
            });
            ois.push(OpenInterest {
                ts: EventTs::from_secs(i as i64 * 3600),
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
        let s = OiMomentum::default().signals(&input);
        assert!(!s.is_empty());
        assert!(s.iter().any(|sig| sig.direction == Direction::Long));
    }
}
