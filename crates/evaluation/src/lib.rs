//! Quant-grade evaluation metrics.
//!
//! Implements publishable-quality performance metrics that go beyond Sharpe:
//!
//! - **Probabilistic Sharpe Ratio (PSR)** — Bailey & López de Prado (2012).
//!   Probability that the observed Sharpe exceeds a benchmark given sample
//!   size, skew, and kurtosis of the return series.
//! - **Deflated Sharpe Ratio (DSR)** — Bailey & López de Prado (2014).
//!   Corrects PSR for multiple testing bias when selecting the best-of-N
//!   strategies from a trial set.
//! - **Stationary block bootstrap** — resampling-based confidence intervals
//!   on Sharpe / profit factor / expectancy that preserve autocorrelation.
//! - **Probability of Backtest Overfitting (PBO)** — combinatorial
//!   cross-validation (López de Prado 2014) to detect overfit strategies.
//! - **Drawdown duration** — time-to-recovery in bars.
//! - **Timing** — per-phase latency collector for the runtime report.
//!
//! All functions are pure and deterministic. The bootstrap uses a seeded
//! PRNG so replays are reproducible.

#![deny(unused_must_use)]

pub mod bootstrap;
pub mod dsr;
pub mod pbo;
pub mod timing;

pub use bootstrap::{block_bootstrap_sharpe, Ci};
pub use dsr::{deflated_sharpe_ratio, probabilistic_sharpe_ratio, PsrResult};
pub use pbo::{probability_of_backtest_overfitting, PboResult};
pub use timing::{LatencyCollector, LatencyReport, PhaseTiming};
