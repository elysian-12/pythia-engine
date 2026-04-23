//! Ingest orchestrator.
//!
//! Pulls data from the Kiyotaka REST API on a tiered cadence (hot/warm/cold)
//! and persists it into the `Store`. Self-governed rate budget — the service
//! does not assume the response headers are populated.
//!
//! Public entry point: [`Ingestor::run`] which drives a set of tasks under
//! `tokio::select!` until the supplied shutdown signal fires.

#![deny(unused_must_use)]

pub mod budget;
pub mod config;
pub mod discovery;
pub mod pm;
pub mod signals;
pub mod source;

use std::{sync::Arc, time::Duration};

use domain::crypto::Asset;
use evaluation::LatencyCollector;
use kiyotaka_client::{Exchange, Interval, KiyotakaClient};
use store::Store;
use tokio::sync::Notify;

pub use budget::{BudgetCfg, WeightBudget};
pub use config::IngestConfig;
pub use signals::{evaluate_once, LiveSignalCfg, LiveStats};
pub use source::{DataSource, LiveSource};

/// Top-level ingestor.
#[allow(missing_debug_implementations)] // `S` is not required to be Debug.
pub struct Ingestor<S: DataSource> {
    pub source: Arc<S>,
    pub store: Store,
    pub budget: Arc<WeightBudget>,
    pub config: IngestConfig,
    pub shutdown: Arc<Notify>,
    pub latency: Arc<LatencyCollector>,
    pub signal_cfg: Arc<LiveSignalCfg>,
}

impl<S: DataSource> Clone for Ingestor<S> {
    fn clone(&self) -> Self {
        Self {
            source: Arc::clone(&self.source),
            store: self.store.clone(),
            budget: Arc::clone(&self.budget),
            config: self.config.clone(),
            shutdown: Arc::clone(&self.shutdown),
            latency: Arc::clone(&self.latency),
            signal_cfg: Arc::clone(&self.signal_cfg),
        }
    }
}

impl Ingestor<LiveSource> {
    pub fn live(client: KiyotakaClient, store: Store, config: IngestConfig) -> Self {
        let budget = Arc::new(WeightBudget::new(BudgetCfg {
            per_minute: config.weight_per_minute,
            burst: config.weight_burst,
        }));
        Self {
            source: Arc::new(LiveSource::new(client)),
            store,
            budget,
            config,
            shutdown: Arc::new(Notify::new()),
            latency: Arc::new(LatencyCollector::new()),
            signal_cfg: Arc::new(LiveSignalCfg::default()),
        }
    }
}

impl<S: DataSource + Send + Sync + 'static> Ingestor<S> {
    pub async fn run(self) -> Result<(), IngestError> {
        let crypto = self.clone().spawn_crypto_loop();
        let pm = self.clone().spawn_pm_loop();
        tokio::select! {
            r = crypto => r??,
            r = pm => r??,
            () = self.shutdown.notified() => {
                tracing::info!("ingest shutdown requested");
            }
        }
        Ok(())
    }

    /// Run **one** cycle of every tier — used by tests and by the backtest
    /// runner which wants deterministic ingest rather than continuous loops.
    pub async fn run_once(&self) -> Result<IngestStats, IngestError> {
        let mut stats = IngestStats::default();
        stats += pm::refresh_leaderboard(self).await?;
        stats += pm::refresh_hot_markets(self).await?;
        stats += refresh_crypto(self, &Asset::Btc).await?;
        stats += refresh_crypto(self, &Asset::Eth).await?;
        Ok(stats)
    }

    fn spawn_crypto_loop(self) -> tokio::task::JoinHandle<Result<(), IngestError>> {
        tokio::spawn(async move {
            let period = Duration::from_secs(self.config.crypto_interval_s.max(30));
            let mut tick = tokio::time::interval(period);
            tick.tick().await;
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        for asset in [Asset::Btc, Asset::Eth] {
                            if let Err(e) = refresh_crypto(&self, &asset).await {
                                tracing::warn!(?asset, error=%e, "crypto refresh failed");
                            }
                        }
                    }
                    () = self.shutdown.notified() => break,
                }
            }
            Ok(())
        })
    }

    fn spawn_pm_loop(self) -> tokio::task::JoinHandle<Result<(), IngestError>> {
        tokio::spawn(async move {
            let period = Duration::from_secs(self.config.pm_hot_interval_s.max(60));
            let mut tick = tokio::time::interval(period);
            tick.tick().await;
            let mut since_lb = 0u64;
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        if since_lb == 0 {
                            let _ = pm::refresh_leaderboard(&self).await;
                        }
                        since_lb = (since_lb + 1) % self.config.leaderboard_refresh_every;
                        let _ = pm::refresh_hot_markets(&self).await;
                        // After refreshing, attempt to fire signals.
                        match signals::evaluate_once(&self, &self.signal_cfg, &self.latency).await {
                            Ok(s) if s.fired > 0 => {
                                tracing::info!(fired=s.fired, opened=s.trades_opened, skipped=s.skipped, "signals pass");
                            }
                            Ok(s) => {
                                tracing::debug!(fired=s.fired, opened=s.trades_opened, skipped=s.skipped, rejections=?s.rejections, "signals pass");
                            }
                            Err(e) => tracing::warn!(error=%e, "signal pass failed"),
                        }
                    }
                    () = self.shutdown.notified() => break,
                }
            }
            Ok(())
        })
    }

    pub fn stop(&self) {
        self.shutdown.notify_waiters();
    }
}

