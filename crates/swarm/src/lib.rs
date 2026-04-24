//! Agent-swarm trading framework (OASIS-for-markets).
//!
//! The idea borrowed from camel-ai/oasis: instead of a single
//! "engine" deciding what to trade, we stand up a population of
//! heterogeneous agents — each with its own strategy template, risk
//! appetite, horizon preference, and (optionally) awareness of what
//! other agents just did. They all see the same real-time event stream,
//! each forms an independent decision, and we rank them by realised
//! PnL. The **consensus of the top performers** becomes the live trade.
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
//!                Consensus.decide(decisions, top_k_champions)
//!                                         │
//!                                         ▼
//!                           Real-money execution
//! ```
//!
//! Design choices:
//!   * Agents are lightweight — no heap-allocated state beyond a small
//!     per-agent aggregator. A 50-agent swarm easily fits in a single
//!     tokio task loop.
//!   * Everything is trait-based, so LLM-backed agents are a drop-in
//!     later (`Box<dyn SwarmAgent>` already supports any type).
//!   * Agents can optionally see recent peer decisions, enabling
//!     momentum/contrarian meta-behaviours — the social-influence bit
//!     of the OASIS pattern.

#![deny(unused_must_use)]

pub mod agent;
pub mod consensus;
pub mod population;
pub mod scoring;
pub mod systematic;

pub use agent::{AgentDecision, AgentKind, AgentProfile, PeerView, SwarmAgent};
pub use consensus::{consensus, ConsensusCfg, ConsensusDecision};
pub use population::{Swarm, SwarmEvent};
pub use scoring::{AgentStats, Scoreboard};
pub use systematic::{SystematicAgent, SystematicBuilder};
