//! Parameter variants of the liquidation-cascade trend strategy.
//!
//! The base `LiquidationFade::trend()` uses z_threshold=2.5 (standard).
//! Here we expose a constructor that lets the grid-search binary sweep
//! over thresholds without hand-writing each instance.

use crate::crypto_native::liq_fade::LiquidationFade;

pub fn liq_trend_with(z_threshold: f64, horizon_hours: i64, cooldown_bars: usize) -> LiquidationFade {
    LiquidationFade {
        z_threshold,
        horizon_s: horizon_hours * 3600,
        cooldown_bars,
        trend_follow: true,
        strategy_name: Box::leak(
            format!(
                "liq-trend(z{:.1},h{}h,cd{})",
                z_threshold, horizon_hours, cooldown_bars
            )
            .into_boxed_str(),
        ),
        ..LiquidationFade::trend()
    }
}
