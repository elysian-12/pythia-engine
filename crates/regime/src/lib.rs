//! Regime detection.
//!
//! Classifies the current market into one of four regimes based on
//! recent price action. The classification is rolling-window cheap
//! (O(N) over the window size) and refreshes on every bar close.
//!
//! Consumer: the portfolio allocator reads `Regime` to tilt risk weights
//! between trend-follow and mean-revert strategies.

#![deny(unused_must_use)]

use domain::crypto::Candle;
use serde::{Deserialize, Serialize};

/// Market regime a.k.a. "which strategies should be in favour right now."
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Regime {
    /// Strong directional move, low-to-moderate volatility. Favour
    /// trend-followers: `liq-trend`, `vol-breakout`, `oi-momentum`.
    Trending,
    /// Choppy, mean-reverting, normal vol. Favour `funding-arb` and
    /// `xsec-momentum`.
    Ranging,
    /// High realised vol + no clear direction. Halve all position sizes
    /// and require confluence of ≥ 2 strategies before firing.
    Chaotic,
    /// Low vol + no direction. Enable low-z-threshold variants to pick
    /// up the smaller moves.
    Calm,
}

impl Regime {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trending => "trending",
            Self::Ranging => "ranging",
            Self::Chaotic => "chaotic",
            Self::Calm => "calm",
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct RegimeSnapshot {
    pub regime: Regime,
    /// Normalised directional-strength score ∈ [0, 1]. 1 = deterministic
    /// trend, 0 = pure mean-revert.
    pub directional: f64,
    /// Recent realised vol as a fraction of the long-run median.
    pub vol_ratio: f64,
}

#[derive(Clone, Debug)]
pub struct RegimeCfg {
    /// Directional-strength threshold above which we're "trending".
    pub dir_trend: f64,
    /// Vol ratio above which we're "chaotic" (if not trending) or the
    /// high side of trending if already trending.
    pub vol_chaotic: f64,
    /// Vol ratio below which we're "calm".
    pub vol_calm: f64,
    /// Lookback in bars.
    pub window: usize,
}

impl Default for RegimeCfg {
    fn default() -> Self {
        Self {
            dir_trend: 0.55,
            vol_chaotic: 1.8,
            vol_calm: 0.55,
            window: 72,
        }
    }
}

/// Classify the current regime from a rolling window of candles.
///
/// The directional score is `|net_move| / sum(|bar_ranges|)` over the
/// window — an ADX-like cheap proxy that's bounded ∈ [0, 1] and
/// correlates well with textbook ADX in practice.
pub fn classify(candles: &[Candle], cfg: &RegimeCfg) -> Option<RegimeSnapshot> {
    if candles.len() < cfg.window + 1 {
        return None;
    }
    let start = candles.len() - cfg.window;
    let win = &candles[start..];

    let net_move = (win.last()?.close - win.first()?.open).abs();
    let sum_ranges: f64 = win.iter().map(|c| (c.high - c.low).abs()).sum();
    let directional = if sum_ranges > 0.0 { (net_move / sum_ranges).min(1.0) } else { 0.0 };

    // Realised vol: std of log-returns across window, annualised.
    let returns: Vec<f64> = win
        .windows(2)
        .map(|w| (w[1].close / w[0].close.max(1e-9)).ln())
        .collect();
    let mean: f64 = returns.iter().sum::<f64>() / returns.len().max(1) as f64;
    let var: f64 = returns.iter().map(|r| (r - mean).powi(2)).sum::<f64>()
        / returns.len().max(1) as f64;
    let realised = var.sqrt();

    // Long-run median vol: use the full candle history past the window
    // as the reference. If we don't have more history, default to
    // realised itself (vol_ratio = 1).
    let reference = if candles.len() >= cfg.window * 4 {
        let full: Vec<f64> = candles
            .windows(2)
            .map(|w| (w[1].close / w[0].close.max(1e-9)).ln())
            .collect();
        let m: f64 = full.iter().sum::<f64>() / full.len() as f64;
        let v: f64 = full.iter().map(|r| (r - m).powi(2)).sum::<f64>() / full.len() as f64;
        v.sqrt().max(1e-9)
    } else {
        realised.max(1e-9)
    };
    let vol_ratio = realised / reference;

    let regime = if directional >= cfg.dir_trend {
        Regime::Trending
    } else if vol_ratio >= cfg.vol_chaotic {
        Regime::Chaotic
    } else if vol_ratio <= cfg.vol_calm {
        Regime::Calm
    } else {
        Regime::Ranging
    };

    Some(RegimeSnapshot {
        regime,
        directional,
        vol_ratio,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::time::EventTs;

    fn make_candles(n: usize, f: impl Fn(usize) -> (f64, f64, f64, f64)) -> Vec<Candle> {
        (0..n)
            .map(|i| {
                let (o, h, l, c) = f(i);
                Candle {
                    ts: EventTs::from_secs(i as i64 * 3600),
                    open: o,
                    high: h,
                    low: l,
                    close: c,
                    volume: 1.0,
                }
            })
            .collect()
    }

    #[test]
    fn trending_up_detected() {
        let c = make_candles(400, |i| {
            let p = 100.0 + i as f64 * 0.5;
            (p, p + 0.3, p - 0.3, p + 0.5)
        });
        let s = classify(&c, &RegimeCfg::default()).unwrap();
        assert_eq!(s.regime, Regime::Trending, "dir={:.2} vol={:.2}", s.directional, s.vol_ratio);
    }

    #[test]
    fn ranging_market_detected() {
        let c = make_candles(400, |i| {
            let p = 100.0 + ((i as f64) * 0.1).sin() * 3.0;
            (p, p + 0.6, p - 0.6, p)
        });
        let s = classify(&c, &RegimeCfg::default()).unwrap();
        assert!(matches!(s.regime, Regime::Ranging | Regime::Calm),
                "got {:?} dir={:.2} vol={:.2}", s.regime, s.directional, s.vol_ratio);
    }

    #[test]
    fn insufficient_data() {
        let c = make_candles(10, |_| (100.0, 100.5, 99.5, 100.0));
        assert!(classify(&c, &RegimeCfg::default()).is_none());
    }
}
