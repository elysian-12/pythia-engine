//! Polymarket position-level types.

use crate::{
    ids::{AssetId, ConditionId, Wallet},
    market::Category,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UserPosition {
    pub wallet: Wallet,
    pub asset_id: AssetId,
    pub condition_id: ConditionId,
    pub unrealized_size: f64,
    pub realized_size: f64,
    pub avg_price: f64,
    pub avg_exit_price: f64,
    pub realized_pnl: f64,
    pub resolved_price: Option<f64>,
    pub latest_open_ts: i64,
    pub prev_hold_duration: i64,
    pub buy_count: i32,
    pub sell_count: i32,
    pub market_name: String,
    pub outcome_name: String,
    pub category: Category,
    pub sub_category: String,
}

impl UserPosition {
    /// Net size across realized + unrealized, in USD-denominated contract units.
    pub fn net_size(&self) -> f64 {
        self.unrealized_size + self.realized_size
    }

    /// Position is still open (has unrealized exposure).
    pub fn is_open(&self) -> bool {
        self.unrealized_size.abs() > f64::EPSILON
    }
}
