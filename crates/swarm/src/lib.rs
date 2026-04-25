//! Agent-swarm trading framework.
//!
//! Instead of a single "engine" deciding what to trade, we stand up a
//! population of heterogeneous agents — each with its own strategy
//! template, risk appetite, horizon preference, and (optionally)
//! awareness of what other agents just did. They all see the same
//! real-time event stream, each forms an independent decision, and we
//! rank them by realised PnL. The **scoreboard picks the champion**,
//! and the **champion's strategy drives the live executor**.
//!
//! Flow:
//!
//! ```text
//!   Kiyotaka / Binance event
//!           │
//!           ▼
//!     Swarm::broadcast(event)  ───▶  Agent₁  ─┐
//!                              ───▶  Agent₂   ├─▶ Vec<AgentDecision>
//!                              ───▶  ...      │
//!                              ───▶  Agent_N ─┘
//!                                         │
//!                                         ▼
//!                            Scoreboard.record(decisions)
//!                                         │  ≤ 4 h later, when
//!                                         │  outcome is known
//!                                         ▼
//!                      Scoreboard.mark_outcome(decision_id, pnl)
//!                                         │
//!                                         ▼
//!                       Scoreboard.champion() → agent_id
//!                                         │
//!                                         ▼
//!              champion's next AgentDecision  ──▶ Executor
//! ```
//!
//! Design choices:
//!   * Agents are lightweight — no heap-allocated state beyond a small
//!     per-agent aggregator. A 50-agent swarm easily fits in a single
//!     tokio task loop.
//!   * Everything is trait-based, so LLM-backed agents are a drop-in
//!     later (`Box<dyn SwarmAgent>` already supports any type).
//!   * Agents can optionally see recent peer decisions, enabling
//!     momentum/contrarian meta-behaviours — the social-influence layer.
//!   * `consensus()` remains available as a diagnostic / alternative
//!     firing rule, but the default live path is **champion-driven**.

#![deny(unused_must_use)]

pub mod agent;
pub mod consensus;
pub mod evolution;
pub mod llm_agent;
pub mod persistence;
pub mod population;
pub mod scoring;
pub mod systematic;

pub use agent::{AgentDecision, AgentKind, AgentProfile, PeerView, SwarmAgent};
pub use consensus::{consensus, ConsensusCfg, ConsensusDecision};
pub use evolution::{Evolution, EvolutionCfg};
pub use llm_agent::{
    AnthropicDecider, LlmAction, LlmAgent, LlmDecider, LlmDecision, MockLlmDecider, Personality,
};
pub use persistence::{PersistedAgent, PersistedPopulation};
pub use population::{Swarm, SwarmEvent};
pub use scoring::{AgentStats, Scoreboard};
pub use systematic::{SystematicAgent, SystematicBuilder, SystematicParams};
