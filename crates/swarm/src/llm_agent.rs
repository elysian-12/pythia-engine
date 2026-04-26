//! LLM-driven swarm agents.
//!
//! Each agent holds a personality prompt and, on every *material* event
//! (default: hourly rollover — not every tick, to keep token spend
//! finite), assembles a compact context and calls an LLM via tool-use
//! for a structured trade decision.
//!
//! The Anthropic integration is optional — in dry-run mode or when
//! `ANTHROPIC_API_KEY` is unset we inject a `MockLlmDecider` that
//! returns deterministic outputs so tests + offline runs still exercise
//! the agent pipeline.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use domain::{crypto::Asset, signal::Direction};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::agent::{AgentDecision, AgentKind, AgentProfile, Event, PeerView, SwarmAgent};

/// A personality the LLM is asked to role-play, plus its intrinsic
/// risk profile. The default roster ships 5 archetypes.
#[derive(Clone, Debug)]
pub struct Personality {
    pub id: String,
    pub prompt: String,
    pub risk_fraction: f64,
    pub horizon_s: i64,
    /// Only call the LLM every N events. Cost control.
    pub throttle_events: usize,
}

impl Personality {
    /// "Conservative risk manager" — low risk, long horizons, rare trades.
    pub fn cautious() -> Self {
        Self {
            id: "cautious-risk-manager".into(),
            prompt: "You are a conservative crypto trader focused on preserving capital. \
                You avoid crowded trades and only act when you have strong conviction (>70 %). \
                You hold for ~12 hours on average and never risk more than 0.5 % per trade."
                .into(),
            risk_fraction: 0.005,
            horizon_s: 12 * 3600,
            throttle_events: 100,
        }
    }

    /// "Momentum chaser" — follows the move, rides longer trends.
    pub fn momentum() -> Self {
        Self {
            id: "momentum-chaser".into(),
            prompt: "You chase momentum. When you see a big liquidation cascade you join it. \
                You are aggressive on winning trades and cut losers fast. \
                Trade horizon is 2–6 hours. Risk 1.5 % per trade."
                .into(),
            risk_fraction: 0.015,
            horizon_s: 4 * 3600,
            throttle_events: 80,
        }
    }

    /// "Contrarian fader" — bets against the crowd.
    pub fn contrarian() -> Self {
        Self {
            id: "contrarian-fader".into(),
            prompt: "You fade extreme moves. When the crowd is one-sided you take the opposite. \
                You require multiple confirmations before entering and prefer shorter horizons. \
                Risk 1 % per trade, horizon 2–4 hours."
                .into(),
            risk_fraction: 0.010,
            horizon_s: 3 * 3600,
            throttle_events: 100,
        }
    }

    /// "Degen" — high risk, short horizon, frequent.
    pub fn degen() -> Self {
        Self {
            id: "degen-scalper".into(),
            prompt: "You take many small bets, size up on conviction, and rotate in and out quickly. \
                You tolerate 3 % per trade risk and hold for 1–3 hours. \
                You trade every signal you see."
                .into(),
            risk_fraction: 0.030,
            horizon_s: 2 * 3600,
            throttle_events: 40,
        }
    }

    /// "Macro ranger" — slow, cycles based on funding + OI.
    pub fn macro_ranger() -> Self {
        Self {
            id: "macro-ranger".into(),
            prompt: "You trade slowly. You only act on sustained funding or OI regime shifts. \
                You hold for 24 hours or more. You risk 0.8 % per trade."
                .into(),
            risk_fraction: 0.008,
            horizon_s: 24 * 3600,
            throttle_events: 200,
        }
    }

    /// Default 5-personality roster.
    pub fn roster() -> Vec<Self> {
        vec![
            Self::cautious(),
            Self::momentum(),
            Self::contrarian(),
            Self::degen(),
            Self::macro_ranger(),
        ]
    }
}

/// Structured LLM output. Fully within our control — we only honour
/// decisions where the model filled every required field.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LlmDecision {
    pub action: LlmAction,
    pub asset: String,
    pub conviction: u8,
    pub rationale: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum LlmAction {
    Long,
    Short,
    Skip,
}

