//! Volatility-targeted sizing.
//!
//! Given a realised-vol estimate and the portfolio's target daily-vol
//! (default 1.5 %), compute the notional that keeps the portfolio near
//! the target.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VolTargetCfg {
    /// Target daily volatility as a fraction of equity (0.015 = 1.5 %).
    pub target_daily_vol: f64,
    /// Hard cap on the resulting notional as a multiple of equity.
    /// Prevents absurd sizing when realised vol is very low.
    pub max_leverage: f64,
    /// Floor for realised vol used in the denominator — avoids division
    /// explosions when the market is dead quiet.
    pub min_vol_floor: f64,
}

impl Default for VolTargetCfg {
    fn default() -> Self {
        Self {
            target_daily_vol: 0.015,
            max_leverage: 3.0,
            min_vol_floor: 0.003, // 0.3 % daily
        }
    }
}

/// Return the portfolio-level notional that targets `cfg.target_daily_vol`
/// given the realised daily vol estimate.
///
/// `equity_usd` is the current account value; `realised_daily_vol` is the
/// rolling standard deviation of daily portfolio returns (or a proxy like
/// the realised vol of BTC returns in the absence of a longer PnL history).
pub fn target_notional(
    equity_usd: f64,
    realised_daily_vol: f64,
    cfg: &VolTargetCfg,
) -> f64 {
    if equity_usd <= 0.0 {
        return 0.0;
    }
    let rv = realised_daily_vol.max(cfg.min_vol_floor);
    let scale = (cfg.target_daily_vol / rv).min(cfg.max_leverage).max(0.1);
    equity_usd * scale
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_vol_keeps_scale_near_one() {
        let n = target_notional(10_000.0, 0.015, &VolTargetCfg::default());
        assert!((n - 10_000.0).abs() < 1.0);
    }

    #[test]
    fn low_vol_scales_up_capped() {
        let n = target_notional(10_000.0, 0.001, &VolTargetCfg::default());
        // target 1.5 %, realised 0.3 % (floored) → 5× capped at 3× leverage
        assert!((n - 30_000.0).abs() < 1.0);
    }

    #[test]
    fn high_vol_scales_down() {
        let n = target_notional(10_000.0, 0.05, &VolTargetCfg::default());
        assert!(n < 4_000.0);
    }
}
