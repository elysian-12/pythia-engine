//! Boundary DTOs — deliberately mirror the API shape so schema drift breaks
//! here, not deep in the pipeline. Converters live in `parsing`.

use serde::Deserialize;

#[derive(Debug, Default, Deserialize)]
pub struct Timestamp {
    #[serde(rename = "s", default)]
    pub seconds: i64,
}

#[derive(Debug, Deserialize)]
pub struct SeriesEnvelope<P> {
    #[serde(default)]
    pub series: Vec<Series<P>>,
}

#[derive(Debug, Deserialize)]
pub struct Series<P> {
    pub id: SeriesId,
    #[serde(default)]
    pub points: Vec<PointWrapper<P>>,
}

#[derive(Debug, Deserialize)]
pub struct SeriesId {
    #[serde(default)]
    pub side: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PointWrapper<P> {
    pub point: P,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandlePoint {
    #[serde(default)]
    pub open: Option<f64>,
    #[serde(default)]
    pub high: Option<f64>,
    #[serde(default)]
    pub low: Option<f64>,
    #[serde(default)]
    pub close: Option<f64>,
    #[serde(default)]
    pub volume: Option<f64>,
    pub timestamp: Timestamp,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FundingPoint {
    #[serde(default)]
    pub rate_open: Option<f64>,
    #[serde(default)]
    pub rate_close: Option<f64>,
    #[serde(default)]
    pub predicted_close: Option<f64>,
    pub timestamp: Timestamp,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInterestPoint {
    #[serde(default)]
    pub high: Option<f64>,
    #[serde(default)]
    pub low: Option<f64>,
    #[serde(default)]
    pub close: Option<f64>,
    pub timestamp: Timestamp,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiquidationPoint {
    #[serde(default)]
    pub liquidations: Option<f64>,
    pub timestamp: Timestamp,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardEnvelope {
    #[serde(default)]
    pub trader_profiles: Vec<RawTraderProfile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraderProfileEnvelope {
    pub trader_profile: Option<RawTraderProfile>,
}

#[derive(Debug, Deserialize, Default)]
pub struct RawTraderProfile {
    #[serde(default)]
    pub wallet_address: String,
    #[serde(default)]
    pub total_position_count: i64,
    #[serde(default)]
    pub open_position_count: i64,
    #[serde(default)]
    pub closed_position_count: i64,
    #[serde(default)]
    pub total_size: f64,
    #[serde(default)]
    pub total_realized_pnl: f64,
    #[serde(default)]
    pub total_unrealized_pnl: f64,
    #[serde(default)]
    pub total_roi: f64,
    #[serde(default)]
    pub win_rate_by_positions: f64,
    #[serde(default)]
    pub largest_win: f64,
    #[serde(default)]
    pub largest_loss: f64,
    #[serde(default)]
    pub avg_holding_duration: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionsEnvelope {
    #[serde(default)]
    pub user_positions: Vec<RawPosition>,
}

#[derive(Debug, Deserialize, Default)]
pub struct RawPosition {
    #[serde(default)]
    pub wallet_address: String,
    #[serde(default)]
    pub asset_id: String,
    #[serde(default)]
    pub condition_id: String,
    #[serde(default)]
    pub unrealized_size: f64,
    #[serde(default)]
    pub realized_size: f64,
    #[serde(default)]
    pub avg_price: f64,
    #[serde(default)]
    pub avg_exit_price: f64,
    #[serde(default)]
    pub realized_pnl: f64,
    #[serde(default)]
    pub resolved_price: Option<f64>,
    #[serde(default)]
    pub latest_open_ts: i64,
    #[serde(default)]
    pub prev_hold_duration: i64,
    #[serde(default)]
    pub buy_count: i32,
    #[serde(default)]
    pub sell_count: i32,
    #[serde(default)]
    pub market_name: String,
    #[serde(default)]
    pub outcome_name: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub sub_category: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSummaryEnvelope {
    pub market_summary: Option<RawMarketSummary>,
}

#[derive(Debug, Deserialize, Default)]
pub struct RawMarketSummary {
    #[serde(default)]
    pub event_id: String,
    #[serde(default)]
    pub condition_id: Vec<String>,
    #[serde(default)]
    pub total_open_positions: i64,
    #[serde(default)]
    pub total_closed_positions: i64,
    #[serde(default)]
    pub total_cost_basis: f64,
    #[serde(default)]
    pub total_size: f64,
    #[serde(default)]
    pub largest_open_position: f64,
    #[serde(default)]
    pub total_buy_count: i64,
    #[serde(default)]
    pub total_sell_count: i64,
    #[serde(default)]
    pub net_transfer_flow: i64,
    #[serde(default)]
    pub median_hold_duration: f64,
    #[serde(default)]
    pub mean_hold_duration: f64,
    #[serde(default)]
    pub realized_pnl_min: f64,
    #[serde(default)]
    pub realized_pnl_max: f64,
    #[serde(default)]
    pub realized_pnl_distribution: Vec<f64>,
    #[serde(default)]
    pub win_rate: f64,
    #[serde(default)]
    pub avg_size: f64,
    #[serde(default)]
    pub outcome_pricing: Vec<RawOutcomePricing>,
}

#[derive(Debug, Deserialize, Default)]
pub struct RawOutcomePricing {
    #[serde(default)]
    pub condition_id: String,
    #[serde(default)]
    pub token_id: String,
    #[serde(default)]
    pub outcome_name: String,
    #[serde(default)]
    pub weighted_avg_entry_price: f64,
    #[serde(default)]
    pub weighted_avg_exit_price: f64,
    #[serde(default)]
    pub open_pos_avg_price_distribution: Vec<f64>,
    #[serde(default)]
    pub closed_pos_avg_exit_price_distribution: Vec<f64>,
}
