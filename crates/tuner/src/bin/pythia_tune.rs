//! `pythia-tune` — offline tuner loop.
//!
//! Run on a cron (recommended: every 6 h) or as a long-running service.
//! Reads strategy stats from disk / store, runs the statistical gate,
//! optionally calls Anthropic, and queues proposals.
//!
//! Dry-run mode (`--dry-run`) uses a deterministic mock LLM so you can
//! watch the pipeline without spending API tokens.

use std::collections::HashMap;

use tuner::{
    bounds::Bounds,
    gate::{gate, GateDecision, GateStats},
    llm::{AnthropicClient, LlmClient, MockLlm, Proposal, ReviewContext},
    proposal::ProposalQueue,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt().init();
    let dry_run = std::env::args().any(|a| a == "--dry-run");
    let api_key = std::env::var("ANTHROPIC_API_KEY").ok();

    // Placeholder gate stats — in production these come from the store.
    // The fixture triggers a "Tune" decision (win rate shifted).
    let stats = GateStats {
        rolling_sharpe_30: 0.48,
        baseline_sharpe: 0.65,
        rolling_win_rate: 0.63,
        baseline_win_rate: 0.75,
        current_drawdown: 0.03,
        regime_changed: false,
        days_since_last_tune: 5.0,
    };
    let decision = gate(&stats);
    println!("gate decision: {:?}", decision);

    let confidence_floor = match &decision {
        GateDecision::Skip(reason) => {
            println!("skipping — {reason}");
            return Ok(());
        }
        GateDecision::Tune { confidence_floor, .. } => *confidence_floor,
        GateDecision::UrgentTune { .. } => 55.0,
    };

    let bounds = Bounds::default_liq_trend();
    let current = HashMap::from([
        ("z_threshold".to_string(), 2.5),
        ("risk_fraction".to_string(), 0.01),
    ]);
    let ctx = ReviewContext {
        strategy_id: "liq-trend".into(),
        current_config: current,
        bounds: bounds.clone(),
        rolling_metrics: serde_json::to_value(&stats).unwrap_or_default(),
        market_context: serde_json::json!({ "btc_7d_return": -0.05 }),
        trades_summary: serde_json::json!({ "n": 30, "avg_r": 0.18 }),
        gate_reason: format!("{:?}", decision),
    };

    let client: Box<dyn LlmClient> = if dry_run || api_key.is_none() {
        println!("using MOCK LLM (dry-run)");
        Box::new(MockLlm {
            fixed: Proposal {
                strategy_id: "liq-trend".into(),
                diagnosis: "mock: mild sharpe decay".into(),
                confidence: 70.0,
                proposed_change: HashMap::from([(
                    "z_threshold".to_string(),
                    2.7,
                )]),
                rationale: "mock tightening".into(),
                expected_effect: "fewer signals, higher hit rate".into(),
                rollback_trigger: "revert if win rate < 55 % after 30 trades".into(),
            },
        })
    } else {
        Box::new(AnthropicClient::new(api_key.unwrap()))
    };

    let proposal = client.propose(&ctx).await?;
    println!("proposal: {}", serde_json::to_string_pretty(&proposal)?);

    if proposal.confidence < confidence_floor {
        println!(
            "confidence {} < floor {} → write to review queue only",
            proposal.confidence, confidence_floor
        );
    }

    let queue = ProposalQueue::new(ProposalQueue::default_path());
    let id = queue.enqueue(proposal, 3600)?;
    println!("queued: {id}");
    Ok(())
}
