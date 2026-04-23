//! Signed-conviction ensemble across crypto-native strategies.
//!
//! Sums signed conviction from each member strategy on each bar. Fires
//! when |net| exceeds `min_net`.

use std::collections::BTreeMap;

use domain::{
    crypto::Asset,
    ids::ConditionId,
    signal::{Direction, Signal},
    time::EventTs,
};

use crate::crypto_native::{AssetInput, CryptoStrategy};

pub struct Ensemble {
    pub members: Vec<Box<dyn CryptoStrategy + Send + Sync>>,
    /// Per-member weight (same length as `members`). Used to scale
    /// conviction before summing. Pass equal weights for naive ensemble.
    pub weights: Vec<f64>,
    pub min_net: i32,
    pub horizon_s: i64,
    pub name: &'static str,
}

impl Default for Ensemble {
    fn default() -> Self {
        use crate::crypto_native::{
            funding_rev::FundingReversion, liq_fade::LiquidationFade, oi_div::OiDivergence,
            vol_bo::VolBreakout,
        };
        let members: Vec<Box<dyn CryptoStrategy + Send + Sync>> = vec![
            Box::new(FundingReversion::default()),
            Box::new(OiDivergence::default()),
            Box::new(LiquidationFade::default()),
            Box::new(VolBreakout::default()),
        ];
        let n = members.len();
        Self {
            members,
            weights: vec![1.0; n],
            min_net: 75,
            horizon_s: 8 * 3600,
            name: "ensemble",
        }
    }
}

impl Ensemble {
    /// Trend-biased ensemble — all mean-reverters flipped to follow trend.
    pub fn trend() -> Self {
        use crate::crypto_native::{
            funding_rev::FundingReversion, liq_fade::LiquidationFade, oi_div::OiDivergence,
            vol_bo::VolBreakout,
        };
        let members: Vec<Box<dyn CryptoStrategy + Send + Sync>> = vec![
            Box::new(FundingReversion::trend()),
            Box::new(OiDivergence::trend()),
            Box::new(LiquidationFade::trend()),
            Box::new(VolBreakout::default()),
        ];
        let n = members.len();
        Self {
            members,
            weights: vec![1.0; n],
            min_net: 75,
            horizon_s: 8 * 3600,
            name: "ensemble-trend",
        }
    }
}

impl CryptoStrategy for Ensemble {
    fn name(&self) -> &'static str {
        self.name
    }

    fn signals(&self, input: &AssetInput) -> Vec<Signal> {
        let mut per_ts: BTreeMap<i64, f64> = BTreeMap::new();
        for (m, w) in self.members.iter().zip(self.weights.iter()) {
            for s in m.signals(input) {
                let sign = if s.direction == Direction::Long { 1.0 } else { -1.0 };
                *per_ts.entry(s.ts.0).or_insert(0.0) += sign * f64::from(s.conviction) * w;
            }
        }

        let mut signals = Vec::new();
        for (ts, net) in per_ts {
            if net.abs() < f64::from(self.min_net) {
                continue;
            }
            let direction = if net > 0.0 { Direction::Long } else { Direction::Short };
            signals.push(build_signal(input.asset, EventTs::from_secs(ts), direction, net, self.horizon_s, self.name));
        }
        signals
    }
}

fn build_signal(asset: Asset, ts: EventTs, direction: Direction, net: f64, horizon: i64, name: &str) -> Signal {
    Signal {
        id: format!("{name}:{}:{}:{:.0}", asset.coin(), ts.0, net),
        ts,
        condition_id: ConditionId::new("crypto-native:ensemble"),
        market_name: format!("{} {} net={:+.0}", asset.coin(), name, net),
        asset,
        direction,
        swp: 0.5 + (net / 400.0).tanh() * 0.5,
        mid: 0.5,
        edge: net.abs() / 100.0,
        is_pm: 0.0,
        granger_f: 0.0,
        gini: 0.0,
        conviction: (net.abs().min(100.0)) as u8,
        horizon_s: horizon,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_members_no_signals() {
        let e = Ensemble {
            members: vec![],
            weights: vec![],
            min_net: 10,
            horizon_s: 3600,
            name: "ensemble-test",
        };
        let input = AssetInput {
            asset: Asset::Btc,
            candles: &[],
            funding: &[],
            oi: &[],
            liquidations: &[],
        };
        assert!(e.signals(&input).is_empty());
    }
}
