//! Agent trait + supporting types.
//!
//! An `SwarmAgent` is anything that can watch a stream of events and
//! (sometimes) emit a trade decision. Implementations: `SystematicAgent`
//! (uses an existing `CryptoStrategy`), `LlmAgent` (future — prompts an
//! LLM per event with a personality), `HybridAgent`.

use async_trait::async_trait;
use domain::{
    crypto::{Asset, Candle, FundingRate, LiqSide, Liquidation, OpenInterest},
    signal::Direction,
    time::EventTs,
};
use serde::{Deserialize, Serialize};

/// Unified event passed to every agent. Produced by the orchestrator
/// from whatever upstream feed is active (Kiyotaka WS, Binance WS,
/// replay from DuckDB).
#[derive(Clone, Debug)]
pub enum Event {
    Liquidation {
        ts: EventTs,
        asset: Asset,
        side: LiqSide,
        usd_value: f64,
    },
    Candle {
        ts: EventTs,
        asset: Asset,
        candle: Candle,
    },
    Funding {
        ts: EventTs,
        asset: Asset,
        funding: FundingRate,
    },
    OpenInterest {
        ts: EventTs,
        asset: Asset,
        oi: OpenInterest,
    },
    /// Hourly rollover marker — lets agents finalise their local
    /// aggregators without waiting for the next organic event.
    HourClose { ts: EventTs },
}

impl Event {
    pub fn ts(&self) -> EventTs {
        match self {
            Event::Liquidation { ts, .. }
            | Event::Candle { ts, .. }
            | Event::Funding { ts, .. }
            | Event::OpenInterest { ts, .. }
            | Event::HourClose { ts } => *ts,
        }
    }
}

/// From a `Liquidation` row in the store, build the unified event.
impl From<(Asset, &Liquidation)> for Event {
    fn from((asset, l): (Asset, &Liquidation)) -> Self {
        Event::Liquidation {
            ts: l.ts,
            asset,
            side: l.side,
            usd_value: l.volume_usd,
        }
    }
}

/// A single trade intention from one agent at one point in time.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentDecision {
    /// Unique across all agent decisions in a run.
    pub id: String,
    pub agent_id: String,
    pub ts: EventTs,
    pub asset: Asset,
    pub direction: Direction,
    /// Self-reported conviction ∈ [0, 100]. Used to size decisions in
    /// consensus aggregation.
    pub conviction: u8,
    /// Preferred risk fraction for this trade (0.01 = 1 %). The
    /// orchestrator honours or overrides per its own sizing policy.
    pub risk_fraction: f64,
    /// Preferred holding horizon in seconds.
    pub horizon_s: i64,
    /// Human-readable rationale for logging / auditing.
    pub rationale: String,
}

/// What kind of agent this is — for diagnostics + ranking segmentation.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentKind {
    /// Deterministic; backed by a `CryptoStrategy`.
    Systematic,
    /// Prompts an LLM per event with a personality string.
    LlmDriven,
    /// Systematic signal gated by an LLM risk assessment.
    Hybrid,
    /// Follows the consensus of recent peer decisions.
    MomentumFollower,
    /// Fades the consensus of recent peer decisions.
    Contrarian,
}

/// Agent metadata — visible to the orchestrator + report renderers.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentProfile {
    pub kind: AgentKind,
    pub risk_fraction: f64,
    pub horizon_s: i64,
    pub personality: Option<String>,
    /// If true, `observe` will also receive a `PeerView` showing what
    /// other agents decided in the recent past.
    pub social: bool,
}

/// Snapshot of recent peer decisions — the social-influence layer.
#[derive(Clone, Debug, Default)]
pub struct PeerView {
    pub recent: Vec<AgentDecision>,
    /// Fraction of recent peer decisions that went long.
    pub long_fraction: f64,
    /// Fraction that matched the current dominant champion.
    pub champion_agreement: f64,
}

/// The trait every agent implements.
#[async_trait]
pub trait SwarmAgent: Send + Sync {
    fn id(&self) -> &str;
    fn profile(&self) -> &AgentProfile;

    /// Called on every event. Returns `Some` when the agent wants to
    /// trade *right now* on that event.
    ///
    /// `peers` is only populated when `profile.social == true`.
    async fn observe(&mut self, event: &Event, peers: &PeerView) -> Option<AgentDecision>;
}
