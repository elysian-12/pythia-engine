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
///
/// All risk-adjusted metrics are computed from the agent's per-trade R
/// stream. We store running moments (sum, sum-of-squares, gross win/loss,
/// peak-to-trough drawdown) instead of the full history so memory stays
/// O(1) per agent across hundreds of generations.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AgentStats {
    pub agent_id: String,
    pub total_decisions: usize,
    pub wins: usize,
    pub losses: usize,
    pub total_r: f64,
    pub total_pnl_usd: f64,
    /// Sharpe ratio of per-trade R, sample-stdev based.
    pub rolling_sharpe: f64,
    pub win_rate: f64,
    pub last_r: f64,
    pub active: bool,
    /// Σ R for winning trades only — numerator of profit factor.
    #[serde(default)]
    pub gross_win_r: f64,
    /// Σ |R| for losing trades only — denominator of profit factor.
    #[serde(default)]
    pub gross_loss_r: f64,
    /// Average R per trade (total_r / total_closed). Van Tharp's expectancy.
    #[serde(default)]
    pub expectancy_r: f64,
    /// Profit factor = gross_win_r / gross_loss_r. >1 means net profitable.
    #[serde(default)]
    pub profit_factor: f64,
    /// Worst peak-to-trough drawdown of cumulative R, in R units.
    #[serde(default)]
    pub max_drawdown_r: f64,
    /// Cumulative-R high-water mark seen so far. Internal — used to
    /// compute the running drawdown without iterating history.
    #[serde(default)]
    pub peak_cum_r: f64,
    /// Sum of per-trade R^2 — the second moment used for the Sharpe stdev.
    #[serde(default)]
    pub sum_r_squared: f64,
    /// Sortino-style downside deviation accumulator (Σ min(R,0)^2).
    #[serde(default)]
    pub sum_downside_r_squared: f64,
}

#[derive(Debug)]
pub struct Scoreboard {
    inner: Mutex<Inner>,
}

#[derive(Debug, Default)]
struct Inner {
    stats: HashMap<String, AgentStats>,
    pending: HashMap<String, (AgentDecision, Vec<f64>)>,
    /// Last `R_HISTORY_CAP` realised R values per agent — used by the
    /// evaluation crate (DSR/PSR/block-bootstrap CI). Capped to keep
    /// memory bounded across hundreds of evolved generations.
    r_history: HashMap<String, std::collections::VecDeque<f64>>,
}

const R_HISTORY_CAP: usize = 2_000;

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
    /// Updates all running risk metrics in O(1) — no per-trade history kept.
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
        s.sum_r_squared += r_multiple * r_multiple;
        if r_multiple > 0.0 {
            s.wins += 1;
            s.gross_win_r += r_multiple;
        } else if r_multiple < 0.0 {
            s.losses += 1;
            s.gross_loss_r += -r_multiple;
            s.sum_downside_r_squared += r_multiple * r_multiple;
        }

        let decided = s.wins + s.losses;
        s.win_rate = if decided > 0 {
            s.wins as f64 / decided as f64
        } else {
            0.0
        };
        s.expectancy_r = if decided > 0 {
            s.total_r / decided as f64
        } else {
            0.0
        };
        s.profit_factor = if s.gross_loss_r > 1e-9 {
            s.gross_win_r / s.gross_loss_r
        } else if s.gross_win_r > 0.0 {
            f64::INFINITY
        } else {
            0.0
        };

        // Cumulative-R drawdown: track running peak, take max of (peak - current).
        if s.total_r > s.peak_cum_r {
            s.peak_cum_r = s.total_r;
        }
        let dd = s.peak_cum_r - s.total_r;
        if dd > s.max_drawdown_r {
            s.max_drawdown_r = dd;
        }

        // Sharpe over per-trade R: mean / sample-stdev. Proper formula.
        if decided > 1 {
            let n = decided as f64;
            let mean = s.total_r / n;
            let var = (s.sum_r_squared - n * mean * mean).max(0.0) / (n - 1.0);
            let sd = var.sqrt().max(1e-9);
            s.rolling_sharpe = mean / sd;
        }

        // Capture the R series for the evaluation crate's significance tests.
        let aid = d.agent_id.clone();
        let buf = g.r_history.entry(aid).or_default();
        buf.push_back(r_multiple);
        while buf.len() > R_HISTORY_CAP {
            buf.pop_front();
        }
    }

    /// Per-trade R history for an agent — used by `evaluation` for
    /// PSR / DSR / block-bootstrap CI on Sharpe. Returns up to the last
    /// `R_HISTORY_CAP` realised R values (oldest first).
    pub fn r_history(&self, agent_id: &str) -> Vec<f64> {
        self.inner
            .lock()
            .r_history
            .get(agent_id)
            .map(|d| d.iter().copied().collect())
            .unwrap_or_default()
    }

    pub fn stats(&self, agent_id: &str) -> Option<AgentStats> {
        self.inner.lock().stats.get(agent_id).cloned()
    }

    /// Pre-populate the scoreboard with a prior run's stats. Used when
    /// resuming from a persisted population so the new run does not start
    /// every agent at zero — evolution gets selection signal immediately
    /// instead of having to re-discover the elite from scratch.
    pub fn seed(&self, agent_id: String, mut stats: AgentStats) {
        let mut g = self.inner.lock();
        stats.agent_id = agent_id.clone();
        stats.active = true;
        g.stats.insert(agent_id, stats);
    }

    /// Seed an agent's per-trade R history from a persisted run so the
    /// evaluation crate's significance tests have a sample population
    /// from event 1 (otherwise PSR/DSR see only the new run's trades).
    pub fn seed_r_history(&self, agent_id: String, history: Vec<f64>) {
        let mut g = self.inner.lock();
        let buf: std::collections::VecDeque<f64> = history.into_iter().collect();
        g.r_history.insert(agent_id, buf);
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
