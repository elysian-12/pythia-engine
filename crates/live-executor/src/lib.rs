//! Live executor for the `liq-trend` strategy.
//!
//! Architecture (fan-out, single-writer pattern — no shared-state locks in
//! the hot path):
//!
//! ```text
//!              mpsc::Receiver<LiveEvent>
//!  Kiyotaka WS ───────────────────────────▶ Aggregator task
//!                                                │
//!                                                │ mpsc::Sender<Signal>
//!                                                ▼
//!                                          Executor task ──▶ Hyperliquid REST
//! ```
//!
//! Each task owns its state; inter-task communication is through bounded
//! channels. This keeps the WS → order latency predictable (typically
//! <200 ms end-to-end, dominated by HL REST round-trip).

#![deny(unused_must_use)]

pub mod aggregator;
pub mod engine;
pub mod risk;
pub mod state;

pub use aggregator::{Aggregator, AggregatorSnapshot};
pub use engine::{run_executor, ExecutorCfg, LiveMode};
pub use risk::{RiskGuard, RiskCfg};
pub use state::{LiveState, StatePath};