async fn refresh_crypto<S: DataSource + Send + Sync>(
    ing: &Ingestor<S>,
    asset: &Asset,
) -> Result<IngestStats, IngestError> {
    let now = chrono::Utc::now().timestamp();
    let from = now - ing.config.crypto_lookback_s;
    let period = ing.config.crypto_lookback_s;

    ing.budget.reserve(1).await;
    let candles = {
        let _s = ing.latency.span("ingest:candles");
        ing.source
            .candles(Exchange::BinanceFutures, asset.symbol(), Interval::Hour, from, period)
            .await?
    };
    ing.budget.reserve(1).await;
    let funding = {
        let _s = ing.latency.span("ingest:funding");
        ing.source
            .funding_rate(Exchange::BinanceFutures, asset.symbol(), Interval::Hour, from, period)
            .await?
    };
    ing.budget.reserve(1).await;
    let oi = {
        let _s = ing.latency.span("ingest:oi");
        ing.source
            .open_interest(Exchange::BinanceFutures, asset.symbol(), Interval::Hour, from, period)
            .await?
    };
    ing.budget.reserve(1).await;
    let liq = {
        let _s = ing.latency.span("ingest:liquidations");
        ing.source
            .liquidations(Exchange::BinanceFutures, asset.symbol(), Interval::Hour, from, period)
            .await?
    };

    let mut stats = IngestStats::default();
    let _s = ing.latency.span("store:upsert_crypto");
    stats.candles += ing.store.upsert_candles(*asset, &candles)?;
    stats.funding += ing.store.upsert_funding(*asset, &funding)?;
    stats.oi += ing.store.upsert_oi(*asset, &oi)?;
    stats.liquidations += ing.store.upsert_liquidations(*asset, &liq)?;
    Ok(stats)
}

#[derive(Default, Debug, Clone, Copy)]
pub struct IngestStats {
    pub candles: usize,
    pub funding: usize,
    pub oi: usize,
    pub liquidations: usize,
    pub profiles: usize,
    pub positions: usize,
    pub summaries: usize,
}

impl std::ops::AddAssign for IngestStats {
    fn add_assign(&mut self, o: Self) {
        self.candles += o.candles;
        self.funding += o.funding;
        self.oi += o.oi;
        self.liquidations += o.liquidations;
        self.profiles += o.profiles;
        self.positions += o.positions;
        self.summaries += o.summaries;
    }
}

#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    #[error("client: {0}")]
    Client(#[from] kiyotaka_client::Error),
    #[error("store: {0}")]
    Store(#[from] store::StoreError),
    #[error("task join: {0}")]
    Join(#[from] tokio::task::JoinError),
}
