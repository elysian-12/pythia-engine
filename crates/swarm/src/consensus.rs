//! Consensus rule — decide whether to execute based on agent agreement.
//!
//! Default rule: **majority of the top-K champions must agree on a
//! direction** AND at least `min_agent_count` total agents must have
//! voted. If either fails, skip.
//!
//! This is the "from many minds, one trade" synthesis — cheaper than
//! retraining a meta-model and surprisingly effective in practice.

use std::collections::HashMap;

use domain::{crypto::Asset, signal::Direction, time::EventTs};
use serde::{Deserialize, Serialize};

use crate::agent::AgentDecision;
use crate::scoring::{AgentStats, Scoreboard};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConsensusCfg {
    /// Top-K champions whose vote counts.
    pub top_k: usize,
    /// Minimum decisions an agent needs to be eligible as a champion.
    pub min_decisions_for_champion: usize,
    /// Majority threshold among champions, e.g. 0.6 = 60 %.
    pub champion_agreement: f64,
    /// Minimum total agent count voting on this event.
    pub min_agent_count: usize,
    /// Overall minimum agreement across all voting agents.
    pub overall_agreement: f64,
}

impl Default for ConsensusCfg {
    fn default() -> Self {
        Self {
            top_k: 5,
            // Asymptotic-normality floor — under Sharpe ranking, agents
            // with <30 trades can have near-infinite Sharpe via
            // zero-variance flukes (3 wins in a row → Sharpe = ∞). 30
            // is the conventional threshold where the central limit
            // theorem makes the Sharpe estimate stable enough to
            // compare across agents.
            min_decisions_for_champion: 30,
            champion_agreement: 0.6,
            min_agent_count: 3,
            overall_agreement: 0.5,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConsensusDecision {
    pub ts: EventTs,
    pub asset: Asset,
    pub direction: Direction,
    pub agent_count: usize,
    pub champion_count: usize,
    pub champion_agreement: f64,
    pub overall_agreement: f64,
    pub champions: Vec<String>,
    pub contributing_decisions: Vec<String>, // decision ids
    pub avg_conviction: f64,
    pub avg_risk_fraction: f64,
    pub horizon_s: i64,
}

/// Compute a consensus decision over a slate of agent decisions.
///
/// Grouped by `(asset, direction)` — we pick the largest group as the
/// candidate winner. If it clears `overall_agreement` and the champions'
/// agreement is at least `champion_agreement`, we emit a decision.
pub fn consensus(
    decisions: &[AgentDecision],
    scoreboard: &Scoreboard,
    cfg: &ConsensusCfg,
) -> Option<ConsensusDecision> {
    if decisions.len() < cfg.min_agent_count {
        return None;
    }

    // Bucket by (asset, direction).
    let mut buckets: HashMap<(Asset, Direction), Vec<&AgentDecision>> = HashMap::new();
    for d in decisions {
        buckets.entry((d.asset, d.direction)).or_default().push(d);
    }
    let (&(asset, direction), group) = buckets
        .iter()
        .max_by_key(|(_, v)| v.len())?;
    let overall_agreement = group.len() as f64 / decisions.len() as f64;
    if overall_agreement < cfg.overall_agreement {
        return None;
    }

    // Who are the champions right now?
    let champions = scoreboard.top_n(cfg.top_k, cfg.min_decisions_for_champion);
    let champion_ids: Vec<String> = champions.iter().map(|c| c.agent_id.clone()).collect();

    // Count champions whose vote is in this group.
    let champ_in_group = group
        .iter()
        .filter(|d| champion_ids.contains(&d.agent_id))
        .count();
    let total_voting_champs = decisions
        .iter()
        .filter(|d| champion_ids.contains(&d.agent_id))
        .count();
    let champ_agreement = if total_voting_champs > 0 {
        champ_in_group as f64 / total_voting_champs as f64
    } else {
        // No champions voted (early in the run). Fall back to overall.
        overall_agreement
    };
    if champ_agreement < cfg.champion_agreement {
        return None;
    }

    let avg_conviction = group.iter().map(|d| f64::from(d.conviction)).sum::<f64>() / group.len() as f64;
    let avg_risk = group.iter().map(|d| d.risk_fraction).sum::<f64>() / group.len() as f64;
    let horizon_s = group
        .iter()
        .map(|d| d.horizon_s)
        .min()
        .unwrap_or(4 * 3600);
    let ts = group.iter().map(|d| d.ts.0).max().unwrap_or(0);

    Some(ConsensusDecision {
        ts: EventTs::from_secs(ts),
        asset,
        direction,
        agent_count: decisions.len(),
        champion_count: total_voting_champs,
        champion_agreement: champ_agreement,
        overall_agreement,
        champions: champion_ids,
        contributing_decisions: group.iter().map(|d| d.id.clone()).collect(),
        avg_conviction,
        avg_risk_fraction: avg_risk,
        horizon_s,
    })
}

/// Rank-weighted average across the top `top_k` agents' stats.
pub fn weighted_stats(stats: &[AgentStats]) -> Option<(f64, f64)> {
    if stats.is_empty() {
        return None;
    }
    let total_weight: f64 = stats.iter().enumerate().map(|(i, _)| 1.0 / (i as f64 + 1.0)).sum();
    if total_weight <= 0.0 {
        return None;
    }
    let win = stats
        .iter()
        .enumerate()
        .map(|(i, s)| s.win_rate / (i as f64 + 1.0))
        .sum::<f64>()
        / total_weight;
    let r = stats
        .iter()
        .enumerate()
        .map(|(i, s)| s.total_r / (i as f64 + 1.0))
        .sum::<f64>()
        / total_weight;
    Some((win, r))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::AgentDecision;

    fn mkd(id: &str, agent: &str, dir: Direction) -> AgentDecision {
        AgentDecision {
            id: id.into(),
            agent_id: agent.into(),
            ts: EventTs::from_secs(1),
            asset: Asset::Btc,
            direction: dir,
            conviction: 80,
            risk_fraction: 0.01,
            horizon_s: 4 * 3600,
            rationale: "t".into(),
        }
    }

    #[test]
    fn majority_long_emits_long() {
        let sb = Scoreboard::new();
        let decisions = vec![
            mkd("1", "a", Direction::Long),
            mkd("2", "b", Direction::Long),
            mkd("3", "c", Direction::Long),
            mkd("4", "d", Direction::Short),
        ];
        let c = consensus(&decisions, &sb, &ConsensusCfg::default()).unwrap();
        assert_eq!(c.direction, Direction::Long);
        assert_eq!(c.agent_count, 4);
    }

    #[test]
    fn split_fails() {
        let sb = Scoreboard::new();
        let decisions = vec![
            mkd("1", "a", Direction::Long),
            mkd("2", "b", Direction::Short),
        ];
        assert!(consensus(&decisions, &sb, &ConsensusCfg::default()).is_none());
    }

    #[test]
    fn insufficient_agents_fails() {
        let sb = Scoreboard::new();
        let decisions = vec![mkd("1", "a", Direction::Long)];
        assert!(consensus(&decisions, &sb, &ConsensusCfg::default()).is_none());
    }
}
