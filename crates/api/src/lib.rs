//! Pythia HTTP API.
//!
//! Serves JSON read-models for the web front-end. No write routes — the API
//! is a read-only window onto `Store`. Background ingest is separate.

#![deny(unused_must_use)]

pub mod routes;
pub mod state;

pub use state::AppState;

use axum::{routing::get, Router};
use std::net::SocketAddr;
use tower_http::cors::CorsLayer;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(routes::health))
        .route("/api/overview", get(routes::overview))
        .route("/api/markets", get(routes::markets))
        .route("/api/signals", get(routes::signals))
        .route("/api/trades", get(routes::trades))
        .route("/api/equity", get(routes::equity))
        .route("/api/rate", get(routes::rate))
        .route("/api/runtime", get(routes::runtime))
        .route("/reports/backtest/latest", get(routes::backtest_latest))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

pub async fn serve(state: AppState, addr: SocketAddr) -> std::io::Result<()> {
    let app = router(state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "pythia api listening");
    axum::serve(listener, app).await
}
