//! Swarm orchestration — broadcast events, collect decisions.
//!
//! `broadcast` runs every agent's `observe()` future *concurrently* on a
//! single tokio task via `futures::join_all`. Systematic agents finish
//! inline (microseconds) and LLM agents that hit the network overlap
//! their HTTP round-trips instead of serialising them — the difference
//! between a 250 ms event-to-trade cycle and a 50 ms one with five
//! simulated 50 ms agents (verified by the
//! `broadcast_runs_agents_concurrently` test).
//!
//! This is async concurrency, not OS-thread parallelism: a single
//! tokio task multiplexes the futures. CPU-only agents see no speed-up
//! over a serial loop; the whole point is overlapping network I/O,
//! which is the actual latency floor.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Instant;

use futures::future::join_all;
use tracing::debug;

use crate::agent::{AgentDecision, Event, PeerView, PolymarketHistory, SwarmAgent};
use crate::scoring::Scoreboard;

/// Cap on per-asset Polymarket history retained for the polyedge
/// econometric tests. ~2 weeks of hourly samples is plenty for
/// cointegration / Granger / Hasbrouck (each only consumes the last
/// `SystematicParams::z_window` samples), and growing unbounded would
/// leak memory across long-running daemon sessions.
const POLYMARKET_HISTORY_CAP: usize = 14 * 24;

