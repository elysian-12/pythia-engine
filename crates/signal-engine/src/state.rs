//! `MarketState` — the input struct for the pure-functional signal evaluator.

use domain::{crypto::Asset, ids::ConditionId, time::EventTs};

/// Snapshot of everything the evaluator needs for one market at one asof.
#[derive(Clone, Debug)]
pub struct MarketState {
    pub condition_id: ConditionId,
    pub market_name: String,
    pub asof: EventTs,
    /// Skill-weighted probability (§2.1 in PLAN.md).
    pub swp: Option<f64>,
    /// Distribution-derived mid.
    pub mid: Option<f64>,
    /// PM price series (SWP or log-odds) aligned in time with `crypto_series`.
    pub pm_series: Vec<f64>,
    /// Crypto series (e.g. log-price) — same length as `pm_series`.
    pub crypto_series: Vec<f64>,
    /// Recent crypto response metric (combined funding/OI/liq z-series).
    pub crypto_response: Vec<f64>,
    /// Gini of skill-weighted positions on this market.
    pub gini: f64,
    /// (asset, direction_sign). +1 = "YES ↑ ⇒ asset ↑", -1 = inverse.
    pub asset_mapping: Option<(Asset, i8)>,
    /// Signal horizon in seconds (category-specific override).
    pub horizon_s: Option<i64>,
}
