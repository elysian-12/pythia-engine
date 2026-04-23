//! Signal + paper-trade types.

use crate::{crypto::Asset, ids::ConditionId, time::EventTs};
use serde::{Deserialize, Serialize};

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Direction {
    Long,
    Short,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Signal {
    pub id: String,
    pub ts: EventTs,
    pub condition_id: ConditionId,
    pub market_name: String,
    pub asset: Asset,
    pub direction: Direction,
    /// Smart-money-weighted probability at fire time.
    pub swp: f64,
    /// Raw distribution mid at fire time.
    pub mid: f64,
    /// Edge in probability points.
    pub edge: f64,
    /// Hasbrouck information share of PM side in [0,1].
    pub is_pm: f64,
    /// Granger F-stat PM → crypto.
    pub granger_f: f64,
    /// Gini concentration of skill-weighted positions.
    pub gini: f64,
    /// Conviction 0-100 (composite).
    pub conviction: u8,
    /// Expected horizon seconds.
    pub horizon_s: i64,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CloseReason {
    TakeProfit,
    StopLoss,
    TimeStop,
    RegimeBreak,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Trade {
    pub signal_id: String,
    pub asset: Asset,
    pub direction: Direction,
    pub entry_ts: EventTs,
    pub entry_price: f64,
    pub exit_ts: Option<EventTs>,
    pub exit_price: Option<f64>,
    /// Total fees paid in quote currency.
    pub fees: f64,
    /// Funding paid (+) or received (-) in quote currency.
    pub funding_paid: f64,
    pub slippage: f64,
    pub close_reason: Option<CloseReason>,
    pub r_multiple: Option<f64>,
    pub pnl_usd: Option<f64>,
}

impl Trade {
    pub fn is_open(&self) -> bool {
        self.exit_ts.is_none()
    }
}
