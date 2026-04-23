//! Public Polymarket Gamma API client.
//!
//! Two roles in PolyEdge:
//! 1. **Shadow source** — sanity-check mid-prices against Kiyotaka.
//! 2. **Historical odds** — continuous time-series for backtest, since Kiyotaka's
//!    Polymarket endpoints return snapshots.
//!
//! Docs: <https://docs.polymarket.com/developers/gamma-markets-api/>

#![deny(unused_must_use)]

use domain::ids::ConditionId;
use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;
use thiserror::Error;

pub const BASE_URL: &str = "https://gamma-api.polymarket.com";

#[derive(Debug, Error)]
pub enum Error {
    #[error("build http client: {0}")]
    Build(reqwest::Error),
    #[error("network: {0}")]
    Network(reqwest::Error),
    #[error("decode: {0}")]
    Decode(serde_json::Error),
    #[error("http {0}")]
    Http(u16),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug)]
pub struct GammaClient {
    http: Client,
    base: String,
}

impl GammaClient {
    pub fn new() -> Result<Self> {
        let http = Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("pythia-gamma/0.1")
            .build()
            .map_err(Error::Build)?;
        Ok(Self {
            http,
            base: BASE_URL.into(),
        })
    }

    /// Fetch current market mid-price for a condition.
    /// Gamma returns markets keyed by condition_id; we extract the last trade price.
    pub async fn current_mid(&self, condition_id: &ConditionId) -> Result<Option<f64>> {
        let url = format!("{}/markets", self.base);
        let resp = self
            .http
            .get(url)
            .query(&[("condition_ids", condition_id.as_str())])
            .send()
            .await
            .map_err(Error::Network)?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Error::Http(status.as_u16()));
        }
        let text = resp.text().await.map_err(Error::Network)?;
        let markets: Vec<GammaMarket> = serde_json::from_str(&text).map_err(Error::Decode)?;
        Ok(markets.into_iter().next().and_then(|m| m.last_trade_price()))
    }
}

#[derive(Debug, Deserialize)]
struct GammaMarket {
    #[serde(default)]
    last_trade_price: Option<f64>,
    #[serde(default)]
    outcome_prices: Option<String>,
}

impl GammaMarket {
    fn last_trade_price(&self) -> Option<f64> {
        if let Some(p) = self.last_trade_price {
            return Some(p);
        }
        // outcomePrices is sometimes serialised as JSON array inside a string: `"[\"0.53\",\"0.47\"]"`.
        self.outcome_prices
            .as_ref()
            .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
            .and_then(|v| v.first().and_then(|x| x.parse().ok()))
    }
}
