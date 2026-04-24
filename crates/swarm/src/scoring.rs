//! Per-agent scoreboard.
//!
//! Tracks every decision, matches it to a subsequent market outcome,
//! and produces rolling per-agent metrics. Used to pick the
//! **champion** and to compute consensus.

use std::collections::HashMap;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::agent::AgentDecision;

/// Metrics per agent, rolled up since swarm start.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AgentStats {
    pub agent_id: String,
    pub total_decisions: usize,
    pub wins: usize,
    pub losses: usize,
    pub total_r: f64,
    pub total_pnl_usd: f64,
    pub rolling_sharpe: f64,
    pub win_rate: f64,
    pub last_r: f64,
    pub active: bool,
}

#[derive(Debug)]
pub struct Scoreboard {
    inner: Mutex<Inner>,
}

#[derive(Debug, Default)]
struct Inner {
    stats: HashMap<String, AgentStats>,
    pending: HashMap<String, (AgentDecision, Vec<f64>)>,
}

impl Default for Scoreboard {
    fn default() -> Self {
        Self::new()
    }
}

impl Scoreboard {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
        }
    }

    /// Open a pending decision. Must be followed by `mark_outcome` or
    /// `cancel` to be counted.
    pub fn record(&self, d: AgentDecision) {
        let mut g = self.inner.lock();
        let s = g.stats.entry(d.agent_id.clone()).or_insert_with(|| AgentStats {
            agent_id: d.agent_id.clone(),
            active: true,
            ..Default::default()
        });
        s.total_decisions += 1;
        g.pending.insert(d.id.clone(), (d, Vec::new()));
    }

    /// Mark a decision as closed with a realised R-multiple + PnL.
    pub fn mark_outcome(&self, decision_id: &str, r_multiple: f64, pnl_usd: f64) {
        let mut g = self.inner.lock();
        let Some((d, _returns)) = g.pending.remove(decision_id) else {
            return;
        };
        let s = g.stats.entry(d.agent_id.clone()).or_default();
        if s.agent_id.is_empty() {
            s.agent_id.clone_from(&d.agent_id);
        }
        s.last_r = r_multiple;
        s.total_r += r_multiple;
        s.total_pnl_usd += pnl_usd;
        if r_multiple > 0.0 {
            s.wins += 1;
        } else if r_multiple < 0.0 {
            s.losses += 1;
        }
        let decided = s.wins + s.losses;
        s.win_rate = if decided > 0 {
            s.wins as f64 / decided as f64
        } else {
            0.0
        };
        // Rolling Sharpe is the sample-ratio on realised R-multiples.
        let decisions = s.wins + s.losses;
        if decisions > 1 {
            s.rolling_sharpe = {
                // We don't store the full distribution; approximate via the
                // expectancy / sqrt(variance-proxy). Good enough for ranking.
                let mean = s.total_r / decisions as f64;
                let proxy_sd = (1.0 + mean.abs()).max(0.5);
                mean / proxy_sd
            };
        }
    }

    pub fn stats(&self, agent_id: &str) -> Option<AgentStats> {
        self.inner.lock().stats.get(agent_id).cloned()
    }

    pub fn all(&self) -> Vec<AgentStats> {
        self.inner.lock().stats.values().cloned().collect()
    }

    /// Top N agents by total R-multiple, breaking ties by win rate.
    pub fn top_n(&self, n: usize, min_decisions: usize) -> Vec<AgentStats> {
        let mut all = self.all();
        all.retain(|s| s.wins + s.losses >= min_decisions);
        all.sort_by(|a, b| {
            b.total_r
                .partial_cmp(&a.total_r)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    b.win_rate
                        .partial_cmp(&a.win_rate)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        });
        all.truncate(n);
        all
    }

    /// The best single agent — whoever has the highest total R with
    /// at least `min_decisions` closed trades.
    pub fn champion(&self, min_decisions: usize) -> Option<AgentStats> {
        self.top_n(1, min_decisions).into_iter().next()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::AgentDecision;
    use domain::{crypto::Asset, signal::Direction, time::EventTs};

    fn mkd(id: &str, agent: &str) -> AgentDecision {
        AgentDecision {
            id: id.into(),
            agent_id: agent.into(),
            ts: EventTs::from_secs(0),
            asset: Asset::Btc,
            direction: Direction::Long,
            conviction: 80,
            risk_fraction: 0.01,
            horizon_s: 3600,
            rationale: "t".into(),
        }
    }

    #[test]
    fn champion_by_total_r() {
        let s = Scoreboard::new();
        s.record(mkd("d1", "a"));
        s.record(mkd("d2", "a"));
        s.record(mkd("d3", "b"));
        s.mark_outcome("d1", 2.0, 100.0);
        s.mark_outcome("d2", 1.5, 80.0);
        s.mark_outcome("d3", 3.0, 150.0);
        let c = s.champion(1).unwrap();
        assert_eq!(c.agent_id, "a"); // 2.0 + 1.5 = 3.5 vs 3.0
    }

    #[test]
    fn top_n_filters_low_decision_count() {
        let s = Scoreboard::new();
        s.record(mkd("d1", "a"));
        s.record(mkd("d2", "b"));
        s.record(mkd("d3", "b"));
        s.mark_outcome("d1", 5.0, 500.0);
        s.mark_outcome("d2", 1.0, 100.0);
        s.mark_outcome("d3", 1.0, 100.0);
        let top = s.top_n(5, 2);
        assert_eq!(top.len(), 1);
        assert_eq!(top[0].agent_id, "b");
    }
}
