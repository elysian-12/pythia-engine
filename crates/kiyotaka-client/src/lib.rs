//! Typed client for the Kiyotaka Data API.
//!
//! - REST via reqwest with per-minute weight tracking (Advanced tier: 750).
//! - Boundary types deny unknown fields so schema drift is loud.
//! - Returns domain types; callers never see raw DTOs.
//!
//! Feature `smoke-live` enables a single end-to-end test against the real API.

#![deny(unused_must_use)]

mod dto;
mod error;
mod parsing;
mod rate;

use std::time::Duration;

use domain::{
    crypto::{Asset, Candle, FundingRate, Liquidation, OpenInterest},
    ids::{ConditionId, Wallet},
    market::MarketSummary,
    position::UserPosition,
    time::EventTs,
    trader::TraderProfile,
};
use reqwest::{Client, StatusCode};
use serde::Serialize;

pub use error::{Error, Result};
pub use rate::{RateLimitSnapshot, RateTracker};

pub const BASE_URL: &str = "https://api.kiyotaka.ai";

#[derive(Clone, Debug)]
pub struct KiyotakaClient {
    http: Client,
    base_url: String,
    api_key: String,
    rate: RateTracker,
}

#[derive(Copy, Clone, Debug, Serialize)]
pub enum Exchange {
    #[serde(rename = "BINANCE_FUTURES")]
    BinanceFutures,
    #[serde(rename = "BYBIT")]
    Bybit,
    #[serde(rename = "OKEX_SWAP")]
    OkxSwap,
}

impl Exchange {
    fn as_param(self) -> &'static str {
        match self {
            Self::BinanceFutures => "BINANCE_FUTURES",
            Self::Bybit => "BYBIT",
            Self::OkxSwap => "OKEX_SWAP",
        }
    }
}

#[derive(Copy, Clone, Debug, Serialize)]
pub enum Interval {
    #[serde(rename = "MINUTE")]
    Minute,
    #[serde(rename = "HOUR")]
    Hour,
    #[serde(rename = "DAY")]
    Day,
}

impl Interval {
    fn as_param(self) -> &'static str {
        match self {
            Self::Minute => "MINUTE",
            Self::Hour => "HOUR",
            Self::Day => "DAY",
        }
    }

    pub fn seconds(self) -> i64 {
        match self {
            Self::Minute => 60,
            Self::Hour => 3600,
            Self::Day => 86400,
        }
    }
}

/// Sort order for leaderboard.
#[derive(Copy, Clone, Debug)]
pub enum SortBy {
    RealizedPnl,
    Roi,
    WinRate,
    TotalSize,
}