/// Window length for the per-agent self-backtest gate. The orchestrator
/// reads `Scoreboard::recent_expectancy(agent_id, RECENT_N, MIN_SAMPLE)`
/// before each `observe()` call so agents can abstain when their own
/// recent E[R] turns negative.
const SELF_BACKTEST_WINDOW: usize = 30;
const SELF_BACKTEST_MIN_SAMPLE: usize = 10;

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
    /// Latest market regime, populated by the driver from a rolling
    /// candle buffer. None until enough candles are seen.
    pub current_regime: Option<regime::RegimeSnapshot>,
    /// Optional reference to the live scoreboard. When set, each agent's
    /// PeerView gets a `self_recent_expectancy` populated from its own
    /// closed-trade history — enabling the self-backtest gate. Left None
    /// in tests / scoreboard-less drivers; gating then no-ops.
    scoreboard: Option<Arc<Scoreboard>>,
    /// Rolling Polymarket SWP/mid pairs per asset. Updated on every
    /// `Event::Polymarket` and surfaced through `PeerView` so polyedge
    /// agents can run cointegration / Granger / Hasbrouck against a
    /// consistent series. Capped at `POLYMARKET_HISTORY_CAP` per asset.
    polymarket_history: PolymarketHistory,
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
            current_regime: None,
            scoreboard: None,
            polymarket_history: PolymarketHistory::default(),
        }
    }

    /// Replace the rolling Polymarket history wholesale — useful for
    /// resuming a daemon from a persisted snapshot or for tests that
    /// pre-load a fixture.
    pub fn set_polymarket_history(&mut self, h: PolymarketHistory) {
        self.polymarket_history = h;
    }

    /// Attach the live scoreboard. With this set, every `observe()` call
    /// receives a `PeerView::self_recent_expectancy` for the receiving
    /// agent — the input for the self-backtest gate.
    pub fn with_scoreboard(mut self, sb: Arc<Scoreboard>) -> Self {
        self.scoreboard = Some(sb);
        self
    }

    pub fn n_agents(&self) -> usize {
        self.agents.len()
    }

    pub fn agents(&self) -> impl Iterator<Item = &dyn SwarmAgent> {
        self.agents.iter().map(|a| a.as_ref())
    }

    /// Broadcast one event, collect every agent's decision (if any).
    pub async fn broadcast(&mut self, event: &Event) -> Vec<AgentDecision> {
        self.broadcast_timed(event).await.0
    }

    /// Same as `broadcast` but also returns elapsed wall-clock for the
    /// observe round (in microseconds). The live executor surfaces this
    /// to the UI so visitors can see the "<2 s event-to-trade" claim
    /// backed by a real number.
    pub async fn broadcast_timed(
        &mut self,
        event: &Event,
    ) -> (Vec<AgentDecision>, u128) {
        let started = Instant::now();
        // Stash any Polymarket sample into the rolling per-asset buffer
        // *before* computing the peer view, so the polyedge agent's
        // econometric gates see this tick when they run their tests.
        if let Event::Polymarket { ts, asset, swp, mid } = event {
            let bucket = match asset {
                domain::crypto::Asset::Btc => &mut self.polymarket_history.btc,
                domain::crypto::Asset::Eth => &mut self.polymarket_history.eth,
            };
            bucket.push((ts.0, *swp, *mid));
            // Capped FIFO — drop the oldest entries when the buffer
            // exceeds POLYMARKET_HISTORY_CAP so a long-lived daemon
            // doesn't accumulate unbounded memory.
            let overflow = bucket.len().saturating_sub(POLYMARKET_HISTORY_CAP);
            if overflow > 0 {
                bucket.drain(..overflow);
            }
        }

        // Pre-build per-agent peer views into a Vec so the futures below
        // each own their own peer view (no shared-borrow conflict). One
        // PeerView clone per agent is cheap — a few dozen recent
        // decisions + scalars.
        let peers_base = self.compute_peer_view();
        let peers_per_agent: Vec<PeerView> = self
            .agents
            .iter()
            .map(|a| {
                let mut p = peers_base.clone();
                if let Some(sb) = &self.scoreboard {
                    p.self_recent_expectancy = sb.recent_expectancy(
                        a.id(),
                        SELF_BACKTEST_WINDOW,
                        SELF_BACKTEST_MIN_SAMPLE,
                    );
                }
                p
            })
            .collect();

        // Concurrent observation: each agent's observe() future is polled
        // in the same tokio task with `join_all`. CPU-only systematic
        // agents finish inline (microseconds); network-bound LLM agents
        // overlap their HTTP calls instead of serialising them, which is
        // the actual latency bottleneck. Borrow-checker is happy because
        // `iter_mut` produces disjoint &mut to each Box<dyn SwarmAgent>
        // and each future captures its own &mut.
        let futures = self
            .agents
            .iter_mut()
            .zip(peers_per_agent.iter())
            .map(|(agent, peers)| async move { agent.observe(event, peers).await });
        let raw: Vec<Option<AgentDecision>> = join_all(futures).await;
        let decisions: Vec<AgentDecision> = raw.into_iter().flatten().collect();

        // Remember what everyone just did.
        for d in &decisions {
            self.recent.push_back(d.clone());
        }
        while self.recent.len() > self.recent_capacity {
            self.recent.pop_front();
        }
        let elapsed_us = started.elapsed().as_micros();
        if !decisions.is_empty() {
            debug!(
                n_decisions = decisions.len(),
                n_total_recent = self.recent.len(),
                elapsed_us,
                "swarm produced decisions"
            );
        }
        (decisions, elapsed_us)
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
            regime: self.current_regime,
            // Per-agent self_recent_expectancy is layered in by `broadcast`
            // before each `observe` call.
            self_recent_expectancy: None,
            // Cloning the polymarket history is bounded by
            // POLYMARKET_HISTORY_CAP — at most ~336 (asset, swp, mid)
            // tuples at hourly resolution, well under 10 KB.
            polymarket_history: if self.polymarket_history.btc.is_empty()
                && self.polymarket_history.eth.is_empty()
            {
                None
            } else {
                Some(self.polymarket_history.clone())
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{AgentDecision, AgentKind, AgentProfile, Event, PeerView, SwarmAgent};
    use crate::systematic::{SystematicAgent, SystematicParams};
    use async_trait::async_trait;
    use domain::{
        crypto::{Asset, LiqSide},
        time::EventTs,
    };

    /// Simulates a slow agent (e.g. an LLM doing a network call). We use
    /// it to prove broadcast actually runs agents concurrently — if the
    /// loop were sequential, N slow agents would multiply, not overlap.
    struct SlowAgent {
        id: String,
        delay: std::time::Duration,
        profile: AgentProfile,
    }

    #[async_trait]
    impl SwarmAgent for SlowAgent {
        fn id(&self) -> &str {
            &self.id
        }
        fn profile(&self) -> &AgentProfile {
            &self.profile
        }
        async fn observe(
            &mut self,
            _event: &Event,
            _peers: &PeerView,
        ) -> Option<AgentDecision> {
            tokio::time::sleep(self.delay).await;
            None
        }
    }

    #[tokio::test]
    async fn broadcast_runs_agents_concurrently() {
        // Five agents that each "wait" 50 ms. If the loop were sequential
        // the total would be ≥ 250 ms; with join_all it should be ~50 ms
        // plus tiny overhead. We assert < 150 ms which leaves ample slack
        // for slow CI without re-introducing serial latency.
        let mk = |i: usize| -> Box<dyn SwarmAgent> {
            Box::new(SlowAgent {
                id: format!("slow-{i}"),
                delay: std::time::Duration::from_millis(50),
                profile: AgentProfile {
                    kind: AgentKind::Systematic,
                    risk_fraction: 0.005,
                    horizon_s: 3600,
                    personality: None,
                    social: false,
                },
            })
        };
        let agents: Vec<Box<dyn SwarmAgent>> = (0..5).map(mk).collect();
        let mut swarm = Swarm::new(agents);
        let started = std::time::Instant::now();
        let _ = swarm
            .broadcast(&Event::Liquidation {
                ts: EventTs::from_secs(0),
                asset: Asset::Btc,
                side: LiqSide::Buy,
                usd_value: 1.0,
            })
            .await;
        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_millis(150),
            "broadcast was sequential — took {elapsed:?}, expected ≈ 50 ms",
        );
    }

    #[tokio::test]
    async fn broadcast_scales_constant_with_agent_count() {
        // Stronger guarantee: doubling the agent count from 5 to 25
        // should NOT roughly double the wall-clock. With concurrent
        // futures, both sizes finish in ~delay + epsilon. With a serial
        // loop, 25 agents would take 5× as long as 5.
        async fn cycle_ms(n: usize, delay_ms: u64) -> u128 {
            let mk = |i: usize| -> Box<dyn SwarmAgent> {
                Box::new(SlowAgent {
                    id: format!("slow-{i}"),
                    delay: std::time::Duration::from_millis(delay_ms),
                    profile: AgentProfile {
                        kind: AgentKind::Systematic,
                        risk_fraction: 0.005,
                        horizon_s: 3600,
                        personality: None,
                        social: false,
                    },
                })
            };
            let agents: Vec<Box<dyn SwarmAgent>> = (0..n).map(mk).collect();
            let mut swarm = Swarm::new(agents);
            let started = std::time::Instant::now();
            let _ = swarm
                .broadcast(&Event::Liquidation {
                    ts: EventTs::from_secs(0),
                    asset: Asset::Btc,
                    side: LiqSide::Buy,
                    usd_value: 1.0,
                })
                .await;
            started.elapsed().as_millis()
        }

        let small = cycle_ms(5, 50).await;
        let big = cycle_ms(25, 50).await;

        // Concurrent: big ≈ small (both ~50 ms). We allow big to be up
        // to 2× small to absorb tokio scheduling jitter on shared CI.
        // A serial implementation would be 5× small here.
        assert!(
            big < (small * 2).max(120),
            "broadcast didn't scale concurrently — 5 agents: {small} ms, 25 agents: {big} ms (serial would be ~5×)",
        );
    }

    #[tokio::test]
    async fn broadcast_timed_returns_realistic_elapsed() {
        // The broadcast_timed return value should match wall-clock for
        // a slow agent. Anything > delay × 2 indicates we're polling
        // futures sequentially or holding locks.
        let agents: Vec<Box<dyn SwarmAgent>> = (0..3)
            .map(|i| -> Box<dyn SwarmAgent> {
                Box::new(SlowAgent {
                    id: format!("t-{i}"),
                    delay: std::time::Duration::from_millis(40),
                    profile: AgentProfile {
                        kind: AgentKind::Systematic,
                        risk_fraction: 0.005,
                        horizon_s: 3600,
                        personality: None,
                        social: false,
                    },
                })
            })
            .collect();
        let mut swarm = Swarm::new(agents);
        let (_, elapsed_us) = swarm
            .broadcast_timed(&Event::Liquidation {
                ts: EventTs::from_secs(0),
                asset: Asset::Btc,
                side: LiqSide::Buy,
                usd_value: 1.0,
            })
            .await;
        // 40 ms ≤ elapsed_us ≤ 100 ms (scheduler overhead). Serial
        // would be ≥ 120 ms.
        let ms = elapsed_us / 1000;
        assert!(
            (35..=110).contains(&ms),
            "elapsed_us out of expected concurrent band: {ms} ms (expected ~40 ms)",
        );
    }

    #[tokio::test]
    async fn broadcast_collects_decisions_from_all_agents() {
        let agents: Vec<Box<dyn SwarmAgent>> = vec![
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
