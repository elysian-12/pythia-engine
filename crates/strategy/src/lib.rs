//! Strategy registry + ablation runner.
//!
//! A `StrategyVariant` pairs a `SignalConfig` with a `TraderConfig`. The
//! registry enumerates well-defined variants so the ablation runner can
//! score them on the same dataset under identical cost assumptions.
//!
//! Ranking composite: `score = DSR · sign(expectancy)`. Runs below a
//! minimum number of trades are excluded from ranking (they cannot be
//! meaningfully evaluated).

#![deny(unused_must_use)]

pub mod registry;
pub mod runner;

pub use registry::{default_grid, StrategyVariant};
pub use runner::{AblationReport, AblationRow, run_ablation};
