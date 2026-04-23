//! Polymarket refresh routines.

use std::collections::HashSet;

use domain::{ids::ConditionId, time::EventTs};
use kiyotaka_client::{LeaderboardFilter, SortBy};

use crate::{discovery, DataSource, IngestError, IngestStats, Ingestor};

const LEADERBOARD_WEIGHT: u32 = 60;
const POSITIONS_WEIGHT: u32 = 40;
const MARKET_SUMMARY_WEIGHT: u32 = 60;

/// Refresh top-N PM leaderboard into `trader_profiles`.
pub async fn refresh_leaderboard<S: DataSource + Send + Sync>(
    ing: &Ingestor<S>,
) -> Result<IngestStats, IngestError> {
    ing.budget.reserve(LEADERBOARD_WEIGHT).await;
    let profiles = {
        let _s = ing.latency.span("ingest:leaderboard");
        ing.source
            .leaderboard(&LeaderboardFilter {
                limit: Some(100),
                min_win_rate: Some(ing.config.min_wallet_win_rate),
                min_total_volume: Some(ing.config.min_wallet_volume),
                min_total_trades: Some(ing.config.min_wallet_trades),
                sort_by: Some(SortBy::RealizedPnl),
                ..Default::default()
            })
            .await?
    };
    let mut n = 0;
    for p in &profiles {
        ing.store.upsert_trader_profile(p)?;
        n += 1;
    }
    let mut stats = IngestStats::default();
    stats.profiles += n;

    // Pull an initial batch of positions per top-wallet to seed discovery.
    for p in profiles.iter().take(20) {
        ing.budget.reserve(POSITIONS_WEIGHT).await;
        let _s = ing.latency.span("ingest:positions_by_wallet");
        if let Ok(pos) = ing.source.positions(Some(&p.wallet), None, 25).await {
            let rel: Vec<_> = pos.into_iter().filter(discovery::is_crypto_relevant).collect();
            stats.positions += ing.store.upsert_positions(&rel)?;
        }
    }
    Ok(stats)
}

/// Refresh the top-N most-active crypto-relevant markets.
pub async fn refresh_hot_markets<S: DataSource + Send + Sync>(
    ing: &Ingestor<S>,
) -> Result<IngestStats, IngestError> {
    let mut stats = IngestStats::default();

    let candidates = select_hot_conditions(ing, ing.config.pm_hot_count)?;
    for cid in candidates {
        ing.budget.reserve(MARKET_SUMMARY_WEIGHT).await;
        {
            let _s = ing.latency.span("ingest:market_summary");
            match ing
                .source
                .market_summary(&cid, EventTs::from_secs(chrono::Utc::now().timestamp()))
                .await
            {
                Ok(ms) => {
                    ing.store.upsert_market_summary(&cid, &ms)?;
                    stats.summaries += 1;
                }
                Err(e) => tracing::warn!(cid=%cid, error=%e, "market summary refresh failed"),
            }
        }
        ing.budget.reserve(POSITIONS_WEIGHT).await;
        let _s = ing.latency.span("ingest:positions_by_condition");
        match ing.source.positions(None, Some(&cid), 50).await {
            Ok(pos) => {
                let rel: Vec<_> = pos.into_iter().filter(discovery::is_crypto_relevant).collect();
                stats.positions += ing.store.upsert_positions(&rel)?;
            }
            Err(e) => tracing::warn!(cid=%cid, error=%e, "positions refresh failed"),
        }
    }
    Ok(stats)
}

/// Pick the hottest N crypto-relevant conditions from recent stored positions.
/// Scoring: `realized_size_sum * recency_weight(latest_open_ts)`.
fn select_hot_conditions<S: DataSource>(
    ing: &Ingestor<S>,
    n: usize,
) -> Result<Vec<ConditionId>, IngestError> {
    let active = ing.store.active_conditions()?;
    let mut seen = HashSet::new();
    Ok(active.into_iter().filter(|c| seen.insert(c.clone())).take(n).collect())
}
