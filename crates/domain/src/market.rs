//! Polymarket market-level types.

use crate::{ids::ConditionId, time::EventTs, AssetId};
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum Category {
    Politics,
    Crypto,
    Sports,
    Pop,
    Business,
    Science,
    #[serde(untagged)]
    Other(String),
}

impl fmt::Display for Category {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Politics => f.write_str("Politics"),
            Self::Crypto => f.write_str("Crypto"),
            Self::Sports => f.write_str("Sports"),
            Self::Pop => f.write_str("Pop"),
            Self::Business => f.write_str("Business"),
            Self::Science => f.write_str("Science"),
            Self::Other(s) => f.write_str(s),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OutcomePricing {
    pub condition_id: ConditionId,
    pub token_id: AssetId,
    pub outcome_name: String,
    pub weighted_avg_entry_price: f64,
    pub weighted_avg_exit_price: f64,
    /// 101 buckets: index i is the count of accounts with avg entry price in [i, i+1) cents.
    pub open_pos_avg_price_distribution: Vec<f64>,
    pub closed_pos_avg_exit_price_distribution: Vec<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MarketSummary {
    pub event_id: String,
    pub condition_ids: Vec<ConditionId>,
    pub total_open_positions: i64,
    pub total_closed_positions: i64,
    pub total_cost_basis: f64,
    pub total_size: f64,
    pub largest_open_position: f64,
    pub total_buy_count: i64,
    pub total_sell_count: i64,
    pub net_transfer_flow: i64,
    pub median_hold_duration: f64,
    pub mean_hold_duration: f64,
    pub realized_pnl_min: f64,
    pub realized_pnl_max: f64,
    pub realized_pnl_distribution: Vec<f64>,
    pub win_rate: f64,
    pub avg_size: f64,
    pub outcome_pricing: Vec<OutcomePricing>,
    pub asof: EventTs,
}

/// Compute a smart-money mid price from the outcome pricing distribution.
///
/// Uses the 101-bucket entry-price histogram to derive a volume-weighted mid,
/// independent of the noisy last-traded price.
#[must_use]
pub fn distribution_mid(buckets: &[f64]) -> Option<f64> {
    let total: f64 = buckets.iter().sum();
    if total <= 0.0 {
        return None;
    }
    let weighted: f64 = buckets
        .iter()
        .enumerate()
        .map(|(i, w)| ((i as f64) + 0.5) * w / 100.0)
        .sum();
    Some(weighted / total)
}
