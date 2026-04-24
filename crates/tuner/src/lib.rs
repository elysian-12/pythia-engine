//! Bounded-autonomy AI tuner.
//!
//! Offline loop that runs every 6 h (or manually) and:
//!   1. Reads recent strategy stats from the store.
//!   2. Runs a **statistical gate** — only invokes the LLM when a real
//!      signal is present (Sharpe drop, regime change, parameter drift).
//!   3. Calls Anthropic via tool-use for structured JSON output within
//!      declared bounds.
//!   4. Writes a proposal file with 1 h TTL; another process applies
//!      accepted proposals atomically.
//!   5. Auto-rollback: if a proposal hurts realised Sharpe over the
//!      next 30 trades, the change is reverted and the rollback
//!      reason logged.
//!
//! **Never** talks to the exchange. **Never** rewrites Rust code.
//! **Never** creates new strategies. Strictly adjusts parameters of
//! already-deployed strategies within pre-declared ranges.

#![deny(unused_must_use)]

pub mod bounds;
pub mod gate;
pub mod llm;
pub mod proposal;

pub use bounds::{Bounds, ParamBounds};
pub use gate::{gate, GateDecision, GateStats};
pub use llm::{AnthropicClient, LlmClient, MockLlm, Proposal, ReviewContext};
pub use proposal::{ProposalQueue, QueuedProposal};
