//! Crypto derivatives types.

use crate::time::EventTs;
use serde::{Deserialize, Serialize};

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Asset {
    Btc,
    Eth,
}

impl Asset {
    pub fn symbol(self) -> &'static str {
        match self {
            Self::Btc => "BTCUSDT",
            Self::Eth => "ETHUSDT",
        }
    }

    pub fn coin(self) -> &'static str {
        match self {
            Self::Btc => "BTC",
            Self::Eth => "ETH",
        }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum LiqSide {
    Buy,
    Sell,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Candle {
    pub ts: EventTs,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FundingRate {
    pub ts: EventTs,
    pub rate_close: f64,
    pub rate_open: f64,
    pub predicted_close: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OpenInterest {
    pub ts: EventTs,
    pub close: f64,
    pub high: f64,
    pub low: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Liquidation {
    pub ts: EventTs,
    pub side: LiqSide,
    pub volume_usd: f64,
}
