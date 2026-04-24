//! Swarm orchestration — broadcast events, collect decisions.
//!
//! Sequential over agents (they're cheap — no network, no locks). A
//! 20-agent swarm processes ~200 µs per event on an M-series Mac,
//! dominated by the aggregator updates. For much larger swarms we'd
//! parallelise across threads; at current scale a single task is fine.

use std::collections::VecDeque;

use tracing::debug;

use crate::agent::{AgentDecision, Event, PeerView, SwarmAgent};

/// Convenience alias — an event-plus-wall-clock for logging.
#[derive(Debug, Clone)]
pub struct SwarmEvent {
    pub event: Event,
    /// Agents' decisions in response to this event.
    pub decisions: Vec<AgentDecision>,
}

/// The swarm.
pub struct Swarm {
    agents: Vec<Box<dyn SwarmAgent>>,
    /// Most recent peer decisions, oldest first. Sized to give agents a
    /// meaningful social window without unbounded growth.
    recent: VecDeque<AgentDecision>,
    recent_capacity: usize,
    /// Optional champion-id from the scoreboard — used to compute
    /// `champion_agreement` in the `PeerView`.
    pub current_champion: Option<String>,
}

impl std::fmt::Debug for Swarm {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Swarm")
            .field("n_agents", &self.agents.len())
            .field("recent_len", &self.recent.len())
            .field("champion", &self.current_champion)
            .finish_non_exhaustive()
    }
}

impl Swarm {
    pub fn new(agents: Vec<Box<dyn SwarmAgent>>) -> Self {
        Self {
            agents,
            recent: VecDeque::with_capacity(128),
            recent_capacity: 64,
            current_champion: None,
        }
    }

    pub fn n_agents(&self) -> usize {
        self.agents.len()
    }

    pub fn agents(&self) -> impl Iterator<Item = &dyn SwarmAgent> {
        self.agents.iter().map(|a| a.as_ref())
    }

    /// Broadcast one event, collect every agent's decision (if any).
    pub async fn broadcast(&mut self, event: &Event) -> Vec<AgentDecision> {
        let peers = self.compute_peer_view();
        let mut decisions = Vec::new();
        for agent in &mut self.agents {
            // Non-social agents never read `peers` — cheap to pass.
            if let Some(d) = agent.observe(event, &peers).await {
                decisions.push(d);
            }
        }
        // Remember what everyone just did.
        for d in &decisions {
            self.recent.push_back(d.clone());
        }
        while self.recent.len() > self.recent_capacity {
            self.recent.pop_front();
        }
        if !decisions.is_empty() {
            debug!(
                n_decisions = decisions.len(),
                n_total_recent = self.recent.len(),
                "swarm produced decisions"
            );
        }
        decisions
    }

    fn compute_peer_view(&self) -> PeerView {
        if self.recent.is_empty() {
            return PeerView::default();
        }
        let long_n = self
            .recent
            .iter()
            .filter(|d| matches!(d.direction, domain::signal::Direction::Long))
            .count();
        let total = self.recent.len() as f64;
        let long_fraction = long_n as f64 / total.max(1.0);

        let champion_agreement = if let Some(c) = &self.current_champion {
            let agree = self.recent.iter().filter(|d| d.agent_id == *c).count() as f64;
            agree / total.max(1.0)
        } else {
            0.0
        };

        PeerView {
            recent: self.recent.iter().cloned().collect(),
            long_fraction,
            champion_agreement,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::systematic::{SystematicAgent, SystematicParams};
    use domain::{
        crypto::{Asset, LiqSide},
        time::EventTs,
    };

    #[tokio::test]
    async fn broadcast_collects_decisions_from_all_agents() {
        let mut agents: Vec<Box<dyn SwarmAgent>> = vec![
            Box::new(SystematicAgent::new("a1", SystematicParams {
                z_threshold: 1.0,
                z_window: 10,
                cooldown_bars: 0,
                ..SystematicParams::liq_trend()
            })),
            Box::new(SystematicAgent::new("a2", SystematicParams {
                z_threshold: 1.0,
                z_window: 10,
                cooldown_bars: 0,
                ..SystematicParams::liq_fade()
            })),
        ];
        let _ = agents.len();
        let mut swarm = Swarm::new(agents);

        // Drive a spike then advance — both agents should fire but
        // opposite directions (one is trend, one is fade).
        let mut ts = 0i64;
        for _ in 0..15 {
            swarm
                .broadcast(&Event::Liquidation {
                    ts: EventTs::from_secs(ts),
                    asset: Asset::Btc,
                    side: LiqSide::Buy,
                    usd_value: 1_000.0,
                })
                .await;
            ts += 3600;
        }
        // spike
        swarm
            .broadcast(&Event::Liquidation {
                ts: EventTs::from_secs(ts),
                asset: Asset::Btc,
                side: LiqSide::Buy,
                usd_value: 80_000.0,
            })
            .await;
        ts += 3600;
        let decisions = swarm
            .broadcast(&Event::Liquidation {
                ts: EventTs::from_secs(ts),
                asset: Asset::Btc,
                side: LiqSide::Buy,
                usd_value: 100.0,
            })
            .await;
        assert_eq!(decisions.len(), 2);
        assert_ne!(decisions[0].direction, decisions[1].direction);
    }
}
