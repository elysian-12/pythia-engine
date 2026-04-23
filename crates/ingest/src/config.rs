//! Ingest configuration. All values tuned to fit inside Advanced-tier budget.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IngestConfig {
    /// Advanced tier: 750 weight/min.
    pub weight_per_minute: u32,
    /// Burst (docs say 2x sustained).
    pub weight_burst: u32,
    /// How often to refresh crypto derivatives (every asset).
    pub crypto_interval_s: u64,
    /// Lookback for each crypto refresh.
    pub crypto_lookback_s: i64,
    /// How often to refresh PM "hot" markets.
    pub pm_hot_interval_s: u64,
    /// How many PM hot markets to track.
    pub pm_hot_count: usize,
    /// Leaderboard refresh happens every Nth pm tick.
    pub leaderboard_refresh_every: u64,
    /// Minimum win rate filter on leaderboard.
    pub min_wallet_win_rate: f64,
    /// Minimum total volume (USD) for a wallet to be tracked.
    pub min_wallet_volume: f64,
    /// Minimum total closed trades for wallet to be tracked.
    pub min_wallet_trades: f64,
}

impl Default for IngestConfig {
    fn default() -> Self {
        Self {
            weight_per_minute: 750,
            weight_burst: 1_500,
            crypto_interval_s: 60,
            crypto_lookback_s: 86_400,
            pm_hot_interval_s: 60,
            pm_hot_count: 5,
            leaderboard_refresh_every: 15, // refresh LB every ~15 min at 60s ticks
            min_wallet_win_rate: 60.0,
            min_wallet_volume: 250_000.0,
            min_wallet_trades: 50.0,
        }
    }
}
