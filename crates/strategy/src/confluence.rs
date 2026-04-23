//! Confluence filter: require N of M confirmations before taking a signal.
//!
//! Each filter returns a boolean per bar. Signals are kept only when the
//! number of `true` filters at the signal bar meets `min_required`.
//!
//! This is the "more confidence" layer — raw per-strategy signals are
//! noisy; requiring cross-confirmation cuts trade count by ~50-70% and
//! raises the win-rate of surviving signals (empirical rule of thumb).

use domain::{
    crypto::{Candle, FundingRate},
    signal::{Direction, Signal},
};

use crate::crypto_native::{pct_change, rolling_zscore};

#[derive(Clone, Debug)]
pub struct ConfluenceCfg {
    pub min_required: usize,
    pub adx_min: f64,
    pub atr_pct_min: f64,
    pub atr_pct_max: f64,
    pub volume_ratio_min: f64,
    pub volume_window: usize,
    pub trend_window_hours: usize,
    /// When true, same-signed 24h move is required (trend alignment).
    pub require_trend_alignment: bool,
}

impl Default for ConfluenceCfg {
    fn default() -> Self {
        Self {
            min_required: 3,
            adx_min: 20.0,
            atr_pct_min: 0.003,
            atr_pct_max: 0.025,
            volume_ratio_min: 0.5,
            volume_window: 30 * 24,
            trend_window_hours: 24,
            require_trend_alignment: true,
        }
    }
}

/// Apply the confluence filter to a slice of signals. Signals must be
/// sorted by timestamp. Returns the kept subset plus a per-filter tally
/// of drops for the report.
pub fn filter_signals(
    signals: &[Signal],
    candles: &[Candle],
    funding: &[FundingRate],
    cfg: &ConfluenceCfg,
) -> FilterResult {
    let mut kept = Vec::new();
    let mut drops = Drops::default();

    if candles.is_empty() {
        return FilterResult {
            kept: signals.to_vec(),
            drops,
        };
    }

    // Pre-compute filter series once — O(N) each.
    let closes: Vec<f64> = candles.iter().map(|c| c.close).collect();
    let volumes: Vec<f64> = candles.iter().map(|c| c.volume).collect();
    let atr_pct = atr_percent(candles, 14);
    let vol_ratio = volume_ratio(&volumes, cfg.volume_window);
    let trend_24h = pct_change(&closes, cfg.trend_window_hours);
    let adx = simple_directional_strength(candles, 14);
    // Funding rate z-score for alignment
    let funding_series: Vec<f64> = funding.iter().map(|f| f.rate_close).collect();
    let funding_z = rolling_zscore(&funding_series, 24);

    for sig in signals {
        let idx = match candles.binary_search_by_key(&sig.ts.0, |c| c.ts.0) {
            Ok(i) => i,
            Err(i) => i.saturating_sub(1),
        };
        if idx >= candles.len() {
            drops.stale_bar += 1;
            continue;
        }

        let mut votes = 0usize;

        // Regime: ADX-like directional strength.
        if adx.get(idx).copied().unwrap_or(0.0) >= cfg.adx_min {
            votes += 1;
        } else {
            drops.regime += 1;
        }

        // Volatility band.
        let ap = atr_pct.get(idx).copied().unwrap_or(0.0);
        if ap >= cfg.atr_pct_min && ap <= cfg.atr_pct_max {
            votes += 1;
        } else {
            drops.volatility += 1;
        }

        // Liquidity.
        if vol_ratio.get(idx).copied().unwrap_or(0.0) >= cfg.volume_ratio_min {
            votes += 1;
        } else {
            drops.liquidity += 1;
        }

        // Trend alignment: 24h move in signal direction.
        if let Some(t24) = trend_24h.get(idx).copied().flatten() {
            let aligned = match sig.direction {
                Direction::Long => t24 > 0.0,
                Direction::Short => t24 < 0.0,
            };
            if aligned || !cfg.require_trend_alignment {
                votes += 1;
            } else {
                drops.trend_alignment += 1;
            }
        }

        // Funding alignment: funding z-score has same sign as signal.
        if let Some(Some(z)) = funding_z.get(
            funding
                .binary_search_by_key(&sig.ts.0, |f| f.ts.0)
                .unwrap_or(funding.len().saturating_sub(1))
                .min(funding.len().saturating_sub(1)),
        ).copied()
        {
            let aligned = match sig.direction {
                Direction::Long => z > 0.0,
                Direction::Short => z < 0.0,
            };
            if aligned {
                votes += 1;
            } else {
                drops.funding_alignment += 1;
            }
        }

        if votes >= cfg.min_required {
            kept.push(sig.clone());
        } else {
            drops.insufficient_votes += 1;
        }
    }
    FilterResult { kept, drops }
}

