//! End-to-end ingest test with a mock `DataSource`. Verifies the pipeline
//! ingest→store with no real network calls.

use std::sync::Arc;

use async_trait::async_trait;
use domain::{
    crypto::{Candle, FundingRate, LiqSide, Liquidation, OpenInterest},
    ids::{AssetId, ConditionId, Wallet},
    market::{Category, MarketSummary},
    position::UserPosition,
    time::EventTs,
    trader::TraderProfile,
};
use evaluation::LatencyCollector;
use ingest::{BudgetCfg, DataSource, IngestConfig, Ingestor, LiveSignalCfg, WeightBudget};
use kiyotaka_client::{Exchange, Interval, LeaderboardFilter};
use store::Store;
use tokio::sync::Notify;

#[derive(Default)]
struct MockSource;

#[async_trait]
impl DataSource for MockSource {
    async fn candles(
        &self,
        _ex: Exchange,
        _sym: &str,
        _iv: Interval,
        from: i64,
        _period: i64,
    ) -> Result<Vec<Candle>, kiyotaka_client::Error> {
        Ok((0..24)
            .map(|i| Candle {
                ts: EventTs::from_secs(from + i * 3600),
                open: 100.0 + i as f64,
                high: 101.0 + i as f64,
                low: 99.0 + i as f64,
                close: 100.5 + i as f64,
                volume: 1000.0,
            })
            .collect())
    }

    async fn funding_rate(
        &self,
        _ex: Exchange,
        _sym: &str,
        _iv: Interval,
        from: i64,
        _period: i64,
    ) -> Result<Vec<FundingRate>, kiyotaka_client::Error> {
        Ok((0..24)
            .map(|i| FundingRate {
                ts: EventTs::from_secs(from + i * 3600),
                rate_open: 0.0001,
                rate_close: 0.0001,
                predicted_close: None,
            })
            .collect())
    }

    async fn open_interest(
        &self,
        _ex: Exchange,
        _sym: &str,
        _iv: Interval,
        from: i64,
        _period: i64,
    ) -> Result<Vec<OpenInterest>, kiyotaka_client::Error> {
        Ok((0..24)
            .map(|i| OpenInterest {
                ts: EventTs::from_secs(from + i * 3600),
                close: 1_000_000.0,
                high: 1_000_000.0,
                low: 1_000_000.0,
            })
            .collect())
    }

    async fn liquidations(
        &self,
        _ex: Exchange,
        _sym: &str,
        _iv: Interval,
        from: i64,
        _period: i64,
    ) -> Result<Vec<Liquidation>, kiyotaka_client::Error> {
        Ok((0..24)
            .map(|i| Liquidation {
                ts: EventTs::from_secs(from + i * 3600),
                side: if i % 2 == 0 { LiqSide::Buy } else { LiqSide::Sell },
                volume_usd: 10_000.0,
            })
            .collect())
    }

    async fn leaderboard(
        &self,
        _f: &LeaderboardFilter,
    ) -> Result<Vec<TraderProfile>, kiyotaka_client::Error> {
        Ok(vec![TraderProfile {
            wallet: Wallet::new("0xabc"),
            total_position_count: 100,
            open_position_count: 5,
            closed_position_count: 95,
            total_size: 500_000.0,
            total_realized_pnl: 50_000.0,
            total_unrealized_pnl: 1_000.0,
            total_roi: 10.0,
            win_rate_by_positions: 75.0,
            largest_win: 10_000.0,
            largest_loss: -2_000.0,
            avg_holding_duration: 86_400,
        }])
    }

    async fn trader_profile(
        &self,
        _w: &Wallet,
    ) -> Result<Option<TraderProfile>, kiyotaka_client::Error> {
        Ok(None)
    }

    async fn positions(
        &self,
        _w: Option<&Wallet>,
        _c: Option<&ConditionId>,
        _limit: u32,
    ) -> Result<Vec<UserPosition>, kiyotaka_client::Error> {
        Ok(vec![UserPosition {
            wallet: Wallet::new("0xabc"),
            asset_id: AssetId::new("aid"),
            condition_id: ConditionId::new("cid"),
            unrealized_size: 100_000.0,
            realized_size: 0.0,
            avg_price: 0.55,
            avg_exit_price: 0.0,
            realized_pnl: 0.0,
            resolved_price: None,
            latest_open_ts: 0,
            prev_hold_duration: 0,
            buy_count: 3,
            sell_count: 0,
            market_name: "Will Fed cut rates in June?".into(),
            outcome_name: "Yes".into(),
            category: Category::Other("Politics".into()),
            sub_category: "US Politics".into(),
        }])
    }

    async fn market_summary(
        &self,
        _c: &ConditionId,
        asof: EventTs,
    ) -> Result<MarketSummary, kiyotaka_client::Error> {
        Ok(MarketSummary {
            event_id: "evt".into(),
            condition_ids: vec![ConditionId::new("cid")],
            total_open_positions: 10,
            total_closed_positions: 20,
            total_cost_basis: 0.0,
            total_size: 0.0,
            largest_open_position: 0.0,
            total_buy_count: 100,
            total_sell_count: 80,
            net_transfer_flow: 0,
            median_hold_duration: 0.0,
            mean_hold_duration: 0.0,
            realized_pnl_min: 0.0,
            realized_pnl_max: 0.0,
            realized_pnl_distribution: vec![],
            win_rate: 0.6,
            avg_size: 100.0,
            outcome_pricing: vec![],
            asof,
        })
    }
}

#[tokio::test]
async fn mock_pipeline_roundtrip() {
    let src = Arc::new(MockSource);
    let store = Store::open_in_memory().unwrap();
    let budget = Arc::new(WeightBudget::new(BudgetCfg {
        per_minute: 100_000,
        burst: 100_000,
    }));
    let ing = Ingestor {
        source: src,
        store: store.clone(),
        budget,
        config: IngestConfig::default(),
        shutdown: Arc::new(Notify::new()),
        latency: Arc::new(LatencyCollector::new()),
        signal_cfg: Arc::new(LiveSignalCfg::default()),
    };

    let stats = ing.run_once().await.unwrap();
    assert!(stats.candles >= 24);
    assert!(stats.funding >= 24);
    assert!(stats.oi >= 24);
    assert!(stats.liquidations >= 24);
    assert!(stats.profiles >= 1);
    assert!(stats.positions >= 1);

    // Verify storage worked
    assert_eq!(store.count_table("candles").unwrap(), 48); // BTC + ETH, 24 each
    assert!(store.count_table("funding").unwrap() > 0);
    assert!(store.count_table("trader_profiles").unwrap() >= 1);
    assert!(store.count_table("user_positions").unwrap() >= 1);
}
