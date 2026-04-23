//! Hyperliquid API request / response types.
//!
//! The Hyperliquid exchange HTTP endpoint accepts a single JSON shape:
//! `{ action: {...}, nonce: <ms>, signature: {r, s, v}, vaultAddress? }`.
//! We model the action variants as an enum serialised via
//! `#[serde(tag = "type")]` to match the on-wire representation.

use serde::{Deserialize, Serialize};

#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderSide {
    Buy,
    Sell,
}

impl OrderSide {
    pub fn as_b(self) -> bool {
        matches!(self, Self::Buy)
    }
}

/// Time-in-force per Hyperliquid's API: `Gtc`, `Ioc`, `Alo`.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Tif {
    Gtc,
    Ioc,
    Alo,
}

#[derive(Clone, Debug, Serialize)]
pub struct OrderRequest {
    /// Hyperliquid asset index (BTC = 0 on mainnet, ETH = 1, etc.).
    pub asset: u32,
    pub side: OrderSide,
    pub size: f64,
    /// Limit price. For a market-like fill, pass `mid × (1 ± 5 bps)` with
    /// `Tif::Ioc`.
    pub limit_px: f64,
    pub reduce_only: bool,
    pub tif: Tif,
    /// Trigger orders (stop / take-profit) share the same shape with
    /// `trigger` populated; for normal orders it's `None`.
    pub trigger: Option<TriggerSpec>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TriggerSpec {
    pub px: f64,
    pub is_market: bool,
    /// `"tp"` | `"sl"`.
    pub kind: &'static str,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OrderResponse {
    pub status: String,
    #[serde(default)]
    pub response: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UserState {
    #[serde(rename = "marginSummary", default)]
    pub margin_summary: MarginSummary,
    #[serde(rename = "assetPositions", default)]
    pub asset_positions: Vec<AssetPosition>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct MarginSummary {
    #[serde(rename = "accountValue", default)]
    pub account_value: String,
    #[serde(rename = "totalNtlPos", default)]
    pub total_ntl_pos: String,
    #[serde(rename = "totalRawUsd", default)]
    pub total_raw_usd: String,
    #[serde(rename = "totalMarginUsed", default)]
    pub total_margin_used: String,
}

impl MarginSummary {
    pub fn account_value_f64(&self) -> f64 {
        self.account_value.parse().unwrap_or(0.0)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssetPosition {
    #[serde(default)]
    pub position: Option<Position>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub coin: String,
    #[serde(default)]
    pub szi: String, // signed size as string
    #[serde(default)]
    pub entry_px: Option<String>,
    #[serde(default)]
    pub unrealized_pnl: Option<String>,
    #[serde(default)]
    pub leverage: serde_json::Value,
}

impl Position {
    pub fn size_f64(&self) -> f64 {
        self.szi.parse().unwrap_or(0.0)
    }
}
