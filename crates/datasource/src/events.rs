//! Canonical event type consumed by every strategy.

use domain::{
    crypto::LiqSide,
    time::EventTs,
};
use serde::{Deserialize, Serialize};

/// All event types the platform understands. Adding a new data source
/// usually means adding a new variant here (rare — mostly strategies
/// compose existing variants).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Event {
    Liquidation(LiqEvent),
    Funding(FundingEvent),
    Oi(OiEvent),
    /// LLM-scored sentiment from a news or social feed. `score ∈ [-1, 1]`
    /// with a provider label so strategies can filter (e.g. only trust
    /// Messari headlines, not unverified Twitter).
    Sentiment(SentimentEvent),
    /// Options 25-delta skew (call IV − put IV). Positive = call premium
    /// (bullish positioning); negative = put premium.
    Skew(SkewEvent),
    /// Order-book depth imbalance at the top-N levels.
    BookImbalance(BookImbalance),
    /// Aggregated on-chain net flow into exchanges. Positive = inflows
    /// (bearish), negative = outflows (bullish).
    OnChainFlow(OnChainFlow),
}

impl Event {
    pub fn kind(&self) -> EventKind {
        match self {
            Event::Liquidation(_) => EventKind::Liquidation,
            Event::Funding(_) => EventKind::Funding,
            Event::Oi(_) => EventKind::Oi,
            Event::Sentiment(_) => EventKind::Sentiment,
            Event::Skew(_) => EventKind::Skew,
            Event::BookImbalance(_) => EventKind::BookImbalance,
            Event::OnChainFlow(_) => EventKind::OnChainFlow,
        }
    }

    pub fn ts(&self) -> EventTs {
        match self {
            Event::Liquidation(e) => e.ts,
            Event::Funding(e) => e.ts,
            Event::Oi(e) => e.ts,
            Event::Sentiment(e) => e.ts,
            Event::Skew(e) => e.ts,
            Event::BookImbalance(e) => e.ts,
            Event::OnChainFlow(e) => e.ts,
        }
    }

    pub fn symbol(&self) -> Option<&str> {
        match self {
            Event::Liquidation(e) => Some(&e.symbol),
            Event::Funding(e) => Some(&e.symbol),
            Event::Oi(e) => Some(&e.symbol),
            Event::Sentiment(e) => e.symbol.as_deref(),
            Event::Skew(e) => Some(&e.symbol),
            Event::BookImbalance(e) => Some(&e.symbol),
            Event::OnChainFlow(e) => Some(&e.symbol),
        }
    }
}

/// Lightweight discriminator for filtering — avoids `std::mem::discriminant`
/// boilerplate in match arms.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum EventKind {
    Liquidation,
    Funding,
    Oi,
    Sentiment,
    Skew,
    BookImbalance,
    OnChainFlow,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LiqEvent {
    pub ts: EventTs,
    pub exchange: String,
    pub symbol: String,
    pub side: LiqSide,
    pub usd_value: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FundingEvent {
    pub ts: EventTs,
    pub exchange: String,
    pub symbol: String,
    pub rate_annualised: f64,
    pub interval_hours: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OiEvent {
    pub ts: EventTs,
    pub exchange: String,
    pub symbol: String,
    pub open_interest_usd: f64,
    /// 24-hour percent change for immediate use by trend strategies.
    pub pct_change_24h: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SentimentEvent {
    pub ts: EventTs,
    pub provider: String, // "messari", "twitter-llm", "reddit-llm", ...
    pub symbol: Option<String>,
    /// Normalised score ∈ [-1, +1].
    pub score: f64,
    /// Confidence of the classifier ∈ [0, 1].
    pub confidence: f64,
    pub headline: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SkewEvent {
    pub ts: EventTs,
    pub exchange: String, // "deribit", "aevo"
    pub symbol: String,
    pub tenor_days: u32,
    pub delta_25_skew: f64, // (call IV - put IV)
    pub atm_iv: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BookImbalance {
    pub ts: EventTs,
    pub exchange: String,
    pub symbol: String,
    /// (bid_usd − ask_usd) / (bid_usd + ask_usd) at top 10 levels.
    pub imbalance: f64,
    pub bid_usd: f64,
    pub ask_usd: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OnChainFlow {
    pub ts: EventTs,
    pub symbol: String, // "BTC", "ETH"
    /// Positive = net inflow to exchanges (bearish).
    pub net_flow_usd_1h: f64,
    pub provider: String,
}
