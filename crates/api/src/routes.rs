//! HTTP route handlers. All routes are read-only; the only state mutation
//! is via the background `Ingestor`.

use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use domain::crypto::Asset;
use serde::Serialize;

use crate::state::AppState;

pub async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

#[derive(Debug, Serialize)]
pub struct Overview {
    pub candles_btc: i64,
    pub candles_eth: i64,
    pub funding: i64,
    pub oi: i64,
    pub liquidations: i64,
    pub trader_profiles: i64,
    pub user_positions: i64,
    pub market_summaries: i64,
    pub signals: i64,
    pub trades: i64,
}

pub async fn overview(State(s): State<AppState>) -> impl IntoResponse {
    let o = Overview {
        candles_btc: count_candles(&s.store, Asset::Btc),
        candles_eth: count_candles(&s.store, Asset::Eth),
        funding: s.store.count_table("funding").unwrap_or(0),
        oi: s.store.count_table("open_interest").unwrap_or(0),
        liquidations: s.store.count_table("liquidations").unwrap_or(0),
        trader_profiles: s.store.count_table("trader_profiles").unwrap_or(0),
        user_positions: s.store.count_table("user_positions").unwrap_or(0),
        market_summaries: s.store.count_table("market_summaries").unwrap_or(0),
        signals: s.store.count_table("signals").unwrap_or(0),
        trades: s.store.count_table("trades").unwrap_or(0),
    };
    Json(o)
}

fn count_candles(store: &store::Store, asset: Asset) -> i64 {
    store
        .recent_candles(asset, 100_000)
        .map(|v| v.len() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Serialize)]
pub struct MarketRow {
    pub condition_id: String,
}

pub async fn markets(State(s): State<AppState>) -> impl IntoResponse {
    let rows: Vec<MarketRow> = s
        .store
        .active_conditions()
        .unwrap_or_default()
        .into_iter()
        .map(|c| MarketRow {
            condition_id: c.to_string(),
        })
        .collect();
    Json(rows)
}

pub async fn signals(State(s): State<AppState>) -> impl IntoResponse {
    match s.store.all_signals() {
        Ok(rows) => Json(serde_json::json!({ "signals": rows })).into_response(),
        Err(e) => {
            tracing::warn!(error=%e, "signals query failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "query failed").into_response()
        }
    }
}

pub async fn trades(State(s): State<AppState>) -> impl IntoResponse {
    match s.store.all_trades() {
        Ok(rows) => Json(serde_json::json!({ "trades": rows })).into_response(),
        Err(e) => {
            tracing::warn!(error=%e, "trades query failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "query failed").into_response()
        }
    }
}

pub async fn equity(State(s): State<AppState>) -> impl IntoResponse {
    // Equity is the running sum of closed-trade PnL, indexed by exit_ts.
    let trades = match s.store.all_trades() {
        Ok(t) => t,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "query failed").into_response(),
    };
    let mut curve: Vec<(i64, f64)> = Vec::new();
    let mut equity = 0.0_f64;
    for t in trades {
        if let (Some(exit), Some(p)) = (t.exit_ts, t.pnl_usd) {
            equity += p;
            curve.push((exit, equity));
        }
    }
    Json(serde_json::json!({ "points": curve })).into_response()
}

pub async fn rate(State(s): State<AppState>) -> impl IntoResponse {
    let r = s.client.rate_snapshot();
    Json(serde_json::json!({
        "limit": r.limit,
        "remaining": r.remaining,
        "used": r.used,
        "reset_at": r.reset_at,
    }))
}

pub async fn runtime(State(s): State<AppState>) -> impl IntoResponse {
    let report = s.latency.report(0);
    Json(report)
}

pub async fn backtest_latest() -> impl IntoResponse {
    let dir = std::path::Path::new("reports/backtest");
    let mut latest = None;
    if let Ok(read) = std::fs::read_dir(dir) {
        for e in read.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) == Some("json") {
                latest = Some(p);
            }
        }
    }
    match latest {
        Some(p) => match std::fs::read_to_string(&p) {
            Ok(s) => (StatusCode::OK, [("content-type", "application/json")], s).into_response(),
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        },
        None => (StatusCode::NOT_FOUND, "no backtest report yet").into_response(),
    }
}
