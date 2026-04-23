//! `DataSource` trait so ingest can be tested without hitting the network.

use async_trait::async_trait;
use domain::{
    crypto::{Candle, FundingRate, Liquidation, OpenInterest},
    ids::{ConditionId, Wallet},
    market::MarketSummary,
    position::UserPosition,
    time::EventTs,
    trader::TraderProfile,
};
use kiyotaka_client::{Exchange, Interval, KiyotakaClient, LeaderboardFilter};

pub type Result<T> = std::result::Result<T, kiyotaka_client::Error>;

#[async_trait]
pub trait DataSource {
    async fn candles(
        &self,
        ex: Exchange,
        symbol: &str,
        iv: Interval,
        from: i64,
        period: i64,
    ) -> Result<Vec<Candle>>;

    async fn funding_rate(
        &self,
        ex: Exchange,
        symbol: &str,
        iv: Interval,
        from: i64,
        period: i64,
    ) -> Result<Vec<FundingRate>>;

    async fn open_interest(
        &self,
        ex: Exchange,
        symbol: &str,
        iv: Interval,
        from: i64,
        period: i64,
    ) -> Result<Vec<OpenInterest>>;

    async fn liquidations(
        &self,
        ex: Exchange,
        symbol: &str,
        iv: Interval,
        from: i64,
        period: i64,
    ) -> Result<Vec<Liquidation>>;

    async fn leaderboard(&self, f: &LeaderboardFilter) -> Result<Vec<TraderProfile>>;
    async fn trader_profile(&self, wallet: &Wallet) -> Result<Option<TraderProfile>>;
    async fn positions(
        &self,
        wallet: Option<&Wallet>,
        cid: Option<&ConditionId>,
        limit: u32,
    ) -> Result<Vec<UserPosition>>;
    async fn market_summary(&self, cid: &ConditionId, asof: EventTs) -> Result<MarketSummary>;
}

/// Real-network source backed by `KiyotakaClient`.
#[derive(Debug, Clone)]
pub struct LiveSource {
    pub client: KiyotakaClient,
}

impl LiveSource {
    pub fn new(client: KiyotakaClient) -> Self {
        Self { client }
    }
}

#[async_trait]
impl DataSource for LiveSource {
    async fn candles(
        &self,
        ex: Exchange,
        symbol: &str,
        iv: Interval,
        from: i64,
        period: i64,
    ) -> Result<Vec<Candle>> {
        self.client.candles(ex, symbol, iv, from, period).await
    }
    async fn funding_rate(
        &self,
        ex: Exchange,
        symbol: &str,
        iv: Interval,
        from: i64,
        period: i64,
    ) -> Result<Vec<FundingRate>> {
        self.client.funding_rate(ex, symbol, iv, from, period).await
    }
    async fn open_interest(
        &self,
        ex: Exchange,
        symbol: &str,
        iv: Interval,
        from: i64,
        period: i64,
    ) -> Result<Vec<OpenInterest>> {
        self.client.open_interest(ex, symbol, iv, from, period).await
    }
    async fn liquidations(
        &self,
        ex: Exchange,
        symbol: &str,
        iv: Interval,
        from: i64,
        period: i64,
    ) -> Result<Vec<Liquidation>> {
        self.client.liquidations(ex, symbol, iv, from, period).await
    }
    async fn leaderboard(&self, f: &LeaderboardFilter) -> Result<Vec<TraderProfile>> {
        self.client.leaderboard(f).await
    }
    async fn trader_profile(&self, wallet: &Wallet) -> Result<Option<TraderProfile>> {
        self.client.trader_profile(wallet).await
    }
    async fn positions(
        &self,
        wallet: Option<&Wallet>,
        cid: Option<&ConditionId>,
        limit: u32,
    ) -> Result<Vec<UserPosition>> {
        self.client.positions(wallet, cid, limit, 0).await
    }
    async fn market_summary(&self, cid: &ConditionId, asof: EventTs) -> Result<MarketSummary> {
        self.client.market_summary(cid, asof).await
    }
}
