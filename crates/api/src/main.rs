//! Pythia service binary.
//!
//! Runs:
//! 1. A Kiyotaka-backed ingest loop in the background.
//! 2. An axum HTTP server serving read-only JSON for the web app.
//!
//! Configuration via environment:
//! - `KIYOTAKA_API_KEY` (required)
//! - `POLYEDGE_BIND` (default 0.0.0.0:8080)
//! - `POLYEDGE_DB` (default data/polyedge.duckdb)

use std::{net::SocketAddr, path::PathBuf, str::FromStr, sync::Arc};

use evaluation::LatencyCollector;
use ingest::{IngestConfig, Ingestor};
use kiyotaka_client::KiyotakaClient;
use store::Store;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();
    dotenvy::from_filename(".env").ok();

    let key = std::env::var("KIYOTAKA_API_KEY")
        .map_err(|_| "KIYOTAKA_API_KEY is required")?;
    let bind = std::env::var("PYTHIA_BIND")
        .or_else(|_| std::env::var("POLYEDGE_BIND"))
        .unwrap_or_else(|_| "0.0.0.0:8080".into());
    let db_path = PathBuf::from(
        std::env::var("PYTHIA_DB")
            .or_else(|_| std::env::var("POLYEDGE_DB"))
            .unwrap_or_else(|_| "data/pythia.duckdb".into()),
    );
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let store = Store::open(&db_path)?;
    let client = KiyotakaClient::new(key)?;
    let latency = Arc::new(LatencyCollector::new());

    // Background ingestor — shares the LatencyCollector with the API so
    // /api/runtime reflects live engine timings.
    let ingest = Ingestor::live(client.clone(), store.clone(), IngestConfig::default());
    let mut ingest = ingest;
    ingest.latency = Arc::clone(&latency);
    let ingest_handle = tokio::spawn(async move {
        if let Err(e) = ingest.run().await {
            tracing::error!(error=%e, "ingest terminated");
        }
    });

    let state = api::AppState {
        store,
        client: Arc::new(client),
        latency,
    };
    let addr = SocketAddr::from_str(&bind)?;
    let srv = api::serve(state, addr);

    tokio::select! {
        r = srv => { r?; }
        _ = ingest_handle => {}
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("shutdown signal");
        }
    }
    Ok(())
}