/// Abstraction over the LLM call — makes testing cheap.
#[async_trait]
pub trait LlmDecider: Send + Sync {
    async fn decide(&self, prompt: &str, context: &str) -> Option<LlmDecision>;
}

/// Mock implementation — returns a deterministic answer derived from
/// a hash of the context. Used in tests + offline runs.
#[derive(Debug, Clone)]
pub struct MockLlmDecider {
    pub default_action: LlmAction,
    pub conviction: u8,
}

impl Default for MockLlmDecider {
    fn default() -> Self {
        Self {
            default_action: LlmAction::Long,
            conviction: 60,
        }
    }
}

#[async_trait]
impl LlmDecider for MockLlmDecider {
    async fn decide(&self, _prompt: &str, context: &str) -> Option<LlmDecision> {
        // Flip direction on even/odd hash of context — just enough
        // variation to exercise both sides in tests.
        let mut hash: u64 = 0xcbf29ce484222325;
        for b in context.as_bytes() {
            hash ^= u64::from(*b);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        let action = if hash & 1 == 0 {
            self.default_action
        } else {
            match self.default_action {
                LlmAction::Long => LlmAction::Short,
                LlmAction::Short => LlmAction::Long,
                LlmAction::Skip => LlmAction::Skip,
            }
        };
        Some(LlmDecision {
            action,
            asset: "BTC".into(),
            conviction: self.conviction,
            rationale: "mock: deterministic hash-based".into(),
        })
    }
}

/// Anthropic-backed decider using tool-use for structured JSON.
pub struct AnthropicDecider {
    http: reqwest::Client,
    api_key: String,
    model: String,
}

impl std::fmt::Debug for AnthropicDecider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AnthropicDecider")
            .field("model", &self.model)
            .finish_non_exhaustive()
    }
}

impl AnthropicDecider {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self::with_model(api_key, "claude-opus-4-7")
    }
    pub fn with_model(api_key: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .expect("reqwest client"),
            api_key: api_key.into(),
            model: model.into(),
        }
    }
}

#[async_trait]
impl LlmDecider for AnthropicDecider {
    async fn decide(&self, prompt: &str, context: &str) -> Option<LlmDecision> {
        let tool = json!({
            "name": "trade_decision",
            "description": "Output a directional trade decision for the current market event.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["LONG", "SHORT", "SKIP"]},
                    "asset": {"type": "string", "enum": ["BTC", "ETH"]},
                    "conviction": {"type": "integer", "minimum": 0, "maximum": 100},
                    "rationale": {"type": "string"}
                },
                "required": ["action", "asset", "conviction", "rationale"]
            }
        });
        let body = json!({
            "model": self.model,
            "max_tokens": 512,
            "system": prompt,
            "tools": [tool],
            "tool_choice": {"type": "tool", "name": "trade_decision"},
            "messages": [{"role": "user", "content": format!(
                "Current market context:\n```\n{context}\n```\n\nRespond with the `trade_decision` tool."
            )}]
        });
        let resp = self
            .http
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let text = resp.text().await.ok()?;
        let v: serde_json::Value = serde_json::from_str(&text).ok()?;
        let input = v
            .get("content")?
            .as_array()?
            .iter()
            .find(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
            .and_then(|b| b.get("input"))?;
        serde_json::from_value(input.clone()).ok()
    }
}

/// The agent struct. Keeps a short rolling context string (recent liq
/// z-scores, recent price) + the personality prompt.
pub struct LlmAgent {
    id: String,
    profile: AgentProfile,
    personality: Personality,
    decider: Box<dyn LlmDecider>,
    event_counter: usize,
    recent_context: Vec<String>,
}

impl std::fmt::Debug for LlmAgent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LlmAgent")
            .field("id", &self.id)
            .field("personality", &self.personality.id)
            .finish_non_exhaustive()
    }
}

impl LlmAgent {
    pub fn new(personality: Personality, decider: Box<dyn LlmDecider>) -> Self {
        let profile = AgentProfile {
            kind: AgentKind::LlmDriven,
            risk_fraction: personality.risk_fraction,
            horizon_s: personality.horizon_s,
            personality: Some(personality.prompt.clone()),
            social: true,
        };
        Self {
            id: format!("llm-{}", personality.id),
            profile,
            personality,
            decider,
            event_counter: 0,
            recent_context: Vec::new(),
        }
    }
}

