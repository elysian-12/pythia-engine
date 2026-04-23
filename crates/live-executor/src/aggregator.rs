//! Hourly liquidation aggregator.
//!
//! Keeps a fixed-size ring buffer of the last 48 hourly net-liquidation
//! values per asset, plus the current in-progress hour. On hour-boundary
//! close we roll the current bucket into the buffer and compute the
//! z-score of the just-closed hour.
//!
//! All bucket maths are O(1) using running-sum accumulators. The
//! hot-path WS handler performs exactly three field writes per incoming
//! liquidation event (bucket sum + count + last-touched ts). No locks —
//! the aggregator runs on its own task and owns its state.

use std::collections::HashMap;

use domain::crypto::LiqSide;

/// Hour bucket size in seconds.
pub const HOUR: i64 = 3600;
/// Rolling window used for z-score (48 hours).
pub const Z_WINDOW: usize = 48;

#[derive(Debug, Clone, Default)]
pub struct AggregatorSnapshot {
    pub symbol: String,
    pub bucket_ts: i64,
    pub net_usd: f64,
    pub gross_usd: f64,
    pub window_size: usize,
    pub z_score: Option<f64>,
}

#[derive(Debug, Default)]
struct HourBucket {
    net_usd: f64,
    gross_usd: f64,
    count: u32,
}

#[derive(Debug)]
pub struct AssetAggregator {
    symbol: String,
    current_ts: i64,
    initialized: bool,
    current: HourBucket,
    /// Closed hourly net values (most recent last).
    window: std::collections::VecDeque<f64>,
}

impl AssetAggregator {
    pub fn new(symbol: impl Into<String>) -> Self {
        Self {
            symbol: symbol.into(),
            current_ts: 0,
            initialized: false,
            current: HourBucket::default(),
            window: std::collections::VecDeque::with_capacity(Z_WINDOW + 1),
        }
    }

    /// Ingest one liquidation. Returns a snapshot **only when the hour
    /// has just rolled** (the caller uses this to trigger signal eval).
    pub fn on_liquidation(&mut self, ts_secs: i64, side: LiqSide, usd: f64) -> Option<AggregatorSnapshot> {
        let bucket_ts = (ts_secs / HOUR) * HOUR;
        let rollover = self.initialized && bucket_ts > self.current_ts;

        let out = if rollover {
            Some(self.close_current())
        } else {
            None
        };

        if !self.initialized || self.current_ts != bucket_ts {
            self.current = HourBucket::default();
            self.current_ts = bucket_ts;
            self.initialized = true;
        }

        let signed = match side {
            LiqSide::Buy => usd,
            LiqSide::Sell => -usd,
        };
        self.current.net_usd += signed;
        self.current.gross_usd += usd;
        self.current.count += 1;

        out
    }

    /// Force-close the current bucket (call at top of hour from a timer).
    pub fn close_current(&mut self) -> AggregatorSnapshot {
        let net = self.current.net_usd;
        let gross = self.current.gross_usd;
        let ts = self.current_ts;
        // roll into window
        self.window.push_back(net);
        while self.window.len() > Z_WINDOW {
            self.window.pop_front();
        }
        let z = zscore_last(&self.window);
        AggregatorSnapshot {
            symbol: self.symbol.clone(),
            bucket_ts: ts,
            net_usd: net,
            gross_usd: gross,
            window_size: self.window.len(),
            z_score: z,
        }
    }

    pub fn snapshot(&self) -> AggregatorSnapshot {
        let z = zscore_last(&self.window);
        AggregatorSnapshot {
            symbol: self.symbol.clone(),
            bucket_ts: self.current_ts,
            net_usd: self.current.net_usd,
            gross_usd: self.current.gross_usd,
            window_size: self.window.len(),
            z_score: z,
        }
    }
}

fn zscore_last(window: &std::collections::VecDeque<f64>) -> Option<f64> {
    if window.len() < 8 {
        return None;
    }
    let n = (window.len() - 1) as f64;
    if n < 1.0 {
        return None;
    }
    let last = *window.back()?;
    // Compute mean + std of everything *except* the last bucket — this is
    // the forward-leaning definition used throughout `econometrics::basic`.
    let prior: Vec<f64> = window.iter().take(window.len() - 1).copied().collect();
    let mean = prior.iter().sum::<f64>() / prior.len() as f64;
    let var = prior.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / prior.len() as f64;
    let sd = var.sqrt().max(1e-9);
    Some((last - mean) / sd)
}

/// Holds a per-symbol `AssetAggregator`.
#[derive(Debug, Default)]
pub struct Aggregator {
    assets: HashMap<String, AssetAggregator>,
}

impl Aggregator {
    pub fn new(symbols: &[&str]) -> Self {
        Self {
            assets: symbols
                .iter()
                .map(|s| ((*s).to_string(), AssetAggregator::new((*s).to_string())))
                .collect(),
        }
    }

    pub fn on_liquidation(
        &mut self,
        symbol: &str,
        ts_secs: i64,
        side: LiqSide,
        usd: f64,
    ) -> Option<AggregatorSnapshot> {
        self.assets
            .get_mut(symbol)
            .and_then(|a| a.on_liquidation(ts_secs, side, usd))
    }

    pub fn snapshots(&self) -> Vec<AggregatorSnapshot> {
        self.assets.values().map(|a| a.snapshot()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::crypto::LiqSide;

    #[test]
    fn rollover_produces_snapshot() {
        let mut a = AssetAggregator::new("BTCUSDT");
        // Hour 0: 3 buy liqs
        for _ in 0..3 {
            assert!(a.on_liquidation(100, LiqSide::Buy, 1_000.0).is_none());
        }
        // Hour 1: one sell liq — triggers close of hour 0
        let snap = a.on_liquidation(3700, LiqSide::Sell, 500.0).unwrap();
        assert_eq!(snap.bucket_ts, 0);
        assert_eq!(snap.net_usd, 3_000.0);
        assert_eq!(snap.gross_usd, 3_000.0);
        // Z-score is None with only 1 closed bucket
        assert!(snap.z_score.is_none());
    }

    #[test]
    fn z_score_triggers_after_warmup() {
        let mut a = AssetAggregator::new("BTCUSDT");
        let mut ts = 0;
        // 10 quiet hours (≈ $1k net)
        for _ in 0..10 {
            a.on_liquidation(ts, LiqSide::Buy, 1_000.0);
            ts += HOUR;
        }
        // Spike in hour 10
        a.on_liquidation(ts, LiqSide::Buy, 50_000.0);
        ts += HOUR;
        let snap = a.on_liquidation(ts, LiqSide::Buy, 500.0).unwrap();
        // Closed the spike bucket
        assert_eq!(snap.net_usd, 50_000.0);
        assert!(snap.z_score.is_some());
        assert!(snap.z_score.unwrap() > 2.0);
    }
}
