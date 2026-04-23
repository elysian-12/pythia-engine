//! `scrape` — bulk-fetch historical crypto derivatives from Kiyotaka into
//! the local DuckDB store.
//!
//! Usage: `cargo run --release -p ingest --bin scrape -- <days>`
//! Default 30 days. Adanced tier supports up to 365 days of history.
//!
//! The scraper chunks requests into 30-day segments to stay within the
//! per-request point cap, and respects the workspace weight budget.

use std::{env, time::Instant};

use chrono::Utc;
use domain::crypto::Asset;
use evaluation::LatencyCollector;
use ingest::{BudgetCfg, DataSource, LiveSource, WeightBudget};
use kiyotaka_client::{Exchange, Interval, KiyotakaClient};
use store::Store;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    dotenvy::from_filename(".env").ok();

    let args: Vec<String> = env::args().collect();
    let days: i64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(30);

    let key = env::var("KIYOTAKA_API_KEY")?;
    let db_path = env::var("PYTHIA_DB").unwrap_or_else(|_| "data/pythia.duckdb".into());
    if let Some(parent) = std::path::Path::new(&db_path).parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let store = Store::open(&db_path)?;
    let client = KiyotakaClient::new(key)?;
    let source = LiveSource::new(client);
    let budget = WeightBudget::new(BudgetCfg {
        per_minute: 750,
        burst: 1_500,
    });
    let latency = LatencyCollector::new();

    let end_ts = Utc::now().timestamp();
    let start_ts = end_ts - days * 86_400;
    tracing::info!(days, start_ts, end_ts, "starting bulk scrape");

    let wall = Instant::now();
    let chunk_secs: i64 = 30 * 86_400;

    for asset in [Asset::Btc, Asset::Eth] {
        let mut cursor = start_ts;
        while cursor < end_ts {
            let from = cursor;
            let period = (end_ts - from).min(chunk_secs);

            let label = format!("{}-{}", asset.coin(), from);
            let _span = latency.span(format!("scrape:{label}"));
            budget.reserve(4).await;

            let candles = source
                .candles(Exchange::BinanceFutures, asset.symbol(), Interval::Hour, from, period)
                .await?;
            let funding = source
                .funding_rate(Exchange::BinanceFutures, asset.symbol(), Interval::Hour, from, period)
                .await?;
            let oi = source
                .open_interest(Exchange::BinanceFutures, asset.symbol(), Interval::Hour, from, period)
                .await?;
            let liq = source
                .liquidations(Exchange::BinanceFutures, asset.symbol(), Interval::Hour, from, period)
                .await?;

            let c = store.upsert_candles(asset, &candles)?;
            let f = store.upsert_funding(asset, &funding)?;
            let o = store.upsert_oi(asset, &oi)?;
            let l = store.upsert_liquidations(asset, &liq)?;

            tracing::info!(
                asset=?asset, from=from, period_d=period/86_400, candles=c, funding=f, oi=o, liq=l,
                "scrape chunk stored"
            );
            cursor += chunk_secs;
        }
    }

    let elapsed = wall.elapsed();
    let report = latency.report(elapsed.as_nanos() as u64);
    tracing::info!(
        total_ms = elapsed.as_millis() as u64,
        phases = report.phases.len(),
        "scrape complete"
    );
    println!("{}", report.render_markdown());
    Ok(())
}