impl SortBy {
    fn as_param(self) -> &'static str {
        match self {
            Self::RealizedPnl => "REALIZED_PNL",
            Self::Roi => "ROI",
            Self::WinRate => "WIN_RATE",
            Self::TotalSize => "TOTAL_SIZE",
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct LeaderboardFilter {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    pub min_win_rate: Option<f64>,
    pub min_total_volume: Option<f64>,
    pub min_total_trades: Option<f64>,
    pub primary_category: Option<String>,
    pub sort_by: Option<SortBy>,
}

impl KiyotakaClient {
    pub fn new(api_key: impl Into<String>) -> Result<Self> {
        Self::with_base_url(api_key, BASE_URL)
    }

    pub fn with_base_url(api_key: impl Into<String>, base_url: impl Into<String>) -> Result<Self> {
        let http = Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .user_agent("pythia-engine/0.1")
            .build()
            .map_err(Error::Build)?;
        Ok(Self {
            http,
            base_url: base_url.into(),
            api_key: api_key.into(),
            rate: RateTracker::new(),
        })
    }

    pub fn rate_snapshot(&self) -> RateLimitSnapshot {
        self.rate.snapshot()
    }

    async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<T> {
        let url = format!("{}{}", self.base_url, path);
        let resp = self
            .http
            .get(&url)
            .header("X-Kiyotaka-Key", &self.api_key)
            .query(query)
            .send()
            .await
            .map_err(Error::Network)?;

        let status = resp.status();
        self.rate.update_from_headers(resp.headers());
        let text = resp.text().await.map_err(Error::Network)?;

        match status {
            s if s.is_success() => serde_json::from_str::<T>(&text).map_err(|e| {
                tracing::warn!(error=%e, body=%text.chars().take(400).collect::<String>(), "decode failed");
                Error::Decode(e)
            }),
            StatusCode::TOO_MANY_REQUESTS => Err(Error::RateLimited(text)),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(Error::Auth(text)),
            s => Err(Error::Http { status: s.as_u16(), body: text }),
        }
    }

    /// Candles (OHLCV) for one symbol/exchange.
    pub async fn candles(
        &self,
        exchange: Exchange,
        raw_symbol: &str,
        interval: Interval,
        from: i64,
        period_s: i64,
    ) -> Result<Vec<Candle>> {
        let q = vec![
            ("type", "TRADE_SIDE_AGNOSTIC_AGG".to_string()),
            ("exchange", exchange.as_param().to_string()),
            ("rawSymbol", raw_symbol.to_string()),
            ("interval", interval.as_param().to_string()),
            ("from", from.to_string()),
            ("period", period_s.to_string()),
        ];
        let raw: dto::SeriesEnvelope<dto::CandlePoint> = self.get_json("/v1/points", &q).await?;
        Ok(parsing::flatten_series(raw, parsing::candle_from))
    }

    pub async fn funding_rate(
        &self,
        exchange: Exchange,
        raw_symbol: &str,
        interval: Interval,
        from: i64,
        period_s: i64,
    ) -> Result<Vec<FundingRate>> {
        let q = vec![
            ("type", "FUNDING_RATE_AGG".to_string()),
            ("exchange", exchange.as_param().to_string()),
            ("rawSymbol", raw_symbol.to_string()),
            ("interval", interval.as_param().to_string()),
            ("from", from.to_string()),
            ("period", period_s.to_string()),
        ];
        let raw: dto::SeriesEnvelope<dto::FundingPoint> = self.get_json("/v1/points", &q).await?;
        Ok(parsing::flatten_series(raw, parsing::funding_from))
    }

    pub async fn open_interest(
        &self,
        exchange: Exchange,
        raw_symbol: &str,
        interval: Interval,
        from: i64,
        period_s: i64,
    ) -> Result<Vec<OpenInterest>> {
        let q = vec![
            ("type", "OPEN_INTEREST_AGG".to_string()),
            ("exchange", exchange.as_param().to_string()),
            ("rawSymbol", raw_symbol.to_string()),
            ("interval", interval.as_param().to_string()),
            ("from", from.to_string()),
            ("period", period_s.to_string()),
        ];
        let raw: dto::SeriesEnvelope<dto::OpenInterestPoint> =
            self.get_json("/v1/points", &q).await?;
        Ok(parsing::flatten_series(raw, parsing::oi_from))
    }

    pub async fn liquidations(
        &self,
        exchange: Exchange,
        raw_symbol: &str,
        interval: Interval,
        from: i64,
        period_s: i64,
    ) -> Result<Vec<Liquidation>> {
        let q = vec![
            ("type", "LIQUIDATION_AGG".to_string()),
            ("exchange", exchange.as_param().to_string()),
            ("rawSymbol", raw_symbol.to_string()),
            ("interval", interval.as_param().to_string()),
            ("from", from.to_string()),
            ("period", period_s.to_string()),
        ];
        let raw: dto::SeriesEnvelope<dto::LiquidationPoint> =
            self.get_json("/v1/points", &q).await?;
        Ok(parsing::flatten_liquidations(raw))
    }

    /// Helper: 24h of hourly candles for an asset, from Binance Futures.
    pub async fn candles_24h(&self, asset: Asset) -> Result<Vec<Candle>> {
        let now = chrono::Utc::now().timestamp();
        self.candles(
            Exchange::BinanceFutures,
            asset.symbol(),
            Interval::Hour,
            now - 86_400,
            86_400,
        )
        .await
    }

    // ---- Polymarket analytics ----

    pub async fn leaderboard(&self, f: &LeaderboardFilter) -> Result<Vec<TraderProfile>> {
        let mut q: Vec<(&str, String)> = Vec::new();
        if let Some(v) = f.limit {
            q.push(("limit", v.to_string()));
        }
        if let Some(v) = f.offset {
            q.push(("offset", v.to_string()));
        }
        if let Some(v) = f.min_win_rate {
            q.push(("winRate", v.to_string()));
        }
        if let Some(v) = f.min_total_volume {
            q.push(("totalVolume", v.to_string()));
        }
        if let Some(v) = f.min_total_trades {
            q.push(("minTotalTradeCount", v.to_string()));
        }
        if let Some(v) = &f.primary_category {
            q.push(("primaryCategory", v.clone()));
        }
        if let Some(v) = f.sort_by {
            q.push(("sortBy", v.as_param().to_string()));
            q.push(("sortDirection", "SORT_DIRECTION_DESC".to_string()));
        }
        let raw: dto::LeaderboardEnvelope =
            self.get_json("/v1/polymarket/analytics/leaderboard", &q).await?;
        Ok(raw.trader_profiles.into_iter().map(parsing::trader_from).collect())
    }

    pub async fn trader_profile(&self, wallet: &Wallet) -> Result<Option<TraderProfile>> {
        let q = vec![("userWallet", wallet.as_str().to_string())];
        let raw: dto::TraderProfileEnvelope =
            self.get_json("/v1/polymarket/analytics/trader-profile", &q).await?;
        Ok(raw.trader_profile.map(parsing::trader_from))
    }

    /// Positions by wallet, assetId, or conditionId.
    pub async fn positions(
        &self,
        wallet: Option<&Wallet>,
        condition_id: Option<&ConditionId>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<UserPosition>> {
        let mut q: Vec<(&str, String)> = vec![
            ("limit", limit.to_string()),
            ("offset", offset.to_string()),
        ];
        if let Some(w) = wallet {
            q.push(("userWallet", w.as_str().to_string()));
        }
        if let Some(c) = condition_id {
            q.push(("conditionId", c.as_str().to_string()));
        }
        let raw: dto::PositionsEnvelope =
            self.get_json("/v1/polymarket/analytics/positions", &q).await?;
        Ok(raw.user_positions.into_iter().map(parsing::position_from).collect())
    }

    pub async fn market_summary(
        &self,
        condition_id: &ConditionId,
        asof: EventTs,
    ) -> Result<MarketSummary> {
        let q = vec![("conditionId", condition_id.as_str().to_string())];
        let raw: dto::MarketSummaryEnvelope =
            self.get_json("/v1/polymarket/analytics/market-summary", &q).await?;
        let ms = raw.market_summary.ok_or_else(|| Error::Missing("marketSummary".into()))?;
        Ok(parsing::market_summary_from(ms, asof))
    }
}

/// Round-trip check: does the exchange accept our API key?
/// `/v1/usage` is 0-weight but some keys fail with 403 — so we fall back to
/// a 1-point candles request that always succeeds on Advanced tier.
pub async fn smoke_check(client: &KiyotakaClient) -> Result<()> {
    let now = chrono::Utc::now().timestamp();
    let _ = client
        .candles(Exchange::BinanceFutures, "BTCUSDT", Interval::Hour, now - 3600, 3600)
        .await?;
    Ok(())
}