#[async_trait]
impl SwarmAgent for LlmAgent {
    fn id(&self) -> &str {
        &self.id
    }
    fn profile(&self) -> &AgentProfile {
        &self.profile
    }

    async fn observe(&mut self, event: &Event, peers: &PeerView) -> Option<AgentDecision> {
        self.event_counter += 1;
        // Sample interesting events — liquidations with a reasonable
        // USD size, and all hour-closes.
        let interesting = match event {
            Event::Liquidation { usd_value, .. } => *usd_value > 50_000.0,
            Event::HourClose { .. } => true,
            _ => false,
        };
        if !interesting {
            return None;
        }

        // Maintain a tiny context window.
        if self.recent_context.len() > 20 {
            self.recent_context.drain(..10);
        }
        self.recent_context.push(format_event(event));

        // Throttle the actual LLM call.
        if self.event_counter % self.personality.throttle_events != 0 {
            return None;
        }

        let context = format!(
            "Recent events (latest last):\n{}\n\nPeer behaviour:\n- {} recent peers went long ({:.0} %).\n- Champion agreement: {:.0} %.",
            self.recent_context.join("\n"),
            peers.recent.len(),
            peers.long_fraction * 100.0,
            peers.champion_agreement * 100.0
        );

        let decision = self.decider.decide(&self.personality.prompt, &context).await?;
        if matches!(decision.action, LlmAction::Skip) {
            return None;
        }
        let direction = match decision.action {
            LlmAction::Long => Direction::Long,
            LlmAction::Short => Direction::Short,
            LlmAction::Skip => return None,
        };
        let asset = match decision.asset.as_str() {
            "ETH" => Asset::Eth,
            _ => Asset::Btc,
        };
        let id = next_llm_decision_id();
        Some(AgentDecision {
            id,
            agent_id: self.id.clone(),
            ts: event.ts(),
            asset,
            direction,
            conviction: decision.conviction,
            risk_fraction: self.personality.risk_fraction,
            horizon_s: self.personality.horizon_s,
            rationale: decision.rationale,
        })
    }
}

fn format_event(event: &Event) -> String {
    match event {
        Event::Liquidation { ts, asset, side, usd_value } => {
            format!("[{}] LIQ {} {:?} ${:.0}", ts.0, asset.coin(), side, usd_value)
        }
        Event::Funding { ts, asset, funding } => {
            format!("[{}] FUND {} rate={:.6e}", ts.0, asset.coin(), funding.rate_close)
        }
        Event::Candle { ts, asset, candle } => {
            format!("[{}] BAR {} close={:.2}", ts.0, asset.coin(), candle.close)
        }
        Event::OpenInterest { ts, asset, oi } => {
            format!("[{}] OI {} close={:.0}", ts.0, asset.coin(), oi.close)
        }
        Event::HourClose { ts } => format!("[{}] HOUR_CLOSE", ts.0),
        Event::Polymarket { ts, asset, swp, mid } => {
            format!("[{}] PM {} swp={:.3} mid={:.3}", ts.0, asset.coin(), swp, mid)
        }
    }
}

fn next_llm_decision_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("llm-decision-{n}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::{crypto::LiqSide, time::EventTs};

    #[tokio::test]
    async fn mock_agent_fires_eventually() {
        let p = Personality::momentum();
        let mut agent = LlmAgent::new(p, Box::<MockLlmDecider>::default());
        let peers = PeerView::default();
        // Throttle is 80; 80 big-liq events should cause exactly one fire.
        let mut fires = 0;
        for i in 0..200 {
            let d = agent
                .observe(
                    &Event::Liquidation {
                        ts: EventTs::from_secs(i as i64 * 60),
                        asset: Asset::Btc,
                        side: LiqSide::Buy,
                        usd_value: 120_000.0,
                    },
                    &peers,
                )
                .await;
            if d.is_some() {
                fires += 1;
            }
        }
        assert!(fires >= 2, "expected multiple fires, got {fires}");
    }

    #[test]
    fn roster_has_five() {
        assert_eq!(Personality::roster().len(), 5);
    }
}