#[derive(Debug, Clone, Default)]
pub struct Drops {
    pub regime: usize,
    pub volatility: usize,
    pub liquidity: usize,
    pub trend_alignment: usize,
    pub funding_alignment: usize,
    pub insufficient_votes: usize,
    pub stale_bar: usize,
}

#[derive(Debug, Clone)]
pub struct FilterResult {
    pub kept: Vec<Signal>,
    pub drops: Drops,
}

fn atr_percent(candles: &[Candle], window: usize) -> Vec<f64> {
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
        let atr = sum / window as f64;
        out[i] = if candles[i].close > 0.0 { atr / candles[i].close } else { 0.0 };
    }
    out
}

fn volume_ratio(volumes: &[f64], window: usize) -> Vec<f64> {
    let mut out = vec![0.0; volumes.len()];
    if volumes.len() < window {
        return out;
    }
    for i in window..volumes.len() {
        let sum: f64 = volumes[i - window..i].iter().sum();
        let median = if sum > 0.0 { sum / window as f64 } else { 1.0 };
        out[i] = volumes[i] / median.max(1e-9);
    }
    out
}

/// Simple ADX-like directional strength based on the ratio of absolute
/// 14-bar price change to the sum of absolute bar ranges. Not the
/// textbook ADX; cheaper and positively correlated with it.
fn simple_directional_strength(candles: &[Candle], window: usize) -> Vec<f64> {
    let mut out = vec![0.0; candles.len()];
    if candles.len() < window + 1 {
        return out;
    }
    for i in window..candles.len() {
        let start = i - window;
        let net_move = (candles[i].close - candles[start].close).abs();
        let sum_tr: f64 = (start + 1..=i)
            .map(|j| (candles[j].high - candles[j].low).abs())
            .sum();
        out[i] = if sum_tr > 0.0 { 100.0 * net_move / sum_tr } else { 0.0 };
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::{
        crypto::{Asset, Candle, FundingRate},
        ids::ConditionId,
        signal::{Direction, Signal},
        time::EventTs,
    };

    fn mk_signal(ts: i64, dir: Direction) -> Signal {
        Signal {
            id: format!("s{ts}"),
            ts: EventTs::from_secs(ts),
            condition_id: ConditionId::new("t"),
            market_name: "t".into(),
            asset: Asset::Btc,
            direction: dir,
            swp: 0.5,
            mid: 0.5,
            edge: 0.1,
            is_pm: 0.0,
            granger_f: 0.0,
            gini: 0.0,
            conviction: 80,
            horizon_s: 3600,
        }
    }

    fn mk_candles(n: usize, trend_up: bool) -> Vec<Candle> {
        (0..n)
            .map(|i| {
                let base = if trend_up { 100.0 + i as f64 * 0.5 } else { 100.0 - i as f64 * 0.5 };
                Candle {
                    ts: EventTs::from_secs(i as i64 * 3600),
                    open: base,
                    high: base + 1.0,
                    low: base - 1.0,
                    close: base,
                    volume: 1_000.0,
                }
            })
            .collect()
    }

    #[test]
    fn upward_trend_keeps_long_signal() {
        let candles = mk_candles(200, true);
        let funding: Vec<FundingRate> = (0..200)
            .map(|i| FundingRate {
                ts: EventTs::from_secs(i as i64 * 3600),
                rate_open: 0.0001,
                rate_close: 0.0001,
                predicted_close: None,
            })
            .collect();
        let sigs = vec![mk_signal(180 * 3600, Direction::Long)];
        let result = filter_signals(
            &sigs,
            &candles,
            &funding,
            &ConfluenceCfg {
                min_required: 2,
                ..Default::default()
            },
        );
        assert!(!result.kept.is_empty());
    }

    #[test]
    fn counter_trend_short_gets_dropped_when_alignment_required() {
        let candles = mk_candles(200, true);
        let funding: Vec<FundingRate> = (0..200)
            .map(|i| FundingRate {
                ts: EventTs::from_secs(i as i64 * 3600),
                rate_open: 0.0001,
                rate_close: 0.0001,
                predicted_close: None,
            })
            .collect();
        // Short in an uptrend with high confluence requirement.
        let sigs = vec![mk_signal(180 * 3600, Direction::Short)];
        let result = filter_signals(
            &sigs,
            &candles,
            &funding,
            &ConfluenceCfg {
                min_required: 4,
                ..Default::default()
            },
        );
        assert!(result.kept.is_empty());
        assert!(result.drops.trend_alignment > 0 || result.drops.insufficient_votes > 0);
    }
}
