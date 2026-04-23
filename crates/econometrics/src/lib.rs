//! Econometrics layer — the alpha moat.
//!
//! Implements the statistical tests that gate signal firing:
//! - `cointegration_test` — Engle-Granger two-step (OLS residual ADF).
//! - `granger_f` — F-test that PM leads the crypto series on a VAR(p).
//! - `information_share_proxy` — variance-decomposition proxy of Hasbrouck IS.
//! - `gini` — concentration of skill-weighted PM positions.
//! - `zscore` — rolling z-score of a series.
//! - `lead_lag_peak` — lag k ∈ [1, max_lag] maximising cross-corr(y1[t-k], y2[t]).
//!
//! Hasbrouck (1995) requires a full VECM with Cholesky-ordered residual
//! covariance. The `information_share_proxy` here is the Granger-restricted
//! variance-decomposition share; identical ordering, simpler implementation.
//! All tests are pure functions with no I/O — testable in isolation.

#![deny(unused_must_use)]

pub mod basic;
pub mod coint;
pub mod granger;
pub mod info_share;

pub use basic::{gini, zscore, zscore_last, lead_lag_peak};
pub use coint::{cointegration_test, CointegrationResult};
pub use granger::{granger_f, GrangerResult};
pub use info_share::{information_share_proxy, InfoShare};

#[derive(Debug, thiserror::Error)]
pub enum EconError {
    #[error("insufficient data: need {need}, have {have}")]
    Insufficient { need: usize, have: usize },
    #[error("linear algebra: {0}")]
    LinAlg(String),
}
