//! Anthropic client with tool-use for structured output.
//!
//! The LLM is called via a single tool (`propose_tuning`) whose input
//! schema forces JSON with diagnosis/confidence/proposed_change/
//! rationale/rollback_trigger. Post-validation pins every numeric
//! value into `Bounds`.

use std::collections::HashMap;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use thiserror::Error;

use crate::bounds::Bounds;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReviewContext {
    pub strategy_id: String,
    pub current_config: HashMap<String, f64>,
    pub bounds: Bounds,
    pub rolling_metrics: serde_json::Value,
    pub market_context: serde_json::Value,
    pub trades_summary: serde_json::Value,
    pub gate_reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Proposal {
    pub strategy_id: String,
    pub diagnosis: String,
    pub confidence: f64,
    pub proposed_change: HashMap<String, f64>,
    pub rationale: String,
    pub expected_effect: String,
    pub rollback_trigger: String,
}

#[derive(Debug, Error)]
pub enum LlmError {
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("api: {0}")]
    Api(String),
    #[error("decode: {0}")]
    Decode(String),
    #[error("no valid proposal in response")]
    NoProposal,
}

#[async_trait]
pub trait LlmClient: Send + Sync {
    async fn propose(&self, ctx: &ReviewContext) -> Result<Proposal, LlmError>;
}

/// Deterministic mock — used in tests and in --dry-run mode to verify
/// the pipeline without burning API tokens.
#[derive(Debug, Clone)]
pub struct MockLlm {
    pub fixed: Proposal,
}

#[async_trait]
impl LlmClient for MockLlm {
    async fn propose(&self, _ctx: &ReviewContext) -> Result<Proposal, LlmError> {
        Ok(self.fixed.clone())
    }
}

#[derive(Debug)]
pub struct AnthropicClient {
    http: reqwest::Client,
    api_key: String,
    model: String,
    base_url: String,
}

impl AnthropicClient {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self::with_model(api_key, "claude-opus-4-7")
    }

    pub fn with_model(api_key: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(45))
                .build()
                .expect("reqwest client"),
            api_key: api_key.into(),
            model: model.into(),
            base_url: "https://api.anthropic.com/v1/messages".into(),
        }
    }
}

#[async_trait]
impl LlmClient for AnthropicClient {
    async fn propose(&self, ctx: &ReviewContext) -> Result<Proposal, LlmError> {
        // Assemble the system + user prompts.
        let system = "You are the tuning analyst for a systematic crypto trading bot.
You never make trading decisions; you only propose small parameter
adjustments within declared bounds. You must return your answer via the
`propose_tuning` tool. Keep the proposed change to AT MOST ONE parameter
per cycle. If nothing looks actionable, return an empty
`proposed_change` with low confidence.";

        let user = format!(
            "Review context:\n```json\n{}\n```",
            serde_json::to_string_pretty(ctx).unwrap_or_default()
        );

        // Tool schema — forces structured output.
        let tool = json!({
            "name": "propose_tuning",
            "description": "Return a tuning proposal for the strategy.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "diagnosis": {"type": "string"},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 100},
                    "proposed_change": {
                        "type": "object",
                        "additionalProperties": {"type": "number"}
                    },
                    "rationale": {"type": "string"},
                    "expected_effect": {"type": "string"},
                    "rollback_trigger": {"type": "string"}
                },
                "required": [
                    "diagnosis", "confidence", "proposed_change",
                    "rationale", "expected_effect", "rollback_trigger"
                ]
            }
        });

        let body = json!({
            "model": self.model,
            "max_tokens": 1024,
            "system": system,
            "tools": [tool],
            "tool_choice": {"type": "tool", "name": "propose_tuning"},
            "messages": [
                {"role": "user", "content": user}
            ]
        });

        let resp = self
            .http
            .post(&self.base_url)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(LlmError::Api(format!("{}: {}", status, text)));
        }

        let parsed: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| LlmError::Decode(e.to_string()))?;
        let tool_input = parsed
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.iter().find(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use")))
            .and_then(|b| b.get("input"))
            .ok_or(LlmError::NoProposal)?;

        let mut proposal: Proposal = serde_json::from_value(tool_input.clone())
            .map_err(|e| LlmError::Decode(e.to_string()))?;
        proposal.strategy_id.clone_from(&ctx.strategy_id);
        // Post-sanitise against bounds.
        let (ok, rejects) = ctx.bounds.sanitise(&proposal.proposed_change);
        if !rejects.is_empty() {
            tracing::warn!(rejects=?rejects, "dropped out-of-bounds proposals");
        }
        proposal.proposed_change = ok;
        Ok(proposal)
    }
}
